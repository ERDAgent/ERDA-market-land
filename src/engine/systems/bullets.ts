// src/engine/systems/bullets.ts — BULLET1: Enter fires a cosmetic bullet.
//
// Purely cosmetic "for fun" action — no health/damage/score/respawn anywhere
// in this file. On Enter (outside any focused input — `isInputFocused()`,
// same guard `flyControls.ts`/`useHotkeys.ts` already use), this system:
//   1. Builds a ray from the camera's current position/forward direction and
//      hit-tests it (pure `raycastHit`, no THREE dependency) against every
//      other avatar's current position (`avatars.ts`'s `listTargets()`).
//   2. Renders a green-phosphor tracer + plays a synthesized "fire" blip
//      IMMEDIATELY, with zero dependency on the network round-trip.
//   3. On a hit: flashes the target avatar (`avatars.ts`'s `flashHit()`) and
//      layers in a "hit" blip.
//   4. Role-routes the shot onto the wire (guest→`guestSendShoot`,
//      host/solo→`hostSendShoot`) so every other peer renders + hears it too.
// The `'remoteShoot'` subscription (shots fired by OTHER peers, relayed via
// net/host.ts + net/guest.ts's `emitRemoteShoot`) is re-armed every `setup()`,
// mirroring avatars.ts's own `'remotePos'` re-arm discipline.
//
// Self-registers via core.ts's eager `./systems/*.ts` glob — core.ts is never
// edited.

import * as THREE from 'three';
import type { EngineSystem, EngineContext, Engine } from '../core';
import type { EngineEvents } from '../emitter';
import { isInputFocused } from '../flyControls';
import { useConnectionStore } from '../../stores/connection';
import { hostSendShoot } from '../../net/host';
import { guestSendShoot } from '../../net/guest';
import type { AvatarsApi } from './avatars';

// ---------------------------------------------------------------------------
// Pure hit-math — no THREE dependency (plain {x,y,z}-shaped vectors) so it's
// unit-testable under this repo's node-environment vitest setup with no
// jsdom/WebGL (tests/bullets.spec.ts).
// ---------------------------------------------------------------------------

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface HitTarget {
  id: string;
  position: Vec3Like;
}

export interface RayHit {
  id: string;
  /** Distance along `dir` from `origin` to the closest point on the ray to
   *  the target's center — used as the tracer's hit point. */
  distance: number;
}

/** Hit-test radius around a target's position (world units). */
export const HIT_RADIUS = 9;
/** Max shot range (world units); a miss's tracer flies exactly this far. */
export const MAX_RANGE = 400;

/**
 * Ray-vs-point-with-radius hit test. `dir` MUST be a unit vector. A target is
 * a hit when its perpendicular distance from the ray is within `radius`, it
 * projects to a positive distance along `dir` (in front of the shooter, never
 * behind), and that distance is within `maxRange`. With multiple targets in
 * line, the nearest (smallest `distance`) wins. Pure; no allocation beyond the
 * returned result.
 */
export function raycastHit(
  origin: Vec3Like,
  dir: Vec3Like,
  targets: readonly HitTarget[],
  radius: number = HIT_RADIUS,
  maxRange: number = MAX_RANGE,
): RayHit | null {
  let best: RayHit | null = null;
  for (const t of targets) {
    const ox = t.position.x - origin.x;
    const oy = t.position.y - origin.y;
    const oz = t.position.z - origin.z;
    const dist = ox * dir.x + oy * dir.y + oz * dir.z;
    if (dist < 0 || dist > maxRange) continue; // behind shooter, or too far
    const cx = dir.x * dist;
    const cy = dir.y * dist;
    const cz = dir.z * dist;
    const dx = ox - cx;
    const dy = oy - cy;
    const dz = oz - cz;
    const perpDistSq = dx * dx + dy * dy + dz * dz;
    if (perpDistSq > radius * radius) continue; // outside the hit cylinder
    if (!best || dist < best.distance) best = { id: t.id, distance: dist };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Visual: a short-lived green-phosphor tracer (outer green bolt + white-hot
// core), origin → hit point (hit) or max-range point along aim (miss).
// ---------------------------------------------------------------------------

const BULLET_LIFETIME_MS = 180;
const BULLET_OUTER_RADIUS = 0.35;
const BULLET_INNER_RADIUS = 0.12;
const BULLET_OUTER_COLOR = 0x39ff6a;
const BULLET_INNER_COLOR = 0xf4fff0;
const BULLET_OUTER_OPACITY = 0.85;
const BULLET_INNER_OPACITY = 0.95;

const UP = new THREE.Vector3(0, 1, 0);

interface ActiveBullet {
  group: THREE.Group;
  geos: THREE.BufferGeometry[];
  mats: THREE.MeshBasicMaterial[];
  born: number;
  life: number;
}

let activeBullets: ActiveBullet[] = [];

function spawnTracer(scene: THREE.Scene, origin: THREE.Vector3, endpoint: THREE.Vector3): void {
  const delta = new THREE.Vector3().subVectors(endpoint, origin);
  const length = delta.length();
  if (length < 1e-4) return;
  const dir = delta.clone().normalize();
  const mid = origin.clone().addScaledVector(dir, length / 2);

  const group = new THREE.Group();
  group.position.copy(mid);
  group.quaternion.setFromUnitVectors(UP, dir);
  group.name = 'bullet-tracer';

  const outerGeo = new THREE.CylinderGeometry(BULLET_OUTER_RADIUS, BULLET_OUTER_RADIUS, length, 6, 1, true);
  const outerMat = new THREE.MeshBasicMaterial({
    color: BULLET_OUTER_COLOR,
    transparent: true,
    opacity: BULLET_OUTER_OPACITY,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const outer = new THREE.Mesh(outerGeo, outerMat);

  const innerGeo = new THREE.CylinderGeometry(BULLET_INNER_RADIUS, BULLET_INNER_RADIUS, length, 6, 1, true);
  const innerMat = new THREE.MeshBasicMaterial({
    color: BULLET_INNER_COLOR,
    transparent: true,
    opacity: BULLET_INNER_OPACITY,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const inner = new THREE.Mesh(innerGeo, innerMat);

  group.add(outer);
  group.add(inner);
  scene.add(group);

  activeBullets.push({
    group,
    geos: [outerGeo, innerGeo],
    mats: [outerMat, innerMat],
    born: performance.now(),
    life: BULLET_LIFETIME_MS,
  });
}

function disposeBullet(scene: THREE.Scene, b: ActiveBullet): void {
  scene.remove(b.group);
  for (const g of b.geos) g.dispose();
  for (const m of b.mats) m.dispose();
}

function ageBullets(scene: THREE.Scene): void {
  if (activeBullets.length === 0) return;
  const now = performance.now();
  for (let i = activeBullets.length - 1; i >= 0; i--) {
    const b = activeBullets[i];
    const age = now - b.born;
    if (age >= b.life) {
      disposeBullet(scene, b);
      activeBullets.splice(i, 1);
      continue;
    }
    const opacityScale = 1 - age / b.life;
    b.mats[0].opacity = BULLET_OUTER_OPACITY * opacityScale;
    b.mats[1].opacity = BULLET_INNER_OPACITY * opacityScale;
  }
}

/** Where a shot's tracer should end: the hit point on a hit, else the
 *  max-range point along the aim direction. On a HIT with no known distance
 *  (remote shots only carry a `hitId`, not a distance), fall back to the
 *  live target's current position via `listTargets()`. */
function endpointFor(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  hit: { id: string; distance?: number } | undefined,
  avatarsApi: AvatarsApi | undefined,
): THREE.Vector3 {
  if (hit) {
    if (typeof hit.distance === 'number') return origin.clone().addScaledVector(dir, hit.distance);
    const target = avatarsApi?.listTargets?.().find((t) => t.id === hit.id);
    if (target) return target.position;
  }
  return origin.clone().addScaledVector(dir, MAX_RANGE);
}

// ---------------------------------------------------------------------------
// Audio: synthesized Web Audio blips — no binary assets, no licensing. A
// single AudioContext is reused across shots (never created per-shot); if
// construction throws (unsupported environment) we degrade to visual-only.
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;
let audioUnavailable = false;

function getAudioContext(): AudioContext | null {
  if (audioUnavailable) return null;
  if (audioCtx) return audioCtx;
  try {
    const Ctor =
      (typeof window !== 'undefined' && window.AudioContext) ||
      (typeof window !== 'undefined'
        ? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined);
    if (!Ctor) {
      audioUnavailable = true;
      return null;
    }
    audioCtx = new Ctor();
    return audioCtx;
  } catch {
    audioUnavailable = true;
    return null;
  }
}

function playBlip(freqStart: number, freqEnd: number, durationS: number, peakGain: number): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(freqStart, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), now + durationS);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationS);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + durationS + 0.02);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  } catch {
    /* degrade to visual-only */
  }
}

function playFireBlip(): void { playBlip(880, 220, 0.09, 0.18); }
function playHitBlip(): void { playBlip(1400, 260, 0.14, 0.22); }

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

let sceneRef: THREE.Scene | null = null;
let cameraRef: THREE.PerspectiveCamera | null = null;
let engineRef: Engine | null = null;
let offRemoteShoot: (() => void) | null = null;

function avatarsApiRef(): AvatarsApi | undefined {
  return engineRef?.api.avatars as AvatarsApi | undefined;
}

/** Render + play a shot that has ALREADY happened (local fire or a relayed
 *  remote shot) — shared by both paths so the effect is identical either way. */
function renderShot(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  hit: { id: string; distance?: number } | undefined,
): void {
  if (!sceneRef) return;
  const avatarsApi = avatarsApiRef();
  const endpoint = endpointFor(origin, dir, hit, avatarsApi);
  spawnTracer(sceneRef, origin, endpoint);
  playFireBlip();
  if (hit) {
    avatarsApi?.flashHit?.(hit.id);
    playHitBlip();
  }
}

function fireLocal(): void {
  if (!cameraRef) return;
  const origin = cameraRef.position.clone();
  const dir = new THREE.Vector3();
  cameraRef.getWorldDirection(dir); // already normalized

  const avatarsApi = avatarsApiRef();
  const targets = avatarsApi?.listTargets?.() ?? [];
  const hit = raycastHit(origin, dir, targets);

  renderShot(origin, dir, hit ?? undefined);

  const originArr: [number, number, number] = [origin.x, origin.y, origin.z];
  const dirArr: [number, number, number] = [dir.x, dir.y, dir.z];
  const role = useConnectionStore().role;
  if (role === 'guest') {
    guestSendShoot(originArr, dirArr, hit?.id);
  } else {
    hostSendShoot(originArr, dirArr, hit?.id);
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
  if (isInputFocused()) return; // ChatPanel's textarea owns Enter while focused
  fireLocal();
}

function onRemoteShoot(payload: EngineEvents['remoteShoot']): void {
  const origin = new THREE.Vector3(payload.origin[0], payload.origin[1], payload.origin[2]);
  const dir = new THREE.Vector3(payload.dir[0], payload.dir[1], payload.dir[2]);
  renderShot(origin, dir, payload.hitId ? { id: payload.hitId } : undefined);
}

export const bulletsSystem: EngineSystem = {
  setup(ctx: EngineContext) {
    sceneRef = ctx.scene;
    cameraRef = ctx.camera;
    engineRef = ctx.engine;
    offRemoteShoot = ctx.engine.events.on('remoteShoot', onRemoteShoot);
    window.addEventListener('keydown', onKeyDown);
  },

  update(_dt: number, ctx: EngineContext) {
    ageBullets(ctx.scene);
  },

  dispose(ctx: EngineContext) {
    window.removeEventListener('keydown', onKeyDown);
    if (offRemoteShoot) { offRemoteShoot(); offRemoteShoot = null; }
    for (const b of activeBullets) disposeBullet(ctx.scene, b);
    activeBullets = [];
    sceneRef = null;
    cameraRef = null;
    engineRef = null;
  },
};

export default bulletsSystem;
