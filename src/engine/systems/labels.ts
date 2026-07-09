// src/engine/systems/labels.ts — §8.3 building labels (LOD + repaint budget).
//
// One Sprite per building. Full 4-line texture (256×176): line1 ticker (bold
// 44px, white), line2 price (30px, green), line3 signed changePct (30px —
// bright green up / bright red down), line4 market cap (26px, white) + SIM
// badge when source==='simulated'. A cached ticker-only texture (pre-render
// once per instrument, ticker white) is used as a fast first-paint placeholder
// while the full 4-line texture regenerates within the budget. Sprite anchored
// above the cube at y = hCurrent + 4.
//
// Color semantics: ticker white, price green, changePct red↔green, mcap white.
// Price/changePct keep their red/green direction semantics; only the ticker
// and the new market-cap line are white.
//
// LOD by camera distance, evaluated ~4×/s (NOT per frame):
//   Always visible (full 4-line label at any distance). The hide tier (≥160u
//   hidden) was removed per Admiral request so every label draws at full
//   distance — there is no `mode=2` hide tier anymore.
// Texture regen budget: ≤8 canvases/frame, nearest-first; the lazy first-paint
// (cached ticker texture → full upgrade) still applies on entering view.
//
// Reads heights via `engine.api.buildings`. Quotes mark labels dirty through
// `engine.api.labels.markDirty(quotes)`. The per-frame repaint count is
// exposed via `engine.api.labels.repaints` for the `` ` `` debug overlay.

import * as THREE from 'three';
import type { EngineSystem, EngineContext } from '../core';
import type { Quote } from '../../net/protocol';
import { formatPrice, formatChangePct, formatMarketCap } from '../../utils/format';
import { useMarketStore } from '../../stores/market';

const CW = 256;
const CH = 176; // grew 128→176 to fit the 4th market-cap line
const LOD_INTERVAL_S = 0.25;
const REPAINT_BUDGET_PER_FRAME = 8;
// +20% width (I2 sprite 12×6 → 14.4 wide; +20% stays). Sprite height tracks
// the canvas aspect (CH/CW = 176/256) so the taller 4-line canvas maps 1:1.
const SPRITE_W = 14.4;
const SPRITE_H = 14.4 * (CH / CW); // = 9.9
const Y_OFFSET = 4;

interface LabelItem {
  id: string;
  ticker: string;
  mcapUSD: number | undefined;
  sprite: THREE.Sprite;
  fullTexture: THREE.CanvasTexture | null;
  fullDirty: boolean;
  tickerTexture: THREE.CanvasTexture | null;
  lod: 0 | 2; // 0 full 4-line (visible) | 2 hidden — ticker-only tier removed
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
  // line 1 — ticker (bold 44px) — white
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 44px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(item.ticker, 12, 6);
  const q = item.lastQuote;
  if (!q) return;
  // §8.3 stale styling: dim green for stale (mono CRT — greyer green).
  const stale = q.stale === true;
  // line 2 — price (dim phosphor green; stale → darker dim green)
  ctx.fillStyle = stale ? '#2e6b3e' : '#4dff66';
  ctx.font = '30px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(formatPrice(q.price), 12, 62);
  // line 3 — signed change: bright green up / bright red down (stale → dim green).
  // Matches the buildings' red↔green semantic (COLOR_RED / COLOR_GREEN).
  ctx.fillStyle = stale ? '#2e6b3e' : (q.changePct >= 0 ? '#4dff66' : '#ff4540');
  ctx.fillText(formatChangePct(q.changePct), 12, 100);
  // line 4 — market cap (26px, white — a value, not a direction). Returns '—'
  // for null/undefined mcap, the right fallback.
  ctx.fillStyle = '#ffffff';
  ctx.font = '26px sans-serif';
  ctx.fillText(formatMarketCap(item.mcapUSD), 12, 136);
  // stale badge (mirrors the SIM badge slot) — dim green on the mono CRT.
  if (stale) {
    ctx.fillStyle = '#2e6b3e';
    ctx.font = '700 22px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('stale', CW - 10, 10);
  }
  // SIM badge (stale badge, if rendered above, already used the right-aligned
  // slot; when both apply, SIM wins back the slot — it's the dominant signal).
  // mid phosphor green accent so SIM still pops.
  if (q.source === 'simulated' && !stale) {
    ctx.fillStyle = '#2eff7a';
    ctx.font = '700 22px sans-serif';
    const w = ctx.measureText('SIM').width;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('SIM', CW - 10, 10);
    void w;
  }
}

function drawTicker(c: HTMLCanvasElement, ticker: string): void {
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, CW, CH);
  ctx.fillStyle = '#ffffff';
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
        mcapUSD: inst.mcapUSD,
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
    // Always visible — no hide tier. (`lod` stays typed `0 | 2` but is never
    // assigned 2; the lazy first-paint + nearest-first repaint budget handle
    // the now-always-eligible set of 117 labels.)
    const mode = 0;
    if (mode === it.lod) continue; // no change
    it.lod = mode;
    // mode 0 — full 4-line. Show an existing non-stale full texture
    // immediately; otherwise drop in the cached ticker-only texture as a
    // fast first-paint placeholder and queue a full repaint (nearest-first,
    // ≤8/frame) that upgrades it to 4-line detail.
    if (it.fullTexture && !it.fullDirty) {
      it.sprite.material.map = it.fullTexture;
      it.sprite.material.needsUpdate = true;
    } else {
      if (!it.sprite.material.map) {
        it.sprite.material.map = ensureTicker(it);
        it.sprite.material.needsUpdate = true;
      }
      it.fullDirty = true;
    }
    it.sprite.visible = true;
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