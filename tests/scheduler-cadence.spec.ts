// tests/scheduler-cadence.spec.ts — Finnhub burst-then-wait staleness fix.
//
// Finnhub now bursts one symbol per FINNHUB_BURST_SPACING_MS (50 calls in
// ~12.5 s) then waits FINNHUB_CYCLE_MS (60 s); the round-robin ring persists
// across bursts so each equity refreshes at least once per two cycles. The
// STALENESS cadence is the full cycle FINNHUB_CYCLE_MS (NOT the per-fetch
// spacing), so the stale threshold is `STALE_MULT × FINNHUB_CYCLE_MS` ≈ 180 s
// — otherwise every equity reads `stale:true` between bursts even when live.
//
// Drives the live scheduler routes with a fake Finnhub provider and asserts:
//   1. `cadenceFor('finnhub')` returns FINNHUB_CYCLE_MS (the burst cycle);
//   2. equities stay fresh when elapsed-since-last-refresh is between the old
//      per-spacing threshold and the new ~180 s threshold (the live cycle);
//   3. equities go stale once elapsed > STALE_MULT × FINNHUB_CYCLE_MS (~180 s);
//   4. the provider's own `stale` flag (429 / network) still surfaces on the
//      quote even when the cadence-derived flag is fresh.

import { describe, it, expect } from 'vitest';
import { Scheduler } from '../src/data/scheduler';
import type { Instrument, Quote, QuoteProvider } from '../src/net/protocol';
import { FINNHUB_CYCLE_MS, STALE_MULT, SIM_TICK_MS, COINGECKO_INTERVAL_MS } from '../src/config/net';

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

const N = 95; // acceptance-mandated roster size → burst wraps within FINNHUB_MAX_PER_MIN
const CYCLE_MS = FINNHUB_CYCLE_MS; // 60000 ms
const THRESHOLD_MS = STALE_MULT * CYCLE_MS; // ≈ 180000 ms

describe('M1F Finnhub drip-cadence staleness', () => {
  it('cadenceFor(finnhub) = FINNHUB_CYCLE_MS (the burst cycle, not the per-fetch spacing)', () => {
    const s = new Scheduler({
      manifest: stocks(N),
      providers: [new FakeFinnhub()],
      finnhubKey: 'test',
    });
    (s as any).buildRoutes();
    // 95 stocks routed to finnhub → numFinnhubRouted === N (kept for diagnostics)
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

  it('equities are NOT stale mid-cycle (elapsed > per-spacing threshold but < ~180 s threshold)', () => {
    const s = new Scheduler({
      manifest: stocks(N),
      providers: [new FakeFinnhub()],
      finnhubKey: 'test',
    });
    (s as any).buildRoutes();
    const now = Date.now();
    // Prior refresh happened ~one full cycle ago (the next burst just re-fired).
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
    // 60 s elapsed > a per-fetch-spacing stale threshold would've been, but
    // < new ~180 s threshold ⇒ fresh.
    expect(now - (now - CYCLE_MS)).toBe(CYCLE_MS);
    expect(CYCLE_MS).toBeLessThan(THRESHOLD_MS);
    expect(out.stale).toBe(false);
  });

  it('equities DO go stale once elapsed > STALE_MULT × FINNHUB_CYCLE_MS', () => {
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