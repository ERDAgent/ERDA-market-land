// src/engine/systems/picking.ts — §8.4 raycast pick + hover highlight.
//
// Raycaster against the buildings `InstancedMesh`:
//   click/tap (when pointer NOT locked) → intersection.instanceId → instrument
//   id → `engine.events.emit('pick', {id})` (no hit ⇒ pick null, clears focus).
//   hover (pointermove, throttled 10 Hz) → subtle emissive highlight by
//   blending the hovered instance color toward white 15% via
//   `engine.api.buildings.setHover(idx)`.
//
// Pointer-locked clicks are owned by fly-controls (mouse-look); picking only
// fires in the unlocked state so the same click that locks also selects a
// building if one is under the cursor.

import * as THREE from 'three';
import type { EngineSystem, EngineContext } from '../core';
import type { BuildingsApi } from './buildings';

const HOVER_HZ = 10;
const HOVER_INTERVAL_MS = 1000 / HOVER_HZ;

let dom: HTMLElement | null = null;
let raycaster: THREE.Raycaster | null = null;
const ndc = new THREE.Vector2();
let lastHover = 0;
let hoveredIdx: number | null = null;

function onPointerDown(e: PointerEvent): void {
  // Only pick when unlocked (so we don't fight fly-controls mouse-look).
  if (document.pointerLockElement === dom) return;
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  pickAt(e.clientX, e.clientY);
}

function onPointerMove(e: PointerEvent): void {
  if (document.pointerLockElement === dom) return;
  const now = performance.now();
  if (now - lastHover < HOVER_INTERVAL_MS) return;
  lastHover = now;
  hoverAt(e.clientX, e.clientY);
}

function setNDC(cx: number, cy: number): boolean {
  if (!dom) return false;
  const r = dom.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  ndc.x = ((cx - r.left) / r.width) * 2 - 1;
  ndc.y = -((cy - r.top) / r.height) * 2 + 1;
  return true;
}

function pickAt(cx: number, cy: number): void {
  const ctx = currentCtx;
  if (!ctx || !raycaster) return;
  const buildings = ctx.engine.api.buildings as BuildingsApi | undefined;
  if (!buildings) return;
  if (!setNDC(cx, cy)) return;
  raycaster.setFromCamera(ndc, ctx.camera);
  const hit = raycaster.intersectObject(buildings.mesh, false)[0];
  if (hit && hit.instanceId != null) {
    const id = buildings.getIdByIndex(hit.instanceId);
    ctx.events.emit('pick', { id: id ?? null });
  } else {
    ctx.events.emit('pick', { id: null });
  }
}

function hoverAt(cx: number, cy: number): void {
  const ctx = currentCtx;
  if (!ctx || !raycaster) return;
  const buildings = ctx.engine.api.buildings as BuildingsApi | undefined;
  if (!buildings) return;
  if (!setNDC(cx, cy)) return;
  raycaster.setFromCamera(ndc, ctx.camera);
  const hit = raycaster.intersectObject(buildings.mesh, false)[0];
  if (hit && hit.instanceId != null) {
    if (hoveredIdx !== hit.instanceId) {
      hoveredIdx = hit.instanceId;
      buildings.setHover(hoveredIdx);
    }
  } else {
    if (hoveredIdx !== null) {
      hoveredIdx = null;
      buildings.setHover(null);
    }
  }
}

let currentCtx: EngineContext | null = null;

export const pickingSystem: EngineSystem = {
  setup(ctx: EngineContext) {
    currentCtx = ctx;
    dom = ctx.renderer.domElement;
    raycaster = new THREE.Raycaster();
    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointermove', onPointerMove);
  },
  update() {
    // no per-frame work (event-driven)
  },
  dispose(_ctx: EngineContext) {
    dom?.removeEventListener('pointerdown', onPointerDown);
    dom?.removeEventListener('pointermove', onPointerMove);
    if (hoveredIdx !== null) {
      (_ctx.engine.api.buildings as BuildingsApi | undefined)?.setHover?.(null);
    }
    hoveredIdx = null;
    currentCtx = null;
    dom = null;
    raycaster = null;
  },
};

export default pickingSystem;