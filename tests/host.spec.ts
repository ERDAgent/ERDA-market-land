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
  _testClearGuests,
} from '../src/net/host';
import { useConnectionStore } from '../src/stores/connection';

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
