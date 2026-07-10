// tests/host.spec.ts — §NET2 bounded 'disconnected' grace period (host side).
//
// `hostReceiveOfferCode`'s `pc.onconnectionstatechange` handler previously
// only acted on 'failed'/'closed' (→ `removeGuest(conn0, 'dropped')`); a guest
// stuck in 'disconnected' sat in the roster indefinitely, visible to every
// other peer via `broadcastRoster()`, until the browser's own eventual
// 'failed' transition (platform-dependent, can be very slow or never fire
// cleanly). This adds a `RECONNECT_GRACE_MS` timer armed on entering
// 'disconnected': if still 'disconnected' when it fires, the guest is removed
// exactly as the existing 'failed'/'closed' path does. Recovering to
// 'connected' before the timer fires must NOT remove the guest.
//
// Drives the module-private `handleGuestConnectionState` through test-only
// seams (`_testInstallGuestForGrace` / `_testDriveGuestConnectionState` /
// `_testHasGuest`, the same convention as `_testInstallGuestChannels` in
// pos-sender.spec.ts) with vitest fake timers — no real RTCPeerConnection or
// signaling handshake (node has neither).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import {
  RECONNECT_GRACE_MS,
  _testInstallGuestForGrace, _testDriveGuestConnectionState, _testHasGuest,
  _testClearGuests, _testInstallGuestChannels, _testHandleGuestRel,
  hostSendShoot,
} from '../src/net/host';
import { useConnectionStore } from '../src/stores/connection';
import { engine } from '../src/engine/core';

function stubWindow(): void {
  vi.stubGlobal('window', globalThis);
}

function fakePc(state: RTCPeerConnectionState): RTCPeerConnection {
  return { connectionState: state } as unknown as RTCPeerConnection;
}

describe('§NET2 host bounded-disconnect grace', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    stubWindow();
    vi.useFakeTimers();
    _testClearGuests();
    useConnectionStore().reset();
  });

  afterEach(() => {
    _testClearGuests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('entering disconnected does not remove the guest immediately', () => {
    _testInstallGuestForGrace('a');
    _testDriveGuestConnectionState('a', fakePc('disconnected'));

    expect(_testHasGuest('a')).toBe(true);
  });

  it('recovers to connected within the grace window: guest stays, and the cancelled timer does not remove it later', () => {
    _testInstallGuestForGrace('a');
    const pc = fakePc('disconnected');
    _testDriveGuestConnectionState('a', pc);

    vi.advanceTimersByTime(RECONNECT_GRACE_MS / 2);
    pc.connectionState = 'connected';
    _testDriveGuestConnectionState('a', pc);

    expect(_testHasGuest('a')).toBe(true);

    // advancing past the original deadline must NOT retroactively remove it
    vi.advanceTimersByTime(RECONNECT_GRACE_MS);
    expect(_testHasGuest('a')).toBe(true);
  });

  it('still disconnected when the grace window elapses: removed exactly like the failed path', () => {
    _testInstallGuestForGrace('a');
    _testDriveGuestConnectionState('a', fakePc('disconnected'));

    vi.advanceTimersByTime(RECONNECT_GRACE_MS);

    expect(_testHasGuest('a')).toBe(false);
  });

  it('a sooner "failed" removes immediately and cancels the pending grace timer (no double-remove/throw)', () => {
    _testInstallGuestForGrace('a');
    const pc = fakePc('disconnected');
    _testDriveGuestConnectionState('a', pc);

    pc.connectionState = 'failed';
    _testDriveGuestConnectionState('a', pc);

    expect(_testHasGuest('a')).toBe(false);
    expect(() => vi.advanceTimersByTime(RECONNECT_GRACE_MS)).not.toThrow();
  });

  it('unrelated guests are unaffected by one guest timing out', () => {
    _testInstallGuestForGrace('a');
    _testInstallGuestForGrace('b');
    _testDriveGuestConnectionState('a', fakePc('disconnected'));

    vi.advanceTimersByTime(RECONNECT_GRACE_MS);

    expect(_testHasGuest('a')).toBe(false);
    expect(_testHasGuest('b')).toBe(true);
  });
});

// ---- BULLET1: 'shoot' relay path -------------------------------------------
//
// `shoot` rides the reliable `rel` channel (not `pos`); the host relays a
// guest's shot to every OTHER guest (never echoed back to the sender), and a
// host-fired shot broadcasts to every guest. Both paths also emit
// `'remoteShoot'` on `engine.events` so the host's own bullets system renders
// guest-fired shots (mirrors the 'pos' → `emitRemotePos` seam).

interface FakeRel {
  readyState: 'open' | 'closed';
  bufferedAmount: number;
  sent: string[];
  send(d: string): void;
  addEventListener(): void;
  removeEventListener(): void;
  close(): void;
}

function fakeRel(): FakeRel {
  const ch: FakeRel = {
    readyState: 'open',
    bufferedAmount: 0,
    sent: [],
    send(d) { ch.sent.push(d); },
    addEventListener() { /* unused: bufferedAmount stays under BUFFER_HIGH */ },
    removeEventListener() { /* unused */ },
    close() { ch.readyState = 'closed'; },
  };
  return ch;
}

function asChan(ch: FakeRel): RTCDataChannel { return ch as unknown as RTCDataChannel; }

describe('§BULLET1 host shoot relay', () => {
  let remoteShootCalls: unknown[] = [];
  let unsub: (() => void) | undefined;

  beforeEach(() => {
    setActivePinia(createPinia());
    _testClearGuests();
    useConnectionStore().reset();
    engine.events.clear();
    remoteShootCalls = [];
    unsub = engine.events.on('remoteShoot', (p) => { remoteShootCalls.push(p); });
  });

  afterEach(() => {
    if (unsub) unsub();
    _testClearGuests();
  });

  it('a guest-fired shot relays to every OTHER guest, never echoed back to the sender', () => {
    const relA = fakeRel();
    const relB = fakeRel();
    _testInstallGuestChannels([
      { id: 'a', pos: asChan(fakeRel()), rel: asChan(relA) },
      { id: 'b', pos: asChan(fakeRel()), rel: asChan(relB) },
    ]);

    const raw = {
      v: 1, t: 'shoot', from: 'a', ts: Date.now(),
      d: { origin: [1, 2, 3], dir: [0, 0, -1], hitId: 'b' },
    };
    _testHandleGuestRel('a', raw);

    expect(relA.sent).toHaveLength(0); // not echoed back to the shooter
    expect(relB.sent).toHaveLength(1);
    const env = JSON.parse(relB.sent[0]) as { t: string; from: string; d: { origin: number[]; dir: number[]; hitId?: string } };
    expect(env.t).toBe('shoot');
    expect(env.from).toBe('a');
    expect(env.d.origin).toEqual([1, 2, 3]);
    expect(env.d.hitId).toBe('b');
  });

  it('a guest-fired shot emits remoteShoot(from=guestId,…) so the host itself renders it', () => {
    _testInstallGuestChannels([{ id: 'a', pos: asChan(fakeRel()), rel: asChan(fakeRel()) }]);

    const raw = { v: 1, t: 'shoot', from: 'a', ts: Date.now(), d: { origin: [0, 0, 0], dir: [0, 0, -1] } };
    _testHandleGuestRel('a', raw);

    expect(remoteShootCalls).toHaveLength(1);
    const r = remoteShootCalls[0] as { from: string; origin: number[]; dir: number[]; hitId?: string };
    expect(r.from).toBe('a');
    expect(r.hitId).toBeUndefined();
  });

  it('a malformed shoot payload is ignored (no relay, no emit, no throw)', () => {
    const relB = fakeRel();
    _testInstallGuestChannels([
      { id: 'a', pos: asChan(fakeRel()), rel: asChan(fakeRel()) },
      { id: 'b', pos: asChan(fakeRel()), rel: asChan(relB) },
    ]);

    const bad = { v: 1, t: 'shoot', from: 'a', ts: Date.now(), d: { origin: [1, 2], dir: [0, 0, -1] } };
    expect(() => _testHandleGuestRel('a', bad)).not.toThrow();

    expect(relB.sent).toHaveLength(0);
    expect(remoteShootCalls).toHaveLength(0);
  });

  it('hostSendShoot broadcasts a host-fired shot to every guest', () => {
    const relA = fakeRel();
    const relB = fakeRel();
    _testInstallGuestChannels([
      { id: 'a', pos: asChan(fakeRel()), rel: asChan(relA) },
      { id: 'b', pos: asChan(fakeRel()), rel: asChan(relB) },
    ]);

    hostSendShoot([4, 5, 6], [0, 0, -1], 'a');

    expect(relA.sent).toHaveLength(1);
    expect(relB.sent).toHaveLength(1);
    const env = JSON.parse(relA.sent[0]) as { t: string; from: string; d: { origin: number[]; hitId?: string } };
    expect(env.t).toBe('shoot');
    expect(env.from).toBe('H');
    expect(env.d.origin).toEqual([4, 5, 6]);
    expect(env.d.hitId).toBe('a');
  });

  it('hostSendShoot with zero guests (solo) is a safe no-op', () => {
    expect(() => hostSendShoot([0, 0, 0], [0, 0, -1])).not.toThrow();
  });
});
