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

import { _testSetPc, _testFireConnectionStateChange } from '../src/net/guest';
import { RECONNECT_GRACE_MS } from '../src/net/host';
import { useConnectionStore } from '../src/stores/connection';

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
