// src/engine/systems/avatars.ts — §8.5/§8.6 remote avatars + interpolation.
//
// Per remote peer: a world-positioned `THREE.Group` (no rotation — keeps the
// name tag world-up) holding a `coneHolder` `Group` whose quaternion = the
// remote peer's view quaternion. The cone is a `ConeGeometry(r 8, h 20)` with
// its tip baked toward **−z = view direction** (`geo.rotateX(-π/2)`), colored
// with the deterministic HSL that mirrors `players.colorFromId` so the avatar
// matches the roster dots. A 384×128 canvas **name-tag** `Sprite` (scale 48×16,// ~10× visible size at city scale) sits at y=+28 (billboard; pill background;
// long-name truncation) — above the now-20-tall cone.
//
// Snapshot buffer: the **last two** `{t,p,q}` per peer live in a plain engine
// `Map` (NOT Pinia). Each peer holds two persistent `Snap` objects (one
// `Vector3` + one `Quaternion` each, allocated once at avatar creation) whose
// fields are overwritten on receive — zero per-frame allocations. Receive is
// stamped with `performance.now()` (the rAF clock) so it aligns with `update`.
//
// Interpolation renders at `now − 150 ms`:
//   - render time within [older, newer] ⇒ lerp position / slerp quaternions
//     into the M0 shared `engine/scratch.ts` (copied out before any other
//     system touches scratch).
//   - otherwise ⇒ hold the newest snapshot (no extrapolation). Newest snapshot
//     age > 400 ms ⇒ hold (clamped mechanically by the bracket); > 5 s ⇒ fade
//     to 40% opacity ("stalled") ramped over 1 s; roster removal deletes the
//     avatar (mesh/canvas/texture disposed).
//
// The `'remotePos'` subscription is owned by THIS system (not the bridge),
// re-armed on every `setup()`. Rationale: `useEngineBridge` is a one-shot glob
// runner (never re-fires), and `engine.dispose()` clears the emitter — re-sub
// here keeps the wiring alive across leave→menu→rejoin.
//
// Live transforms live ONLY in this `Map`; `usePlayersStore` stays
// metadata-only (no Three object is wrapped in `reactive()`/`ref()`).

import * as THREE from 'three';
import type { EngineSystem, EngineContext } from '../core';
import { scratch } from '../scratch';
import { useConnectionStore } from '../../stores/connection';

/** The M3/M4 frozen `'remotePos'` payload contract (the M3 brief's fields). */
export interface RemotePos {
  from: string;
  p: [number, number, number];
  q: [number, number, number, number];
}

/** Peer metadata consumed by `syncAvatars` (plain data — never a Three object). */
export interface PeerMeta {
  id: string;
  name: string;
  color: string;
}

interface Snap {
  t: number;
  p: THREE.Vector3;
  q: THREE.Quaternion;
}

interface Avatar {
  id: string;
  name: string;
  /** Current hue (0..1) used by both cone + tag border so they match the roster. */
  hue: number;
  group: THREE.Group;       // world position; no rotation (tag stays upright)
  coneHolder: THREE.Group;  // quaternion = remote view rotation
  cone: THREE.Mesh;
  coneMat: THREE.MeshLambertMaterial;
  tag: THREE.Sprite;
  tagMat: THREE.SpriteMaterial;
  tagCanvas: HTMLCanvasElement;
  tagTexture: THREE.CanvasTexture;
  snaps: [Snap, Snap];     // [older, newer] — fields overwritten in place
  haveNewer: boolean;
  haveOlder: boolean;
  opacity: number;         // current (ramped toward target at 1/s)
}

export interface AvatarsApi {
  /** Reconcile the live avatar set to the given roster (add/remove/rename). */
  syncAvatars(roster: ReadonlyArray<PeerMeta>): void;
  /** Push a received snapshot (mostly internal; the system self-subscribes). */
  pushSnapshot(id: string, p: [number, number, number], q: [number, number, number, number]): void;
  /** Live avatar count (non-self). */
  count(): number;
  /** Drop everything (teardown / test reset). */
  reset(): void;
  /** Sender cadence used by the bridge (Hz) — surfaced for the debug overlay. */
  posHz(): number;
  /** Announce the live sender cadence (Hz) so the HUD overlay can read it. */
  setPosHz(hz: number): void;
}

// ---- per-init module state -------------------------------------------------

let root: THREE.Group | null = null;
let sceneRef: THREE.Scene | null = null;
let offRemote: (() => void) | null = null;
const avatars = new Map<string, Avatar>();
let apiAvatars: AvatarsApi | null = null;
let bridgePosHz = 12; // bridge announces the live cadence here for the HUD overlay

// ---- constants --------------------------------------------------------------

const CONE_R = 8;
const CONE_H = 20;
const TAG_CW = 384;
const TAG_CH = 128;
const TAG_Y = 28;
const TAG_SCALE_W = 48;
const TAG_SCALE_H = 16;
const RENDER_LAG_MS = 150;
// (HOLD_MS = 400: newest age beyond which we merely "hold" — applied
//  mechanically by the bracket: renderT beyond newer ⇒ hold newest.)

const STALL_MS = 5000;     // newest age beyond which we fade to 40%
const STALL_OPACITY = 0.4;
const STALL_RAMP_S = 1;
const HUE_S = 0.7;
const HUE_L = 0.62;

// ---- deterministic HSL from id (mirrors `stores/players.colorFromId`) --------

function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return (h % 360) / 360;
}

// ---- name-tag canvas --------------------------------------------------------

function makeTagCanvas(name: string, hue: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = TAG_CW;
  c.height = TAG_CH;
  paintTag(c, name, hue);
  return c;
}

function paintTag(c: HTMLCanvasElement, name: string, hue: number): void {
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, TAG_CW, TAG_CH);
  const r = TAG_CH / 2;
  // pill background
  ctx.fillStyle = 'rgba(8, 12, 18, 0.78)';
  roundedPill(ctx, 8, 8, TAG_CW - 16, TAG_CH - 16, r - 8);
  ctx.fill();
  // colored border (roster hue) reinforces the dot color
  ctx.strokeStyle = `hsl(${Math.round(hue * 360)} 70% 62%)`;
  ctx.lineWidth = 6;
  roundedPill(ctx, 8, 8, TAG_CW - 16, TAG_CH - 16, r - 8);
  ctx.stroke();
  // name (truncate to fit) — font scaled 2× to fill the 2×-larger canvas
  ctx.fillStyle = '#eaf2fb';
  ctx.font = '600 60px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const maxW = TAG_CW - 48;
  let label = name.length > 16 ? name.slice(0, 15) + '…' : name;
  while (ctx.measureText(label).width > maxW && label.length > 2) {
    label = label.slice(0, -2) + '…';
  }
  ctx.fillText(label, TAG_CW / 2, TAG_CH / 2 + 1);
}

function roundedPill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---- avatar lifecycle -------------------------------------------------------

function createAvatar(meta: PeerMeta): Avatar {
  const hue = hueFromId(meta.id);

  const coneGeo = new THREE.ConeGeometry(CONE_R, CONE_H, 18);
  coneGeo.rotateX(-Math.PI / 2); // tip → −z (view direction)
  const coneMat = new THREE.MeshLambertMaterial({
    color: new THREE.Color().setHSL(hue, HUE_S, HUE_L),
    transparent: true,
    opacity: 1,
  });
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.name = 'avatar-cone';

  const coneHolder = new THREE.Group();
  coneHolder.add(cone);
  coneHolder.name = 'avatar-coneHolder';

  const tagCanvas = makeTagCanvas(meta.name, hue);
  const tagTexture = new THREE.CanvasTexture(tagCanvas);
  tagTexture.anisotropy = 4;
  tagTexture.needsUpdate = true;
  const tagMat = new THREE.SpriteMaterial({
    map: tagTexture,
    transparent: true,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const tag = new THREE.Sprite(tagMat);
  tag.scale.set(TAG_SCALE_W, TAG_SCALE_H, 1);
  tag.position.set(0, TAG_Y, 0);
  tag.name = 'avatar-tag';

  const group = new THREE.Group();
  group.add(coneHolder);
  group.add(tag);
  group.name = `avatar-${meta.id}`;

  return {
    id: meta.id,
    name: meta.name,
    hue,
    group,
    coneHolder,
    cone,
    coneMat,
    tag,
    tagMat,
    tagCanvas,
    tagTexture,
    snaps: [
      { t: 0, p: new THREE.Vector3(), q: new THREE.Quaternion() },
      { t: 0, p: new THREE.Vector3(), q: new THREE.Quaternion() },
    ],
    haveNewer: false,
    haveOlder: false,
    opacity: 1,
  };
}

function setAvatarName(a: Avatar, name: string): void {
  if (a.name === name) return;
  a.name = name;
  paintTag(a.tagCanvas, name, a.hue);
  a.tagTexture.needsUpdate = true;
}

function disposeAvatar(a: Avatar): void {
  root?.remove(a.group);
  a.cone.geometry.dispose();
  a.coneMat.dispose();
  a.tagMat.dispose();
  a.tagTexture.dispose();
}

// ---- snapshot + roster reconciliation --------------------------------------

function onRemotePos(raw: unknown): void {
  // The frozen `EngineEvents['remotePos']` type is `{id,pos}` (M0 placeholder);
  // M3 emits both via a cast. We read the M3/M4 fields `from`/`p`/`q`, falling
  // back to M0's keys only as a last resort.
  const pl = raw as Partial<RemotePos & { id?: string; pos?: ArrayLike<number> }>;
  const id = pl.from ?? pl.id;
  if (!id) return;
  if (id === useConnectionStore().selfId) return; // filter self-emit
  const p = pl.p ?? (pl.pos ? [pl.pos[0], pl.pos[1], pl.pos[2]] as [number, number, number] : undefined);
  if (!p || !pl.q) return;
  pushSnapshot(id, p, pl.q);
}

function pushSnapshot(id: string, p: [number, number, number], q: [number, number, number, number]): void {
  const a = avatars.get(id);
  if (!a) return; // roster not synced yet (or stale) — drop
  const older = a.snaps[0];
  const newer = a.snaps[1];
  const now = performance.now();
  if (!a.haveNewer) {
    newer.t = now;
    newer.p.set(p[0], p[1], p[2]);
    newer.q.set(q[0], q[1], q[2], q[3]);
    a.haveNewer = true;
    return;
  }
  // shift newer → older (overwrite in place), then write the new newest
  older.t = newer.t;
  older.p.copy(newer.p);
  older.q.copy(newer.q);
  newer.t = now;
  newer.p.set(p[0], p[1], p[2]);
  newer.q.set(q[0], q[1], q[2], q[3]);
  a.haveOlder = true;
}

function syncAvatars(roster: ReadonlyArray<PeerMeta>): void {
  const next = new Set<string>();
  for (const peer of roster) {
    next.add(peer.id);
    const existing = avatars.get(peer.id);
    if (!existing) {
      const a = createAvatar(peer);
      avatars.set(peer.id, a);
      root?.add(a.group);
    } else {
      setAvatarName(existing, peer.name);
    }
  }
  // remove ones no longer in the roster
  for (const [id, a] of avatars) {
    if (!next.has(id)) {
      disposeAvatar(a);
      avatars.delete(id);
    }
  }
}

function reset(): void {
  for (const a of avatars.values()) disposeAvatar(a);
  avatars.clear();
}

// ---- the system ------------------------------------------------------------

export const avatarsSystem: EngineSystem = {
  setup(ctx: EngineContext) {
    sceneRef = ctx.scene;
    root = new THREE.Group();
    root.name = 'avatars';
    ctx.scene.add(root);
    offRemote = ctx.engine.events.on('remotePos', onRemotePos);
    apiAvatars = {
      syncAvatars,
      pushSnapshot,
      count: () => avatars.size,
      reset,
      posHz: () => bridgePosHz,
      setPosHz: (hz: number) => { bridgePosHz = hz; },
    };
    ctx.engine.api.avatars = apiAvatars;
  },

  update(dt: number, _ctx: EngineContext) {
    if (!root) return;
    const now = performance.now();
    const renderT = now - RENDER_LAG_MS;
    for (const a of avatars.values()) {
      if (!a.haveNewer) continue; // no snapshot yet
      const older = a.snaps[0];
      const newer = a.snaps[1];
      const newestAge = now - newer.t;

      // --- opacity / stall ------------------------------------------------
      const targetOpacity = newestAge > STALL_MS ? STALL_OPACITY : 1;
      const maxStep = dt / STALL_RAMP_S;
      if (a.opacity < targetOpacity) {
        a.opacity = Math.min(targetOpacity, a.opacity + maxStep);
      } else if (a.opacity > targetOpacity) {
        a.opacity = Math.max(targetOpacity, a.opacity - maxStep);
      }
      a.coneMat.opacity = a.opacity;
      a.tagMat.opacity = a.opacity;

      // --- position / orientation -----------------------------------------
      const interp =
        a.haveOlder &&
        renderT >= older.t &&
        renderT <= newer.t &&
        newer.t > older.t;
      if (interp) {
        const span = newer.t - older.t;
        const alpha = (renderT - older.t) / span;
        // position lerp → scratch.v3a, copied out immediately (scratch is shared)
        scratch.v3a.copy(older.p).lerp(newer.p, alpha);
        a.group.position.copy(scratch.v3a);
        // quaternion slerp → scratch.q, copied out immediately
        scratch.q.copy(older.q).slerp(newer.q, alpha);
        a.coneHolder.quaternion.copy(scratch.q);
      } else {
        // hold newest (covers >400 ms hold and the brief pre-bracket window)
        a.group.position.copy(newer.p);
        a.coneHolder.quaternion.copy(newer.q);
      }
    }
  },

  dispose(_ctx: EngineContext) {
    if (offRemote) { offRemote(); offRemote = null; }
    for (const a of avatars.values()) disposeAvatar(a);
    avatars.clear();
    if (root && sceneRef) sceneRef.remove(root);
    // Unregister the api sliver so the bridge's optional chaining no-ops
    // between a `leave→menu` (engine.dispose) and the next `engine.init`;
    // otherwise the still-live roster watchers would write into a torn-down
    // Map. Re-setup re-registers a fresh api on re-init.
    delete _ctx.engine.api.avatars;
    root = null;
    sceneRef = null;
    apiAvatars = null;
  },
};

export default avatarsSystem;