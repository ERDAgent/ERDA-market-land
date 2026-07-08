/**
 * Full §9 fly controls: pointer lock (click), Esc releases, drag-to-look
 * fallback for touch, WASD on camera basis, Space/C world up/down, Shift sprint
 * x3, scroll wheel base-speed 10–120 (default 30), delta-time damped movement
 * (accel 40 u/s^2, friction 8/s), world clamps (y in [1.5,400], horiz <= 700
 * soft push-back), spawn (0,80,260) facing origin.
 *
 * Built-in engine system (core registers it directly; NOT a dropped
 * `./systems/*.ts` file). `isInputFocused()` enforces §9: key handlers no-op
 * while any input/textarea is focused.
 */
import * as THREE from 'three';
import type { EngineSystem, EngineContext } from './core';

const LOOK_SENSITIVITY = 0.0022;
const MAX_PITCH = Math.PI / 2 - 0.05;
const FRICTION = 8; // /s —— exponential damping rate (§9 "damped, friction 8/s")
const ACCEL = 40; // u/s² (§9) — caps how fast velocity approaches the target
const Y_MIN = 1.5;
const Y_MAX = 400;
const HORIZ_MAX = 700;
const SPAWN = new THREE.Vector3(0, 80, 260);

export function isInputFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}

export interface FlyControlsApi {
  readonly baseSpeed: number;
  setBaseSpeed(v: number): void;
}

export function createFlyControls(
  camera: THREE.PerspectiveCamera,
  dom: HTMLElement,
  ctxApi: { speedHud: { speed: number; until: number } },
): EngineSystem & { api: FlyControlsApi } {
  const keys: Record<string, boolean> = Object.create(null);
  let yaw = 0;
  let pitch = 0;
  let baseSpeed = 30;
  let sprinting = false;
  let locked = false;

  // Stuck-key guard: any focus/visibility/lock transition that could swallow a
  // `keyup` (alt-tab, pointer-lock release, tab switch) snap-clears the input
  // state so a held descend/ascend/move can no longer run away.
  const clearKeys = (): void => {
    for (const k in keys) delete keys[k];
    sprinting = false;
  };

  // Persistent scratch (allocated ONCE here, reused every frame — no per-frame alloc).
  const velocity = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const stepDelta = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const applyRotation = (): void => {
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isInputFocused()) return;
    keys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') sprinting = true;
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (!(e.code in keys)) return;
    keys[e.code] = false;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') sprinting = false;
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (!locked) return;
    yaw -= e.movementX * LOOK_SENSITIVITY;
    pitch -= e.movementY * LOOK_SENSITIVITY;
    if (pitch > MAX_PITCH) pitch = MAX_PITCH;
    if (pitch < -MAX_PITCH) pitch = -MAX_PITCH;
    applyRotation();
  };

  // Fallback for environments with no pointer lock (iOS/touch): drag-to-look.
  // Desktop mouse-look goes through the locked `onMouseMove` path instead.
  const onPointerDrag = (e: PointerEvent): void => {
    if (locked) return;
    if (e.pointerType !== 'touch') return;
    if (!(e.buttons & 1)) return;
    yaw -= e.movementX * LOOK_SENSITIVITY;
    pitch -= e.movementY * LOOK_SENSITIVITY;
    if (pitch > MAX_PITCH) pitch = MAX_PITCH;
    if (pitch < -MAX_PITCH) pitch = -MAX_PITCH;
    applyRotation();
  };

  const onWheel = (e: WheelEvent): void => {
    if (isInputFocused()) return;
    e.preventDefault();
    baseSpeed -= Math.sign(e.deltaY) * 4;
    if (baseSpeed < 10) baseSpeed = 10;
    if (baseSpeed > 120) baseSpeed = 120;
    ctxApi.speedHud.speed = baseSpeed;
    ctxApi.speedHud.until = performance.now() + 1100;
  };

  const onClick = (): void => {
    if (locked) return;
    const p = dom.requestPointerLock();
    if (p && typeof (p as Promise<void>).catch === 'function') {
      (p as Promise<void>).catch(() => {
        /* user dismissed the prompt, or UA blocked — fine */
      });
    }
  };

  const onLockChange = (): void => {
    locked = document.pointerLockElement === dom;
    if (!locked) clearKeys();
  };

  const onBlur = (): void => clearKeys();

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') clearKeys();
  };

  const onContextMenu = (e: Event): void => e.preventDefault();

  const api: FlyControlsApi = {
    get baseSpeed() {
      return baseSpeed;
    },
    setBaseSpeed(v: number) {
      baseSpeed = v;
    },
  };

  return {
    api,
    setup(_ctx: EngineContext) {
      camera.rotation.order = 'YXZ';
      camera.position.copy(SPAWN);
      camera.lookAt(0, 0, 0);
      yaw = camera.rotation.y;
      pitch = camera.rotation.x;
      applyRotation();
      velocity.set(0, 0, 0);
      sprinting = false;
      locked = false;
      for (const k in keys) delete keys[k];

      window.addEventListener('keydown', onKeyDown, { passive: false });
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('mousemove', onMouseMove);
      dom.addEventListener('wheel', onWheel, { passive: false });
      dom.addEventListener('click', onClick);
      dom.addEventListener('pointermove', onPointerDrag);
      dom.addEventListener('contextmenu', onContextMenu);
      document.addEventListener('pointerlockchange', onLockChange);
      window.addEventListener('blur', onBlur);
      document.addEventListener('visibilitychange', onVisibilityChange);
    },
    update(dt: number, _ctx: EngineContext) {
      const speed = sprinting ? baseSpeed * 3 : baseSpeed;
      let f = 0;
      let r = 0;
      let u = 0;
      if (keys['KeyW']) f += 1;
      if (keys['KeyS']) f -= 1;
      if (keys['KeyD']) r += 1;
      if (keys['KeyA']) r -= 1;
      if (keys['Space']) u += 1;
      if (keys['KeyC']) u -= 1;

      desired.set(0, 0, 0);
      if (f !== 0 || r !== 0) {
        forward.set(0, 0, -1).applyEuler(camera.rotation);
        right.set(1, 0, 0).applyEuler(camera.rotation);
        desired.addScaledVector(forward, f).addScaledVector(right, r);
      }
      if (u !== 0) desired.addScaledVector(up, u);
      if (desired.lengthSq() > 0) desired.normalize();
      desired.multiplyScalar(speed);

      // Damped approach: steer velocity toward target, capped at ACCEL u/s²,
      // plus an exponential friction decay toward 0 when there's no input.
      const decay = Math.exp(-FRICTION * dt);
      velocity.multiplyScalar(decay);
      stepDelta.copy(desired).sub(velocity);
      const stepLen = stepDelta.length();
      if (stepLen > 0) {
        const maxStep = ACCEL * dt;
        const k = stepLen > maxStep ? maxStep / stepLen : 1;
        stepDelta.multiplyScalar(k);
        velocity.add(stepDelta);
      }
      camera.position.addScaledVector(velocity, dt);

      // Y clamp (hard).
      if (camera.position.y < Y_MIN) {
        camera.position.y = Y_MIN;
        if (velocity.y < 0) velocity.y = 0;
      } else if (camera.position.y > Y_MAX) {
        camera.position.y = Y_MAX;
        if (velocity.y > 0) velocity.y = 0;
      }

      // Horizontal soft push-back inside radius 700.
      const horiz = Math.hypot(camera.position.x, camera.position.z);
      if (horiz > HORIZ_MAX) {
        const scale = HORIZ_MAX / horiz;
        const t = 1 - Math.exp(-4 * dt); // gentle return
        camera.position.x += camera.position.x * scale * t - camera.position.x * t;
        camera.position.z += camera.position.z * scale * t - camera.position.z * t;
      }
    },
    dispose(_ctx: EngineContext) {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      dom.removeEventListener('wheel', onWheel);
      dom.removeEventListener('click', onClick);
      dom.removeEventListener('pointermove', onPointerDrag);
      dom.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('pointerlockchange', onLockChange);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (document.pointerLockElement === dom) document.exitPointerLock();
    },
  };
}