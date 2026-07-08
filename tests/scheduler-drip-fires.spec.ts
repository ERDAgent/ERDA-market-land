// tests/scheduler-drip-fires.spec.ts — F4B regression guard.
//
// Root cause of "no live data appears": M1F changed `cadenceFor('finnhub')` to
// return the FULL round-robin cycle (`numFinnhubRouted × FINNHUB_DRIP_MS` ≈
// 285000 ms) for staleness. But `tickLane` grouped instruments by that same
// `cadenceFor` value, so `tickLane(FINNHUB_DRIP_MS = 3000)` matched NO finnhub
// instrument (285000 ≠ 3000) — meaning NO finnhub fetch ever fired, prime or
// drip, since M1F merged. The M1F suite only checked staleness math, not the
// drip-fires path, so the regression hid.
//
// F4B fix: split the TICK cadence (`tickCadenceFor`, per-fetch) from the STALE
// cadence (`cadenceFor`, full cycle). `tickLane` now groups by
// `tickCadenceFor`, so `tickLane(FINNHUB_DRIP_MS)` actually matches finnhub
// instruments and the fetch fires.
//
// This suite drives the real scheduler `start()` (rAF bridged to setTimeout so
// fake timers drive the loop; performance.now() is fake-timer-mocked) with a
// RECORDING fake finnhub provider (no network) + a stub key, advances the
// clock, and asserts `fetchQuotes` is actually called:
//   1. Prime fires the first finnhub fetch immediately at start (t=0, inside
//      the first FINNHUB_DRIP_MS window) — the Admiral's "live ~0s" expectation.
//   2. A second fetch fires after advancing one drip cadence (the lane re-fires).
//   3. With NO key, finnhub never fires (routes to simulated) — guard against
//      a false positive where the sim lane accidentally satisfies the assertion.
//
// No real API key; the stub key is a literal non-secret string.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scheduler } from '../src/data/scheduler';
import { FINNHUB_DRIP_MS } from '../src/config/net';
import type { Instrument, Quote, QuoteProvider } from '../src/net/protocol';

/** Recording finnhub provider — counts fetchQuotes invocations (no network). */
class RecordingFinnhub implements QuoteProvider {
  readonly id = 'finnhub' as const;
  calls = 0;
  supports(): boolean {
    return true;
  }
  async fetchQuotes(batch: Instrument[]): Promise<Quote[]> {
    this.calls++;
    return batch.map((i) => ({
      id: i.id,
      price: 100,
      changePct: 0,
      ts: Date.now(),
      source: 'finnhub',
      session: 'open' as const,
    }));
  }
}

/** Recording simulated provider (the no-key fallback path). */
class RecordingSim implements QuoteProvider {
  readonly id = 'simulated' as const;
  calls = 0;
  supports(): boolean {
    return true;
  }
  async fetchQuotes(batch: Instrument[]): Promise<Quote[]> {
    this.calls++;
    return batch.map((i) => ({
      id: i.id,
      price: 100,
      changePct: 0,
      ts: Date.now(),
      source: 'simulated',
      session: 'open' as const,
    }));
  }
}

function stocks(n: number): Instrument[] {
  const out: Instrument[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `s${i}`,
      ticker: `S${i}`,
      name: `Stock ${i}`,
      category: 'stock',
      district: 'tech',
      provider: 'finnhub',
      providerSymbol: `S${i}`,
      refPrice: 100,
      sizeTier: 1,
    });
  }
  return out;
}

describe('F4B drip-fires — finnhub fetch actually fires through the drip lane', () => {
  let raf: typeof globalThis.requestAnimationFrame | undefined;
  let caf: typeof globalThis.cancelAnimationFrame | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    // The scheduler loop reschedules via requestAnimationFrame, which does not
    // exist in the node test env. Bridge it to setTimeout(cb, 16) so the fake
    // timer clock (advanceTimersByTime) drives the rAF loop, and advanceTimers
    // also drives the performance.now() clock the loop gates on.
    raf = globalThis.requestAnimationFrame;
    caf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((h: number) =>
      clearTimeout(h)) as typeof cancelAnimationFrame;
  });

  afterEach(() => {
    if (raf) globalThis.requestAnimationFrame = raf;
    else delete globalThis.requestAnimationFrame;
    if (caf) globalThis.cancelAnimationFrame = caf;
    else delete globalThis.cancelAnimationFrame;
    vi.useRealTimers();
  });

  it('prime fires the first finnhub fetch immediately at start (within the first cadence window)', async () => {
    const finnhub = new RecordingFinnhub();
    const sim = new RecordingSim();
    const s = new Scheduler({
      manifest: stocks(3),
      providers: [finnhub, sim],
      finnhubKey: 'stub-key',
    });
    s.start();
    // Flush the async prime `tickLane(FINNHUB_DRIP_MS)` microtask chain at t=0
    // (well inside the first FINNHUB_DRIP_MS window) — no clock advance needed.
    await vi.advanceTimersByTimeAsync(0);
    expect(finnhub.calls).toBeGreaterThanOrEqual(1);
    s.stop();
  });

  it('a second finnhub fetch fires after advancing one FINNHUB_DRIP_MS drip', async () => {
    const finnhub = new RecordingFinnhub();
    const sim = new RecordingSim();
    const s = new Scheduler({
      manifest: stocks(3),
      providers: [finnhub, sim],
      finnhubKey: 'stub-key',
    });
    s.start();
    // Prime fires at t=0; the finnhub lane's next gate is one cadence later,
    // so advancing past FINNHUB_DRIP_MS must re-fire the lane through the loop.
    await vi.advanceTimersByTimeAsync(FINNHUB_DRIP_MS + 50);
    expect(finnhub.calls).toBeGreaterThanOrEqual(2);
    s.stop();
  });

  it('with NO key, finnhub never fires (instruments route to simulated)', async () => {
    const finnhub = new RecordingFinnhub();
    const sim = new RecordingSim();
    const s = new Scheduler({
      manifest: stocks(3),
      providers: [finnhub, sim],
      finnhubKey: '',
    });
    s.start();
    await vi.advanceTimersByTimeAsync(FINNHUB_DRIP_MS + 50);
    expect(finnhub.calls).toBe(0);
    // Sanity: the simulated fallback actually took the instruments.
    expect(sim.calls).toBeGreaterThanOrEqual(1);
    s.stop();
  });
});