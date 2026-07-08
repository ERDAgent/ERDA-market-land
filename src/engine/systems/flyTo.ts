// src/engine/systems/flyTo.ts — §8.4 camera fly-to selected building.
//
// `engine.api.flyTo.go(id)` tweens the camera over 1.2s to a point offset from
// the building (distance = 3× its current height, 30° elevation) along the
// camera's current azimuth toward the building, easing in/out (smoothstep). On
// arrival the camera looks at the building. User input (any movement key, wheel,
// or pointer-lock mouse-look) cancels the tween.
//
// The InfoPanel "Fly to" button and the `F` key both go through `engine.api.flyTo`.

import * as THREE from 'three';
import type { EngineSystem, EngineContext } from '../core';
import { isInputFocused } from '../flyControls';
import type { BuildingsApi } from './buildings';

export interface FlyToApi {
  go(id: string | null): void;
  cancel(): void;
  isActive(): boolean;
}

const DURATION = 1.2; // s
const ELEV = (30 * Math.PI) / 180;

let active = false;
let t = 0;
let startPos = new THREE.Vector3();
let targetPos = new THREE.Vector3();
let lookAt = new THREE.Vector3();
let ctx: EngineContext | null = null;
const scratchFrom = new THREE.Vector3();
const scratchDir = new THREE.Vector3();

const movementKeys = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC', 'ShiftLeft', 'ShiftRight',
]);

function onKeyDown(e: KeyboardEvent): void {
  if (isInputFocused()) return;
  if (movementKeys.has(e.code)) {
    cancel();
  }
}

function onWheel(): void {
  cancel();
}

function onPointerLockMove(): void {
  if (document.pointerLockElement && active) cancel();
}

function cancel(): void {
  if (active) active = false;
}

export const flyToSystem: EngineSystem = {
  setup(_ctx: EngineContext) {
    ctx = _ctx;
    window.addEventListener('keydown', onKeyDown);
    _ctx.renderer.domElement.addEventListener('wheel', onWheel);
    document.addEventListener('mousemove', onPointerLockMove);
    _ctx.engine.api.flyTo = {
      go(id: string | null) {
        go(id);
      },
      cancel,
      isActive() {
        return active;
      },
    } satisfies FlyToApi;
  },
  update(dt: number, _ctx: EngineContext) {
    if (!active) return;
    t += dt / DURATION;
    if (t >= 1) {
      active = false;
      t = 1;
    }
    const s = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // smoothstep
    _ctx.camera.position.lerpVectors(startPos, targetPos, s);
    _ctx.camera.lookAt(lookAt);
    // Also clear the camera rotation euler parse: lookAt writes quaternion; keep.
    if (!active) t = 0;
  },
  dispose(_ctx: EngineContext) {
    window.removeEventListener('keydown', onKeyDown);
    _ctx.renderer.domElement.removeEventListener('wheel', onWheel);
    document.removeEventListener('mousemove', onPointerLockMove);
    active = false;
    ctx = null;
  },
};

function go(id: string | null): void {
  if (!ctx) return;
  if (!id) return;
  const buildings = ctx.engine.api.buildings as BuildingsApi | undefined;
  if (!buildings) return;
  const L = buildings.getLayout(id);
  if (!L) return;
  const h = Math.max(buildings.getHeight(id), 2);
  const dist = Math.max(3 * h, 6); // never closer than 6 u
  // Azimuth: preserve the camera's current horizontal direction toward building.
  scratchFrom.set(ctx.camera.position.x, 0, ctx.camera.position.z);
  scratchDir.set(L.x - scratchFrom.x, 0, L.z - scratchFrom.z);
  const dirLen = scratchDir.length();
  if (dirLen < 1e-3) {
    scratchDir.set(0, 0, 1);
  } else {
    scratchDir.multiplyScalar(1 / dirLen);
  }
  const horiz = dist * Math.cos(ELEV);
  targetPos.set(
    L.x + scratchDir.x * horiz,
    L.z * 0 + dist * Math.sin(ELEV) + 1.5, // y = elevation lift, min 1.5 above ground
    L.z + scratchDir.z * horiz,
  );
  startPos.copy(ctx.camera.position);
  lookAt.set(L.x, h * 0.5, L.z);
  t = 0;
  active = true;
}

export default flyToSystem;