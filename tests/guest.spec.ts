// tests/guest.spec.ts — §NET2 bounded 'disconnected' grace period (guest side).
//
// `pc.onconnectionstatechange` previously: 'connected' → setStatus('connected');
// 'disconnected' → setStatus('disconnected') only (unbounded — relies on the
// browser's own eventual 'failed' transition, which is platform-dependent and
// can be very slow or never fire cleanly); 'failed' → setStatus('failed') +
// onHostGone() (the banner / full teardown path). This adds a
// `RECONNECT_GRACE_MS` timer armed on entering 'disconnected': if still
// 'disconnected' when it fires, do exactly what the 'failed' branch does.
// Recovering to 'connected' before the timer fires must NOT tear down.
//
// Drives the module-private `handleConnectionStateChange` through test-only
// seams (`_testSetPc` / `_testFireConnectionStateChange`, the same convention
// as `_testHandleRelEnv` in guest-receive.spec.ts) with vitest fake timers —
// no real RTCPeerConnection (node has none).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import {
  _testSetPc, _testFireConnectionStateChange, _testInstallGuestRel,
  _testHandleRelEnv, guestSendShoot,
} from '../src/net/guest';
import { RECONNECT_GRACE_MS } from '../src/net/host';
import { useConnectionStore } from '../src/stores/connection';
import { engine } from '../src/engine/core';

// `onHostGone` calls `stopPosStream`/`stopPing`, which use `window.clearInterval`;
// aliasing `window` to `globalThis` lets vitest's faked timers drive both
// `window.setTimeout`/`clearTimeout` (used by the grace timer) and any
// leftover `window.setInterval`/`clearInterval` calls through the same clock.
function stubWindow(): void {
  vi.stubGlobal('window', globalThis);
}

function fakePc(state: RTCPeerConnectionState): RTCPeerConnection {
  return { connectionState: state } as unknown as RTCPeerConnection;
}

describe('§NET2 guest bounded-disconnect grace', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    stubWindow();
    vi.useFakeTimers();
    useConnectionStore().reset();
  });

  afterEach(() => {
    _testSetPc(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not tear down on entering disconnected — status flips, no banner yet', () => {
    const conn = useConnectionStore();
    _testSetPc(fakePc('disconnected'));
    _testFireConnectionStateChange();

    expect(conn.status).toBe('disconnected');
    expect(conn.banner).toBeNull();
  });

  it('recovers to connected within the grace window: no teardown, and the cancelled timer does not fire later', () => {
    const conn = useConnectionStore();
    const pc = fakePc('disconnected');
    _testSetPc(pc);
    _testFireConnectionStateChange();

    vi.advanceTimersByTime(RECONNECT_GRACE_MS / 2);
    pc.connectionState = 'connected';
    _testFireConnectionStateChange();

    expect(conn.status).toBe('connected');
    expect(conn.banner).toBeNull();

    // advancing past the original deadline must NOT retroactively tear down
    vi.advanceTimersByTime(RECONNECT_GRACE_MS);
    expect(conn.status).toBe('connected');
    expect(conn.banner).toBeNull();
  });

  it('still disconnected when the grace window elapses: same cleanup as the failed path', () => {
    const conn = useConnectionStore();
    _testSetPc(fakePc('disconnected'));
    _testFireConnectionStateChange();

    vi.advanceTimersByTime(RECONNECT_GRACE_MS);

    // matches the existing 'failed' branch's outcome exactly: onHostGone()
    // itself sets status back to 'disconnected' (pre-existing behavior,
    // unchanged here) — the real teardown signal is the banner.
    expect(conn.status).toBe('disconnected');
    expect(conn.banner).toBe('host-left');
  });

  it('a sooner "failed" tears down immediately and cancels the pending grace timer (no double-fire)', () => {
    const conn = useConnectionStore();
    const pc = fakePc('disconnected');
    _testSetPc(pc);
    _testFireConnectionStateChange();

    pc.connectionState = 'failed';
    _testFireConnectionStateChange();

    expect(conn.status).toBe('disconnected');
    expect(conn.banner).toBe('host-left');

    // the original grace timer, if it were still armed, must not throw or
    // double-apply cleanup once its deadline passes
    expect(() => vi.advanceTimersByTime(RECONNECT_GRACE_MS)).not.toThrow();
  });
});

// ---- BULLET1: 'shoot' relay path (guest side) ------------------------------
//
// `guestSendShoot` mirrors `guestSendChat` — sends to the host over the
// reliable `rel` channel. A received `shoot` Env (relayed by the host, from
// another guest or the host itself) emits `'remoteShoot'` on `engine.events`
// so this guest's bullets system renders it.

interface FakeRel {
  readyState: 'open' | 'closed';
  sent: string[];
  send(d: string): void;
}

function fakeRel(): FakeRel {
  const ch: FakeRel = { readyState: 'open', sent: [], send(d) { ch.sent.push(d); } };
  return ch;
}

describe('§BULLET1 guest shoot relay', () => {
  let remoteShootCalls: unknown[] = [];
  let unsub: (() => void) | undefined;

  beforeEach(() => {
    setActivePinia(createPinia());
    useConnectionStore().reset();
    _testInstallGuestRel(null);
    engine.events.clear();
    remoteShootCalls = [];
    unsub = engine.events.on('remoteShoot', (p) => { remoteShootCalls.push(p); });
  });

  afterEach(() => {
    if (unsub) unsub();
    _testInstallGuestRel(null);
  });

  it('guestSendShoot sends a shoot Env to the host over the open rel channel', () => {
    const rel = fakeRel();
    _testInstallGuestRel(rel as unknown as RTCDataChannel);

    guestSendShoot([1, 2, 3], [0, 0, -1], 'H');

    expect(rel.sent).toHaveLength(1);
    const env = JSON.parse(rel.sent[0]) as { t: string; d: { origin: number[]; dir: number[]; hitId?: string } };
    expect(env.t).toBe('shoot');
    expect(env.d.origin).toEqual([1, 2, 3]);
    expect(env.d.hitId).toBe('H');
  });

  it('guestSendShoot is a safe no-op when the rel channel is not open', () => {
    _testInstallGuestRel(null);
    expect(() => guestSendShoot([0, 0, 0], [0, 0, -1])).not.toThrow();
  });

  it('a received shoot Env emits remoteShoot(from,origin,dir,hitId) for the bullets system', () => {
    const raw = { v: 1, t: 'shoot', from: 'b', ts: Date.now(), d: { origin: [4, 5, 6], dir: [0, 0, -1], hitId: 'c' } };
    _testHandleRelEnv(raw);

    expect(remoteShootCalls).toHaveLength(1);
    const r = remoteShootCalls[0] as { from: string; origin: number[]; dir: number[]; hitId?: string };
    expect(r.from).toBe('b');
    expect(r.origin).toEqual([4, 5, 6]);
    expect(r.hitId).toBe('c');
  });

  it('a received shoot Env without a hit omits hitId', () => {
    const raw = { v: 1, t: 'shoot', from: 'b', ts: Date.now(), d: { origin: [0, 0, 0], dir: [0, 0, -1] } };
    _testHandleRelEnv(raw);

    expect(remoteShootCalls).toHaveLength(1);
    const r = remoteShootCalls[0] as { hitId?: string };
    expect(r.hitId).toBeUndefined();
  });

  it('a malformed shoot Env is ignored (no emit, no throw)', () => {
    const bad = { v: 1, t: 'shoot', from: 'b', ts: Date.now(), d: { origin: [1, 2], dir: [0, 0, -1] } };
    expect(() => _testHandleRelEnv(bad)).not.toThrow();
    expect(remoteShootCalls).toHaveLength(0);
  });
});
