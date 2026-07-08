// tests/scheduler-cadence.spec.ts — M1F Finnhub drip-cadence staleness fix.
//
// The Finnhub provider drips one symbol per FINNHUB_DRIP_MS, so each equity
// only actually refreshes once per full round-robin cycle of
// `numFinnhubRouted × FINNHUB_DRIP_MS` (≈ 95 × 1.2 s ≈ 114 s). The stale
// threshold must therefore be `STALE_MULT × numFinnhubRouted × FINNHUB_DRIP_MS`
// (≈ 342 s), not the per-symbol drip interval (3.6 s) — otherwise every equity
// reads `stale:true` from the second cycle onward even when data is live.
//
// Drives the live scheduler routes with a fake Finnhub provider and asserts:
//   1. `cadenceFor('finnhub')` returns numFinnhubRouted × FINNHUB_DRIP_MS;
//   2. equities stay fresh when elapsed-since-last-refresh is between the old
//      3.6 s threshold and the new ~342 s threshold (the live ~114 s cycle);
//   3. equities go stale once elapsed > STALE_MULT × cycle (~342 s);
//   4. the provider's own `stale` flag (429 / network) still surfaces on the
//      quote even when the cadence-derived flag is fresh.

import { describe, it, expect } from 'vitest';
import { Scheduler } from '../src/data/scheduler';
import type { Instrument, Quote, QuoteProvider } from '../src/net/protocol';
import { FINNHUB_DRIP_MS, STALE_MULT, SIM_TICK_MS, COINGECKO_INTERVAL_MS } from '../src/config/net';

/** A finnhub-shaped provider that emits live (non-stale) quotes on demand. */
class FakeFinnhub implements QuoteProvider {
  readonly id = 'finnhub' as const;
  supports(): boolean {
    return true;
  }
  async fetchQuotes(batch: Instrument[]): Promise<Quote[]> {
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

/** A finnhub provider that marks every emitted quote as provider-stale. */
class StaleFinnhub implements QuoteProvider {
  readonly id = 'finnhub' as const;
  supports(): boolean {
    return true;
  }
  async fetchQuotes(batch: Instrument[]): Promise<Quote[]> {
    return batch.map((i) => ({
      id: i.id,
      price: 100,
      changePct: 0,
      ts: Date.now(),
      source: 'finnhub',
      session: 'open' as const,
      stale: true,
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

const N = 95; // acceptance-mandated roster size → ~2-min cycle
const CYCLE_MS = N * FINNHUB_DRIP_MS; // ≈ 114000 ms
const THRESHOLD_MS = STALE_MULT * CYCLE_MS; // ≈ 342000 ms

describe('M1F Finnhub drip-cadence staleness', () => {
  it('cadenceFor(finnhub) = numFinnhubRouted × FINNHUB_DRIP_MS (derived from live roster)', () => {
    const s = new Scheduler({
      manifest: stocks(N),
      providers: [new FakeFinnhub()],
      finnhubKey: 'test',
    });
    (s as any).buildRoutes();
    // 95 stocks routed to finnhub → numFinnhubRouted === N
    expect((s as any).numFinnhubRouted).toBe(N);
    expect((s as any).cadenceFor('finnhub')).toBe(CYCLE_MS);
  });

  it('cadenceFor(coingecko) and cadenceFor(simulated) are unchanged', () => {
    const s = new Scheduler({
      manifest: stocks(N),
      providers: [new FakeFinnhub()],
      finnhubKey: 'test',
    });
    (s as any).buildRoutes();
    expect((s as any).cadenceFor('coingecko')).toBe(COINGECKO_INTERVAL_MS);
    expect((s as any).cadenceFor('simulated')).toBe(SIM_TICK_MS);
    expect((s as any).cadenceFor(undefined)).toBe(SIM_TICK_MS);
  });

  it('equities are NOT stale mid-cycle (elapsed > 3.6 s but < ~342 s threshold)', () => {
    const s = new Scheduler({
      manifest: stocks(N),
      providers: [new FakeFinnhub()],
      finnhubKey: 'test',
    });
    (s as any).buildRoutes();
    const now = Date.now();
    // Prior refresh happened ~one full cycle ago (live drip just re-fired).
    (s as any).lastRefresh.set('s0', now - CYCLE_MS);
    const q: Quote = {
      id: 's0',
      price: 100,
      changePct: 0,
      ts: now,
      source: 'finnhub',
      session: 'open',
    };
    const out = (s as any).withStaleness(q) as Quote;
    // 114 s elapsed > old 3.6 s threshold but < new 342 s threshold ⇒ fresh.
    expect(now - (now - CYCLE_MS)).toBe(CYCLE_MS);
    expect(CYCLE_MS).toBeGreaterThan(3 * FINNHUB_DRIP_MS); // would've been stale pre-fix
    expect(CYCLE_MS).toBeLessThan(THRESHOLD_MS);
    expect(out.stale).toBe(false);
  });

  it('equities DO go stale once elapsed > STALE_MULT × numFinnhubRouted × FINNHUB_DRIP_MS', () => {
    const s = new Scheduler({
      manifest: stocks(N),
      providers: [new FakeFinnhub()],
      finnhubKey: 'test',
    });
    (s as any).buildRoutes();
    const now = Date.now();
    // Last refresh ~400 s ago → past the ~342 s threshold (real outage).
    const elapsed = THRESHOLD_MS + 60_000;
    (s as any).lastRefresh.set('s0', now - elapsed);
    const q: Quote = {
      id: 's0',
      price: 100,
      changePct: 0,
      ts: now,
      source: 'finnhub',
      session: 'open',
    };
    const out = (s as any).withStaleness(q) as Quote;
    expect(elapsed).toBeGreaterThan(THRESHOLD_MS);
    expect(out.stale).toBe(true);
  });

  it('provider-side stale flag (429 / network) still surfaces on a live-fresh quote', () => {
    const s = new Scheduler({
      manifest: stocks(N),
      providers: [new StaleFinnhub()],
      finnhubKey: 'test',
    });
    (s as any).buildRoutes();
    const now = Date.now();
    // Cadence-derived staleness is FALSE (just refreshed this cycle).
    (s as any).lastRefresh.set('s0', now - 1000);
    const q: Quote = {
      id: 's0',
      price: 100,
      changePct: 0,
      ts: now,
      source: 'finnhub',
      session: 'open',
      stale: true, // provider reports repeated 429 / network failure
    };
    const out = (s as any).withStaleness(q) as Quote;
    expect(out.stale).toBe(true);
  });
});