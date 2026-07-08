// src/bridges/avatars.ts — store↔engine wiring for remote avatars (M4).
//
// Discovered by M0's `useEngineBridge` glob runner (one-time, first world
// mount). Three responsibilities, all read-only on frozen contracts:
//
//   1. **Roster → avatar lifecycle** — watches `usePlayersStore().players`,
//      filters out the local self peer, and forwards the others as plain
//      `PeerMeta` to `engine.api.avatars?.syncAvatars(…)`. The players store
//      stays *metadata-only*: no `THREE.Object3D` ever enters Vue reactivity.
//   2. **Local sender gate** — a single `POS_HZ` (12 Hz, §4.5) cadence that
//      reads `engine.camera` position + quaternion, applies the move-gate
//      (> 1 cm OR > 0.5° vs the last sent transform), and calls M3's exposed
//      `sendLocalPos(p, q)` (role-routed: guest→own CH_POS, host→all guest
//      pos-channels + `emitRemotePos(selfId,…)`). The hook owns serialization +
//      backpressure; the gate lives HERE in exactly one place (no double gate).
//   3. **5 Hz debug toggle** — `?poshz=5` URL flag throttles the sender so the
//      acceptance's "throttle sender to 5 Hz and confirm interpolation still
//      smooth" can be verified without a code change.
//
// The engine SYSTEM (`engine/systems/avatars.ts`) owns `'remotePos'` reception,
// snapshot buffers, interpolation, stall/fade, and mesh disposal. This bridge
// does NOT subscribe to `'remotePos'` (the system re-arms it every `setup()` to
// survive `engine.dispose()`/re-`init()`). This file is never re-edited; later
// phases add their own `bridges/*.ts`.

import { watch, watchEffect, type WatchStopHandle } from 'vue';
import type { Engine } from '../engine/core';
import type { AvatarsApi, PeerMeta } from '../engine/systems/avatars';
import { useConnectionStore } from '../stores/connection';
import { usePlayersStore } from '../stores/players';
import { sendLocalPos, stopLocalPosStream } from '../net/host';
import { POS_HZ } from '../config/net';

// ---- move-gate thresholds (§4.5) -------------------------------------------

const MOVE_CM = 1;                 // moved > 1 cm ⇒ send
const MOVE_EPS_SQ = (MOVE_CM * 0.01) ** 2; // (0.01 m)²
const ROT_EPS_RAD = 0.5 * Math.PI / 180;   // > 0.5° ⇒ send
const POS_HZ_DEBUG_MIN = 1;
const POS_HZ_DEBUG_MAX = 60;
const DEFAULT_POS_HZ = POS_HZ;

// ---- per-app module state (bridge is one-shot wired by useEngineBridge) ------

let installed = false;
let stopWatches: WatchStopHandle[] = [];
let senderTimer: number | undefined;
let posHz: number = DEFAULT_POS_HZ;

// reused scratch (no per-tick allocation); the sender runs at ~12 Hz, not per
// frame, but reuse keeps the §8.7-3 spirit anyway.
const curP = [0, 0, 0] as [number, number, number];
const curQ = [0, 0, 0, 1] as [number, number, number, number];
const lastP = [0, 0, 0] as [number, number, number];
const lastQ = [0, 0, 0, 1] as [number, number, number, number];
let haveSent = false;
let camRef: import('three').PerspectiveCamera | null = null;

/** Parse a `?poshz=<n>` debug flag for the 5 Hz throttle acceptance step. */
function readDebugPosHz(): number {
  try {
    const search = typeof window !== 'undefined' ? window.location?.search ?? '' : '';
    if (!search) return DEFAULT_POS_HZ;
    const v = new URLSearchParams(search).get('poshz');
    if (v === null) return DEFAULT_POS_HZ;
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n)) return DEFAULT_POS_HZ;
    if (n < POS_HZ_DEBUG_MIN || n > POS_HZ_DEBUG_MAX) return DEFAULT_POS_HZ;
    return n;
  } catch {
    return DEFAULT_POS_HZ;
  }
}

/** Moved > 1 cm OR rotated > 0.5° vs the last sent transform. */
function movedEnough(): boolean {
  if (!haveSent) return true;
  const dx = curP[0] - lastP[0];
  const dy = curP[1] - lastP[1];
  const dz = curP[2] - lastP[2];
  if (dx * dx + dy * dy + dz * dz > MOVE_EPS_SQ) return true;
  // angle between (unit) quaternions: 2·acos(|q1·q2|)
  const dot =
    curQ[0] * lastQ[0] + curQ[1] * lastQ[1] + curQ[2] * lastQ[2] + curQ[3] * lastQ[3];
  const d = dot < 0 ? -dot : dot;
  const clamped = d > 1 ? 1 : d < -1 ? -1 : d;
  const angle = 2 * Math.acos(clamped);
  return angle > ROT_EPS_RAD;
}

function readCameraTransform(): void {
  if (!camRef) return;
  const p = camRef.position;
  curP[0] = p.x; curP[1] = p.y; curP[2] = p.z;
  const q = camRef.quaternion;
  curQ[0] = q.x; curQ[1] = q.y; curQ[2] = q.z; curQ[3] = q.w;
}

function tickSender(): void {
  if (!camRef) return;
  readCameraTransform();
  if (!movedEnough()) return;
  sendLocalPos(curP, curQ);
  lastP[0] = curP[0]; lastP[1] = curP[1]; lastP[2] = curP[2];
  lastQ[0] = curQ[0]; lastQ[1] = curQ[1]; lastQ[2] = curQ[2]; lastQ[3] = curQ[3];
  haveSent = true;
}

function startSender(): void {
  if (senderTimer !== undefined) return;
  if (posHz <= 0) return;
  senderTimer = window.setInterval(tickSender, 1000 / posHz);
}

function stopSender(): void {
  if (senderTimer !== undefined) {
    window.clearInterval(senderTimer);
    senderTimer = undefined;
  }
  // reset the gate so the first tick after a restart always sends (re-seed
  // viewers quickly with the current transform), and drop any M3 host timer.
  haveSent = false;
  stopLocalPosStream();
}

export default function avatarsBridge(engine: Engine): void {
  if (installed) return; // idempotent guard (HMR / tests)

  const conn = useConnectionStore();
  const players = usePlayersStore();

  // The cone/tag system reads `engine.camera`; the sender does too.
  camRef = engine.camera;
  const api = engine.api;
  posHz = readDebugPosHz();
  (api.avatars as AvatarsApi | undefined)?.setPosHz?.(posHz);

  // --- roster → avatar lifecycle (metadata only) ---------------------------
  const unsubRoster = watch(
    () => players.players,
    (list) => {
      const others: PeerMeta[] = [];
      for (const p of list) {
        if (p.id === conn.selfId) continue; // never avatar ourselves
        others.push({ id: p.id, name: p.name, color: p.color });
      }
      (api.avatars as AvatarsApi | undefined)?.syncAvatars?.(others);
    },
    { immediate: true, deep: true },
  );

  // --- sender cadence: run only while a session is live -------------------
  // `sendLocalPos` is role-routed (guest/host/solo are all handled inside the
  // hook); we drive it for any connected multiplayer session and stand down
  // when idle/disconnected so a solo/menu tab does not spam `emitRemotePos`.
  const unsubStatus = watchEffect(() => {
    const live = conn.status === 'connected';
    // re-read the (possibly re-init'd) camera each time the session flips live
    camRef = engine.camera;
    if (live) {
      startSender();
    } else {
      stopSender();
    }
  });

  stopWatches = [unsubRoster, unsubStatus];
  installed = true;
}

/** Test/teardown escape hatch (mirrors `market.ts`/`connection.ts` convention). */
export function _resetAvatarsBridge(): void {
  for (const stop of stopWatches) stop();
  stopWatches = [];
  stopSender();
  camRef = null;
  haveSent = false;
  posHz = DEFAULT_POS_HZ;
  installed = false;
}