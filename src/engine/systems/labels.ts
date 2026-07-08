// src/engine/systems/labels.ts — §8.3 building labels (LOD + repaint budget).
//
// One Sprite per building. Full 3-line texture (256×128): line1 ticker (bold
// 44px), line2 price (30px), line3 signed changePct (30px green/red) + SIM
// badge when source==='simulated'. A cached ticker-only texture (pre-render
// once per instrument) serves the mid-range band. Sprite anchored above the
// cube at y = hCurrent + 4.
//
// LOD by camera distance, evaluated ~4×/s (NOT per frame):
//   <60u  full 3-line; 60–160u cached ticker-only; >160u hidden.
// Texture regen budget: ≤8 canvases/frame, nearest-first; never repaint
// invisible labels (repaint lazily when re-entering range).
//
// Reads heights via `engine.api.buildings`. Quotes mark labels dirty through
// `engine.api.labels.markDirty(quotes)`. The per-frame repaint count is
// exposed via `engine.api.labels.repaints` for the `` ` `` debug overlay.

import * as THREE from 'three';
import type { EngineSystem, EngineContext } from '../core';
import type { Quote } from '../../net/protocol';
import { formatPrice, formatChangePct } from '../../utils/format';
import { useMarketStore } from '../../stores/market';

const CW = 256;
const CH = 128;
const LOD_FULL = 60;
const LOD_TICKER = 160;
const LOD_INTERVAL_S = 0.25;
const REPAINT_BUDGET_PER_FRAME = 8;
const SPRITE_W = 12;
const SPRITE_H = 6;
const Y_OFFSET = 4;

interface LabelItem {
  id: string;
  ticker: string;
  sprite: THREE.Sprite;
  fullTexture: THREE.CanvasTexture | null;
  fullDirty: boolean;
  tickerTexture: THREE.CanvasTexture | null;
  lod: 0 | 1 | 2; // 0 full | 1 ticker | 2 hidden
  distSq: number;
  lastQuote: Quote | null;
}

let group: THREE.Group | null = null;
let sceneRef: THREE.Scene | null = null;
const items: LabelItem[] = [];
const camPos = new THREE.Vector3();
const itemPos = new THREE.Vector3();
let lodAccum = 0;
export interface LabelsApi {
  repaints: number;
  markDirty(delta: Quote[]): void;
}

let repaintsThisFrame = 0;
let apiLabels: LabelsApi | null = null;

function newCanvasCtx(): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = CW;
  c.height = CH;
  return c.getContext('2d')!;
}

function drawFull(c: HTMLCanvasElement, item: LabelItem): void {
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, CW, CH);
  // line 1 — ticker (bold 44px)
  ctx.fillStyle = '#e6edf3';
  ctx.font = '700 44px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(item.ticker, 12, 6);
  const q = item.lastQuote;
  if (!q) return;
  // line 2 — price
  ctx.fillStyle = '#9fb2c6';
  ctx.font = '30px sans-serif';
  ctx.fillText(formatPrice(q.price), 12, 56);
  // line 3 — signed change (green/red)
  ctx.fillStyle = q.changePct >= 0 ? '#22c07a' : '#d64550';
  ctx.fillText(formatChangePct(q.changePct), 12, 92);
  // SIM badge
  if (q.source === 'simulated') {
    ctx.fillStyle = '#4aa8ff';
    ctx.font = '700 22px sans-serif';
    const w = ctx.measureText('SIM').width;
    ctx.textAlign = 'right';
    ctx.fillText('SIM', CW - 10, 10);
    void w;
  }
}

function drawTicker(c: HTMLCanvasElement, ticker: string): void {
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, CW, CH);
  ctx.fillStyle = '#cdd9e5';
  ctx.font = '700 48px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ticker, CW / 2, CH / 2);
}

export const labelsSystem: EngineSystem = {
  setup(ctx: EngineContext) {
    sceneRef = ctx.scene;
    const buildings = ctx.engine.api.buildings as import('./buildings').BuildingsApi | undefined;
    if (!buildings) return;
    const layout = buildings.getLayoutMap();
    const market = useMarketStore();
    const manifest = market.manifest;
    group = new THREE.Group();
    group.name = 'labels';
    items.length = 0;
    for (const inst of manifest) {
      const L = layout.get(inst.id);
      if (!L) continue;
      const mat = new THREE.SpriteMaterial({
        transparent: true,
        depthWrite: false,
        sizeAttenuation: true,
      });
      const sp = new THREE.Sprite(mat);
      sp.scale.set(SPRITE_W, SPRITE_H, 1);
      sp.position.set(L.x, Y_OFFSET, L.z);
      sp.visible = false;
      group.add(sp);
      items.push({
        id: inst.id,
        ticker: inst.ticker,
        sprite: sp,
        fullTexture: null,
        fullDirty: false,
        tickerTexture: null,
        lod: 2,
        distSq: Infinity,
        lastQuote: null,
      });
    }
    ctx.scene.add(group);
    apiLabels = { repaints: 0, markDirty };
    ctx.engine.api.labels = apiLabels;
  },

  update(dt: number, ctx: EngineContext) {
    if (!group) return;
    const buildings = ctx.engine.api.buildings as import('./buildings').BuildingsApi | undefined;
    if (!buildings) return;
    repaintsThisFrame = 0;

    camPos.copy(ctx.camera.position);
    lodAccum += dt;
    if (lodAccum >= LOD_INTERVAL_S) {
      lodAccum = 0;
      evaluateLOD(buildings);
    }

    // Repaint nearest-first within budget.
    const queue = items
      .filter((it) => it.fullDirty && it.lod === 0 && it.lastQuote)
      .sort((a, b) => a.distSq - b.distSq);
    const budget = Math.min(REPAINT_BUDGET_PER_FRAME, queue.length);
    for (let i = 0; i < budget; i++) {
      repaintFullAt(queue[i]);
      repaintsThisFrame++;
    }

    // Snap sprite y to hCurrent+4 when buildings are animating (cheap; idle-skip otherwise).
    if (buildings.animating()) {
      for (const it of items) {
        if (it.lod === 2) continue;
        it.sprite.position.y = buildings.getHeight(it.id) + Y_OFFSET;
      }
    }
    if (apiLabels) apiLabels.repaints = repaintsThisFrame;
  },

  dispose(_ctx: EngineContext) {
    if (group && sceneRef) sceneRef.remove(group);
    for (const it of items) {
      it.fullTexture?.dispose();
      it.tickerTexture?.dispose();
      (it.sprite.material as THREE.SpriteMaterial).dispose();
    }
    items.length = 0;
    group = null;
    sceneRef = null;
    apiLabels = null;
  },
};

function evaluateLOD(buildings: import('./buildings').BuildingsApi): void {
  for (const it of items) {
    const L = buildings.getLayout(it.id);
    if (!L) continue;
    itemPos.set(L.x, 0, L.z);
    const dist = camPos.distanceTo(itemPos);
    it.distSq = dist * dist;
    let mode: 0 | 1 | 2;
    if (dist < LOD_FULL) mode = 0;
    else if (dist < LOD_TICKER) mode = 1;
    else mode = 2;
    if (mode === it.lod) continue; // no change
    it.lod = mode;
    if (mode === 2) {
      it.sprite.visible = false;
    } else if (mode === 1) {
      const tex = ensureTicker(it);
      it.sprite.material.map = tex;
      it.sprite.material.needsUpdate = true;
      it.sprite.visible = true;
    } else {
      // mode 0 — full. Assign an existing non-stale full texture immediately;
      // otherwise queue a repaint (nearest-first, budgeted per frame).
      if (it.fullTexture && !it.fullDirty) {
        it.sprite.material.map = it.fullTexture;
        it.sprite.material.needsUpdate = true;
      } else {
        it.fullDirty = true;
      }
      it.sprite.visible = true;
    }
  }
}

function ensureTicker(item: LabelItem): THREE.CanvasTexture {
  if (item.tickerTexture) return item.tickerTexture;
  const ctx = newCanvasCtx();
  drawTicker(ctx.canvas, item.ticker);
  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  item.tickerTexture = tex;
  return tex;
}

function repaintFullAt(item: LabelItem): void {
  // Reuse an existing canvas/texture if present (in-place regen); else create.
  let tex = item.fullTexture;
  let canvas: HTMLCanvasElement;
  if (tex) {
    canvas = (tex.image as HTMLCanvasElement);
    drawFull(canvas, item);
    tex.needsUpdate = true;
  } else {
    const ctx = newCanvasCtx();
    drawFull(ctx.canvas, item);
    tex = new THREE.CanvasTexture(ctx.canvas);
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    item.fullTexture = tex;
    canvas = ctx.canvas;
  }
  void canvas;
  item.fullDirty = false;
  // Only assign if we're still in the full band.
  if (item.lod === 0) {
    item.sprite.material.map = tex;
    item.sprite.material.needsUpdate = true;
  }
}

/** Bridge entry: mark labels for the changed ids dirty (complains about none). */
function markDirty(delta: Quote[]): void {
  for (const q of delta) {
    const it = items.find((x) => x.id === q.id);
    if (!it) continue;
    it.lastQuote = q;
    it.fullDirty = true;
  }
}

export default labelsSystem;
export { markDirty };