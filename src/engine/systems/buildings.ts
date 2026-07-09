// src/engine/systems/buildings.ts — §8.2 InstancedMesh city + §7.3 height/color.
//
// One `InstancedMesh(unitBox, MeshBasicMaterial, 117)` for ALL cubes. The
// unit box is translated +0.5 in Y (origin at base) so `scaleY = h` grows from
// the ground. Per-instance arrays: positions, footprints, hCurrent (animated),
// hStart + tween progress (0.6s ease-out), base color. Heights come from
// `config/metrics.ts` (mode 1/2/3); colors always day-change. Hover swaps toward
// bright phosphor green 15% (§8.4 emissive highlight stand-in — CRT green-phosphor).
//
// Reads the frozen manifest + layout + the market store (manifest/quotes/metric).
// The bridge triggers `refresh()` on quote/metric watch. Exposes
// `engine.api.buildings` so labels/picking/flyTo share index maps + heights
// without re-importing the store. Disposes geometry/material/textures on teardown.

import * as THREE from 'three';
import type { EngineSystem, EngineContext } from '../core';
import { layoutCity, type BuildingLayout } from '../layout';
import { useMarketStore } from '../../stores/market';
import {
  heightForMetric,
  dayChangeColor,
  H_MIN,
  type HeightMetric,
} from '../../config/metrics';
import { buildDistricts } from '../districts';
import { scratch } from '../scratch';

const TWEEN_SECS = 0.6;
// Hover blend factor (unchanged) + white target — hover pops toward white
// (neutral highlight on red/green buildings).
const HOVER_WHITEN = 0.15;
const HOVER_R = 1.0;
const HOVER_G = 1.0;
const HOVER_B = 1.0;

export interface BuildingsApi {
  mesh: THREE.InstancedMesh;
  count: number;
  getIdByIndex(i: number): string | undefined;
  getIndexById(id: string): number | undefined;
  getLayout(id: string): BuildingLayout | undefined;
  getHeight(id: string): number;
  getLayoutMap(): Map<string, BuildingLayout>;
  /** Re-read the market store + update height targets + colors for changed quotes. */
  refresh(): void;
  /** Force a full recalc of all height targets (metric change). */
  applyMetric(metric: HeightMetric): void;
  /** Highlight blend the given instance toward white (hover), or restore. */
  setHover(idx: number | null): void;
  /** True when any building mid-tween (labels read this to skip work). */
  animating(): boolean;
}

let mesh: THREE.InstancedMesh | null = null;
let districts: { dispose(): void } | null = null;
const idByIndex: string[] = [];
const indexById = new Map<string, number>();
const layoutMap = new Map<string, BuildingLayout>();
const xPos: number[] = [];
const zPos: number[] = [];
const footprint: number[] = [];
const hCurrent: number[] = [];
const hTarget: number[] = [];
const hStart: number[] = [];
const tweenP: number[] = [];
// base per-instance color (r,g,b floats) — used + whitened on hover.
const baseColor: Float32Array = new Float32Array(0);
let colorBuf: Float32Array | null = null;
let anyTween = false;
let hoveredIdx: number | null = null;

// Scratch (allocated ONCE; reused every frame — no per-frame alloc).
const pos = new THREE.Vector3();
const scl = new THREE.Vector3();
const idQuat = new THREE.Quaternion();
const colScratch = new THREE.Color();

export const buildingsSystem: EngineSystem = {
  setup(ctx: EngineContext) {
    const market = useMarketStore();
    const manifest = market.manifest;
    const N = manifest.length;
    if (N === 0) return;

    layoutMap.clear();
    idByIndex.length = 0;
    indexById.clear();
    xPos.length = 0;
    zPos.length = 0;
    footprint.length = 0;
    hCurrent.length = 0;
    hTarget.length = 0;
    hStart.length = 0;
    tweenP.length = 0;

    // Layout (deterministic) — assign one instance index per instrument.
    const lay = layoutCity(manifest);
    let i = 0;
    // Use stable iteration order: manifest order.
    for (const inst of manifest) {
      const L = lay.get(inst.id);
      if (!L) continue;
      idByIndex.push(inst.id);
      indexById.set(inst.id, i);
      layoutMap.set(inst.id, L);
      xPos.push(L.x);
      zPos.push(L.z);
      footprint.push(L.footprint);
      hCurrent.push(H_MIN);
      hTarget.push(H_MIN);
      hStart.push(H_MIN);
      tweenP.push(1);
      i++;
    }
    const count = i;

    // Unit box translated +0.5 (origin at base).
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.name = 'buildings';
    mesh.frustumCulled = false;
    colorBuf = new Float32Array(count * 3);

    // Initial matrices + colors (neutral).
    for (let k = 0; k < count; k++) {
      pos.set(xPos[k], 0, zPos[k]);
      scl.set(footprint[k], hCurrent[k], footprint[k]);
      scratchCompose(mesh, k, pos, scl, idQuat);
      const c = dayChangeColor(0);
      colScratch.setRGB(c[0], c[1], c[2]);
      mesh.setColorAt(k, colScratch);
      colorBuf[k * 3] = c[0];
      colorBuf[k * 3 + 1] = c[1];
      colorBuf[k * 3 + 2] = c[2];
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    ctx.scene.add(mesh);

    // Index instruments by id for the refresh path.
    instById.clear();
    for (const inst of manifest) instById.set(inst.id, inst);

    // District slabs + name sprites.
    districts?.dispose();
    districts = buildDistricts(ctx.scene);

    // Seed heights from any quotes already in the store.
    refresh(market);

    ctx.engine.api.buildings = makeApi();
  },

  update(dt: number, _ctx: EngineContext) {
    if (!mesh) return;
    const n = idByIndex.length;
    let moved = false;
    anyTween = false;
    for (let k = 0; k < n; k++) {
      if (tweenP[k] < 1) {
        tweenP[k] = Math.min(1, tweenP[k] + dt / TWEEN_SECS);
        const t = tweenP[k];
        const e = 1 - (1 - t) * (1 - t); // ease-out
        hCurrent[k] = hStart[k] + (hTarget[k] - hStart[k]) * e;
        if (t < 1) anyTween = true;
        moved = true;
        pos.set(xPos[k], 0, zPos[k]);
        scl.set(footprint[k], hCurrent[k], footprint[k]);
        scratchCompose(mesh, k, pos, scl, idQuat);
      }
    }
    if (moved) mesh.instanceMatrix.needsUpdate = true;
  },

  dispose(_ctx: EngineContext) {
    districts?.dispose();
    districts = null;
    if (mesh) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
      _ctx.scene.remove(mesh);
      mesh = null;
    }
    colorBuf = null;
    hoveredIdx = null;
    anyTween = false;
  },
};

function scratchCompose(
  m: THREE.InstancedMesh,
  i: number,
  p: THREE.Vector3,
  s: THREE.Vector3,
  q: THREE.Quaternion,
): void {
  const mat = scratch.m4;
  mat.compose(p, q, s);
  m.setMatrixAt(i, mat);
}

const instById = new Map<string, import('../../net/protocol').Instrument>();

function refresh(market: ReturnType<typeof useMarketStore>): void {
  if (!mesh) return;
  const metric = market.metric as HeightMetric;
  const qs = market.quotes as Map<string, import('../../net/protocol').Quote>;
  let touched = false;
  for (let k = 0; k < idByIndex.length; k++) {
    const id = idByIndex[k];
    const q = qs.get(id);
    if (!q) continue;
    const inst = instById.get(id);
    const h = heightForMetric(metric, q.changePct, inst?.mcapUSD, q.price);
    setTarget(k, h);
    // §5.3 market-closed styling: dim color saturation ×0.6 when the session
    // is closed so the closed-market skyline reads visibly muted vs. live.
    let rgb = dayChangeColor(q.changePct);
    if (q.session === 'closed') rgb = dimSaturation(rgb, 0.6);
    writeColor(k, rgb);
    touched = true;
  }
  if (touched) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

function setTarget(k: number, h: number): void {
  if (Math.abs(hTarget[k] - h) < 1e-4) return;
  hStart[k] = hCurrent[k];
  hTarget[k] = h;
  tweenP[k] = 0;
}

/** Write a base color to the buffer + mesh (respecting current hover). */
function writeColor(k: number, rgb: [number, number, number]): void {
  if (!colorBuf || !mesh) return;
  colorBuf[k * 3] = rgb[0];
  colorBuf[k * 3 + 1] = rgb[1];
  colorBuf[k * 3 + 2] = rgb[2];
  if (hoveredIdx === k) {
    // hover pops toward white (neutral highlight on red/green buildings).
    colScratch.setRGB(
      lerp(rgb[0], HOVER_R, HOVER_WHITEN),
      lerp(rgb[1], HOVER_G, HOVER_WHITEN),
      lerp(rgb[2], HOVER_B, HOVER_WHITEN),
    );
  } else {
    colScratch.setRGB(rgb[0], rgb[1], rgb[2]);
  }
  mesh.setColorAt(k, colScratch);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const _hsl = { h: 0, s: 0, l: 0 };
const _dimColor = new THREE.Color();
/** Scale an [r,g,b] triple's saturation by `factor` (1 ⇒ unchanged, 0 ⇒ grey). */
function dimSaturation(rgb: [number, number, number], factor: number): [number, number, number] {
  _dimColor.setRGB(rgb[0], rgb[1], rgb[2]);
  _dimColor.getHSL(_hsl);
  _dimColor.setHSL(_hsl.h, _hsl.s * factor, _hsl.l);
  return [_dimColor.r, _dimColor.g, _dimColor.b];
}

function makeApi(): BuildingsApi {
  const api: BuildingsApi = {
    get mesh() {
      return mesh!;
    },
    get count() {
      return idByIndex.length;
    },
    getIdByIndex(i: number) {
      return idByIndex[i];
    },
    getIndexById(id: string) {
      return indexById.get(id);
    },
    getLayout(id: string) {
      return layoutMap.get(id);
    },
    getLayoutMap() {
      return layoutMap;
    },
    getHeight(id: string) {
      const i = indexById.get(id);
      return i == null ? H_MIN : hCurrent[i];
    },
    refresh() {
      refresh(useMarketStore());
    },
    applyMetric(metric: HeightMetric) {
      const market = useMarketStore();
      market.setMetric(metric);
      refresh(market);
    },
    setHover(idx: number | null) {
      if (!mesh || hoveredIdx === idx) {
        hoveredIdx = idx;
        return;
      }
      // restore previous
      if (hoveredIdx != null && colorBuf) {
        colScratch.setRGB(
          colorBuf[hoveredIdx * 3],
          colorBuf[hoveredIdx * 3 + 1],
          colorBuf[hoveredIdx * 3 + 2],
        );
        mesh.setColorAt(hoveredIdx, colScratch);
      }
      hoveredIdx = idx;
      if (idx != null && colorBuf) {
        colScratch.setRGB(
          lerp(colorBuf[idx * 3], HOVER_R, HOVER_WHITEN),
          lerp(colorBuf[idx * 3 + 1], HOVER_G, HOVER_WHITEN),
          lerp(colorBuf[idx * 3 + 2], HOVER_B, HOVER_WHITEN),
        );
        mesh.setColorAt(idx, colScratch);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
    animating() {
      return anyTween;
    },
  };
  return api;
}

export default buildingsSystem;