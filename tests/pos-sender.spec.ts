// tests/pos-sender.spec.ts — M3F local-pos sender (§4.5 pos channel).
//
// Unit-tests the role-routed `sendLocalPos(p,q)` hook (net/host.ts) M4's avatars
// bridge drives, plus the host's pos fan-out. Pure logic under the node env:
// channels are faked (no WebRTC). Covers:
//   - role routing (host ⇒ every peer's pos-channel w/ from===hostSelfId;
//     guest ⇒ only the guest's own pos-channel w/ from===guestSelfId),
//   - the host's own pos now reaches guests (was never broadcast before M3F),
//   - `bufferedAmountLow` is invoked under backpressure (≥ BUFFER_HIGH) and the
//     send is deferred (never dropped),
//   - the "no second gate" property — `sendLocalPos` sends every call; M4 owns
//     the move-gate,
//   - the existing relay / `emitRemotePos` seam still fires.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import {
  sendLocalPos, fanOutPosTo, stopLocalPosStream, emitRemotePos,
  _testInstallGuestChannels, _testClearGuests,
} from '../src/net/host';
import { _dispatchGuestPos, _testInstallGuestPos } from '../src/net/guest';
import { useConnectionStore } from '../src/stores/connection';
import { engine } from '../src/engine/core';
import { makeEnv } from '../src/net/rtc';
import { BUFFER_HIGH, BUFFER_LOW_THRESHOLD, CH_POS } from '../src/config/net';

// ---- minimal fake `RTCDataChannel` (pos channel) ---------------------------

interface FakePos {
  label: string;
  readyState: 'open' | 'closed';
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  sent: string[];
  private _h: Map<string, (...a: unknown[]) => void>;
  send(d: string): void;
  addEventListener(t: string, fn: (...a: unknown[]) => void): void;
  removeEventListener(t: string, fn: (...a: unknown[]) => void): void;
  close(): void;
  fire(t: string): void;
}

function fakePos(opts: { bufferedAmount?: number; readyState?: 'open' | 'closed' } = {}): FakePos {
  const _h = new Map<string, (...a: unknown[]) => void>();
  const ch: FakePos = {
    label: CH_POS,
    readyState: opts.readyState ?? 'open',
    bufferedAmount: opts.bufferedAmount ?? 0,
    bufferedAmountLowThreshold: 0,
    sent: [],
    _h,
    send(d) { ch.sent.push(d); },
    addEventListener(t, fn) { _h.set(t, fn); },
    removeEventListener(t) { _h.delete(t); },
    close() { ch.readyState = 'closed'; },
    fire(t) { _h.get(t)?.(); },
  };
  return ch;
}

/** Cast a fake channel into the RTCDataChannel shape the net module expects. */
function asChan(ch: FakePos): RTCDataChannel {
  return ch as unknown as RTCDataChannel;
}

function parseSent(s: string): {
  v: number; t: string; from: string; ts: number;
  d: { p: number[]; q: number[] };
} {
  return JSON.parse(s) as { v: number; t: string; from: string; ts: number; d: { p: number[]; q: number[] } };
}

let remotePosCalls: unknown[] = [];
let unsubRemotePos: (() => void) | undefined;

function trackRemotePos(): void {
  remotePosCalls = [];
  unsubRemotePos = engine.events.on('remotePos', (p) => { remotePosCalls.push(p); });
}

beforeEach(() => {
  setActivePinia(createPinia());
  _testClearGuests();
  _testInstallGuestPos(null);
  // the engine.events singleton is shared across tests — wipe stale listeners
  engine.events.clear();
  trackRemotePos();
});

afterEach(() => {
  if (unsubRemotePos) unsubRemotePos();
  _testClearGuests();
  _testInstallGuestPos(null);
});

const P: [number, number, number] = [1, 2, 3];
const Q: [number, number, number, number] = [0, 0, 0, 1];

describe('M3F sendLocalPos — role routing (§4.5)', () => {
  it('host role: writes to EVERY peer pos-channel with from === hostSelfId', () => {
    const conn = useConnectionStore();
    conn.setRole('host');
    conn.setSelfId('H');

    const g1 = fakePos();
    const g2 = fakePos();
    _testInstallGuestChannels([
      { id: 'a', pos: asChan(g1) },
      { id: 'b', pos: asChan(g2) },
    ]);

    sendLocalPos(P, Q);

    expect(g1.sent).toHaveLength(1);
    expect(g2.sent).toHaveLength(1);
    const e1 = parseSent(g1.sent[0]);
    const e2 = parseSent(g2.sent[0]);
    expect(e1.v).toBe(1);
    expect(e1.t).toBe('pos');
    expect(e1.from).toBe('H');
    expect(e2.from).toBe('H');
    expect(e1.d.p).toEqual(P);
    expect(e1.d.q).toEqual(Q);
    expect(e2.d.p).toEqual(P);
    expect(e2.d.q).toEqual(Q);
    expect(typeof e1.ts).toBe('number');
  });

  it('host role: emits remotePos(selfId,p,q) so the host avatar is locally consistent', () => {
    const conn = useConnectionStore();
    conn.setRole('host');
    conn.setSelfId('H');
    _testInstallGuestChannels([{ id: 'a', pos: asChan(fakePos()) }]);

    sendLocalPos(P, Q);

    expect(remotePosCalls).toHaveLength(1);
    const r = remotePosCalls[0] as { id: string; pos: number[]; from: string; p: number[]; q: number[] };
    expect(r.from).toBe('H');
    expect(r.id).toBe('H');
    expect(r.p).toEqual(P);
    expect(r.q).toEqual(Q);
  });

  it('guest role: writes ONLY to the guest own pos-channel with from === guestSelfId', () => {
    const conn = useConnectionStore();
    conn.setRole('guest');
    conn.setSelfId('g1');

    const gh = fakePos(); // guest→host channel
    _testInstallGuestPos(asChan(gh));
    // a peer sitting in the HOST's guest map must NOT receive the guest's send
    // (relaying to other guests is the host's job on inbound `pos`).
    const peer = fakePos();
    _testInstallGuestChannels([{ id: 'a', pos: asChan(peer) }]);

    sendLocalPos([5, 6, 7], Q);

    expect(gh.sent).toHaveLength(1);
    expect(peer.sent).toHaveLength(0);
    const e = parseSent(gh.sent[0]);
    expect(e.from).toBe('g1');
    expect(e.t).toBe('pos');
    expect(e.d.p).toEqual([5, 6, 7]);
    expect(e.d.q).toEqual(Q);
  });

  it('guest role: does NOT self-emit remotePos (host relays on inbound)', () => {
    const conn = useConnectionStore();
    conn.setRole('guest');
    conn.setSelfId('g1');
    _testInstallGuestPos(asChan(fakePos()));

    sendLocalPos(P, Q);

    expect(remotePosCalls).toHaveLength(0);
  });

  it('solo role: zero peers ⇒ host-path fan-out is a no-op, but remotePos still fires', () => {
    const conn = useConnectionStore();
    conn.setRole('solo');
    conn.setSelfId('H');
    _testInstallGuestChannels([]); // no peers

    sendLocalPos(P, Q); // must not throw
    expect(remotePosCalls).toHaveLength(1);
  });
});

describe('M3F sendLocalPos — buffer-pressure (bufferedAmountLow, §4.5/§5)', () => {
  it('when a peer pos-channel bufferedAmount ≥ BUFFER_HIGH, bufferedAmountLow is invoked and the send is deferred (not dropped)', async () => {
    const conn = useConnectionStore();
    conn.setRole('host');
    conn.setSelfId('H');

    const bf = fakePos({ bufferedAmount: BUFFER_HIGH }); // exactly high-water
    _testInstallGuestChannels([{ id: 'a', pos: asChan(bf) }]);

    sendLocalPos(P, Q);

    // not sent immediately…
    expect(bf.sent).toHaveLength(0);
    // …but the backpressure helper ran: threshold armed + listener registered
    expect(bf.bufferedAmountLowThreshold).toBe(BUFFER_LOW_THRESHOLD);
    expect(bf._h.has('bufferedamountlow')).toBe(true);

    // simulate the channel draining below the low-water mark
    bf.bufferedAmount = 0;
    bf.fire('bufferedamountlow');
    // the deferred `.then(send)` runs on the microtask queue
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(bf.sent).toHaveLength(1);
    const e = parseSent(bf.sent[0]);
    expect(e.from).toBe('H');
    expect(e.d.p).toEqual(P);
  });

  it('under high-water (BUFFER_HIGH - 1) the send is immediate (no deferral)', () => {
    const conn = useConnectionStore();
    conn.setRole('host');
    conn.setSelfId('H');

    const ok = fakePos({ bufferedAmount: BUFFER_HIGH - 1 });
    _testInstallGuestChannels([{ id: 'a', pos: asChan(ok) }]);

    sendLocalPos(P, Q);

    expect(ok.sent).toHaveLength(1);
    expect(ok._h.has('bufferedamountlow')).toBe(false);
  });

  it('fanOutPosTo skips closed channels and never throws', () => {
    const open1 = fakePos();
    const closed = fakePos({ readyState: 'closed' });
    const open2 = fakePos();
    fanOutPosTo([asChan(open1), asChan(closed), asChan(open2)], makeEnv('pos', 'H', { p: P, q: Q }));
    expect(open1.sent).toHaveLength(1);
    expect(open2.sent).toHaveLength(1);
    expect(closed.sent).toHaveLength(0);
  });
});

describe('M3F sendLocalPos — "no second gate" (M4 owns the move-gate)', () => {
  it('host: sends on EVERY call — identical transforms are NOT deduped', () => {
    const conn = useConnectionStore();
    conn.setRole('host');
    conn.setSelfId('H');
    const g = fakePos();
    _testInstallGuestChannels([{ id: 'a', pos: asChan(g) }]);

    sendLocalPos(P, Q);
    sendLocalPos(P, Q); // identical — M4 would gate this; we must not
    sendLocalPos(P, Q);

    expect(g.sent).toHaveLength(3);
  });

  it('host: a wildly different transform is sent too — no movement threshold applied here', () => {
    const conn = useConnectionStore();
    conn.setRole('host');
    conn.setSelfId('H');
    const g = fakePos();
    _testInstallGuestChannels([{ id: 'a', pos: asChan(g) }]);

    sendLocalPos([0, 0, 0], Q);
    sendLocalPos([1000, 0, 0], Q); // huge translate — M4's gate, not ours
    sendLocalPos([0, 0, 0], [1, 0, 0, 0]); // huge rotate

    expect(g.sent).toHaveLength(3);
  });

  it('guest: sends on every call too — no internal movement drop', () => {
    const conn = useConnectionStore();
    conn.setRole('guest');
    conn.setSelfId('g1');
    const gh = fakePos();
    _testInstallGuestPos(asChan(gh));

    sendLocalPos(P, Q);
    sendLocalPos(P, Q);

    expect(gh.sent).toHaveLength(2);
  });

  it('explicit p,q are used — sendLocalPos does NOT re-read any camera', () => {
    const conn = useConnectionStore();
    conn.setRole('host');
    conn.setSelfId('H');
    const g = fakePos();
    _testInstallGuestChannels([{ id: 'a', pos: asChan(g) }]);

    sendLocalPos([42, 7, -3], [0.1, 0.2, 0.3, 0.4]);
    const e = parseSent(g.sent[0]);
    expect(e.d.p).toEqual([42, 7, -3]);
    expect(e.d.q).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});

describe('M3F sendLocalPos — existing seams preserved', () => {
  it('emitRemotePos is still exported + callable (M3 relay hook unchanged)', () => {
    expect(typeof emitRemotePos).toBe('function');
    engine.events.clear();
    trackRemotePos();
    emitRemotePos('H', P, Q);
    expect(remotePosCalls).toHaveLength(1);
  });

  it('_dispatchGuestPos is the guest-side chute (host sends env via sendLocalPos)', () => {
    expect(typeof _dispatchGuestPos).toBe('function');
  });

  it('stopLocalPosStream is exported and is a safe no-op teardown idiom', () => {
    expect(typeof stopLocalPosStream).toBe('function');
    expect(() => stopLocalPosStream()).not.toThrow();
  });
});