// tests/guest-receive.spec.ts — M5G Gate 1: a guest's market store populates
// from the wire (welcome.quotes / quotesDelta / quotesFull) via the frozen
// `engine.api.market` seam, NOT a static M1 store import. The host→all fan-out
// (M5 bridges/quotes-broadcast.ts) reaches this guest's `handleRel`; M3 left
// the three sites as `// M5 owns quotes; M3 ignores here`. M5G wires them to
// `engine.api.market?.applyFull/applyDelta` with optional chaining.
//
// Strategy: drive the module-private `handleRel` through the `_testHandleRelEnv`
// seam (M3F convention) with a fake `engine.api.market` recorder installed on
// the real engine singleton, and assert each of the three sites fires the right
// apply method with the right payload. A second case asserts the optional
// chaining is merge-order safe: with `engine.api.market` ABSENT, none of the
// three handlers throw or crash.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { _testHandleRelEnv } from '../src/net/guest';
import { engine } from '../src/engine/core';
import { makeEnv } from '../src/net/rtc';
import { useConnectionStore } from '../src/stores/connection';
import type { Quote, MsgPayload } from '../src/net/protocol';

// `handleRel`'s `welcome` path ends by calling `startPing()`, which uses
// `window.setInterval`; node has no `window`. Stub a minimal one.
function stubWindow(): void {
  vi.stubGlobal('window', {
    setInterval: (_h: TimerHandler) => 0,
    clearInterval: (_h: number) => { /* no-op */ },
    clearTimeout: (_h: number) => { /* no-op */ },
  });
}

function q(id: string, price: number, ts: number = 1_000): Quote {
  return { id, price, changePct: 0, ts, source: 'simulated', session: '24_7' };
}

type MarketRecorder = {
  applyFull: ReturnType<typeof vi.fn>;
  applyDelta: ReturnType<typeof vi.fn>;
};

function installFakeMarket(): MarketRecorder {
  const rec: MarketRecorder = {
    applyFull: vi.fn((qs: Quote[]) => { void qs; }),
    applyDelta: vi.fn((qs: Quote[]) => { void qs; }),
  };
  (engine.api as { market?: unknown }).market = rec;
  return rec;
}

function clearMarket(): void {
  delete (engine.api as { market?: unknown }).market;
}

function welcomePayload(quotes: Quote[]): MsgPayload['welcome'] {
  return {
    selfId: 'G1',
    roster: [{ id: 'H', name: 'Host', color: '#fff', isHost: true }],
    quotes,
    manifestHash: 'deadbeef',
    chatTail: [],
    hostName: 'Host',
  };
}

describe('M5G guest receive leg (Gate 1)', () => {
  let pinia: ReturnType<typeof createPinia>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    stubWindow();
    useConnectionStore().reset();
  });

  afterEach(() => {
    clearMarket();
    vi.unstubAllGlobals();
    setActivePinia(createPinia());
  });

  it('welcome applies the host snapshot via engine.api.market.applyFull', () => {
    const rec = installFakeMarket();
    const snap = [q('btc', 100), q('eth', 50)];

    _testHandleRelEnv(makeEnv('welcome', 'H', welcomePayload(snap)));

    expect(rec.applyFull).toHaveBeenCalledTimes(1);
    expect(rec.applyFull).toHaveBeenCalledWith(snap);
    expect(rec.applyDelta).not.toHaveBeenCalled();
  });

  it('quotesDelta applies changed quotes via engine.api.market.applyDelta', () => {
    const rec = installFakeMarket();
    const delta = [q('btc', 101, 2_000)];

    _testHandleRelEnv(makeEnv('quotesDelta', 'H', { quotes: delta }));

    expect(rec.applyDelta).toHaveBeenCalledTimes(1);
    expect(rec.applyDelta).toHaveBeenCalledWith(delta);
    expect(rec.applyFull).not.toHaveBeenCalled();
  });

  it('quotesFull applies a full resync via engine.api.market.applyFull', () => {
    const rec = installFakeMarket();
    const full = [q('btc', 102, 3_000), q('eth', 51, 3_000)];

    _testHandleRelEnv(makeEnv('quotesFull', 'H', { quotes: full }));

    expect(rec.applyFull).toHaveBeenCalledTimes(1);
    expect(rec.applyFull).toHaveBeenCalledWith(full);
    expect(rec.applyDelta).not.toHaveBeenCalled();
  });

  it('welcome defaults to [] when host sent no quotes field', () => {
    const rec = installFakeMarket();
    const p = welcomePayload([]);
    // simulate an absent `quotes` key (older host) by deleting it
    const loose = { ...p, quotes: undefined } as unknown as MsgPayload['welcome'];

    _testHandleRelEnv(makeEnv('welcome', 'H', loose));

    expect(rec.applyFull).toHaveBeenCalledWith([]);
  });

  it('is merge-order safe: with engine.api.market ABSENT, no handler throws', () => {
    clearMarket(); // no market seam installed

    expect(() => _testHandleRelEnv(makeEnv('welcome', 'H', welcomePayload([q('btc', 1)])))).not.toThrow();
    expect(() => _testHandleRelEnv(makeEnv('quotesDelta', 'H', { quotes: [q('btc', 2)] }))).not.toThrow();
    expect(() => _testHandleRelEnv(makeEnv('quotesFull', 'H', { quotes: [q('btc', 3)] }))).not.toThrow();
  });
});