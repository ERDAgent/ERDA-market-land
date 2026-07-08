// tests/scheduler-reconfigure.spec.ts — F2 reconfigure-on-key-change fix.
//
// A user who enters a Finnhub API key in Settings AFTER entering the world sees
// no live data: startScheduler snapshots `opts.finnhubKey` once at start() and
// buildRoutes() never re-runs. reconfigure() merges new opts and rebuilds the
// route map without restarting the rAF loop or resetting emitted quotes.
//
// Drives the scheduler with fake providers (no network, stub key only):
//   1. finnhubKey: '' → non-crypto instrument routes to `simulated`;
//   2. reconfigure({ finnhubKey: 'stub-key' }) → same instrument routes to
//      `finnhub`;
//   3. reconfigure({ forceSimulated: true }) → routes back to `simulated`;
//   4. reconfigure({ finnhubKey: '' }) (key removed) → back to `simulated`.
//
// No scheduler.start() is called (no rAF / performance.now in the node env);
// reconfigure() itself calls buildRoutes(), so we exercise the public API only.
// No real API key is ever used; the fake provider's fetchQuotes is a recorder.

import { describe, it, expect } from 'vitest';
import { Scheduler } from '../src/data/scheduler';
import type { Instrument, Quote, QuoteProvider } from '../src/net/protocol';

/** A finnhub-shaped fake provider. fetchQuotes is a recorder (no network). */
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

/** A simulated-shaped fake provider. */
class FakeSim implements QuoteProvider {
  readonly id = 'simulated' as const;
  supports(): boolean {
    return true;
  }
  async fetchQuotes(batch: Instrument[]): Promise<Quote[]> {
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

function stock(): Instrument {
  return {
    id: 'aapl',
    ticker: 'AAPL',
    name: 'Apple Inc.',
    category: 'stock',
    district: 'tech',
    provider: 'finnhub',
    providerSymbol: 'AAPL',
    refPrice: 100,
    sizeTier: 3,
  };
}

describe('F2 scheduler.reconfigure — rebuild routes on key/demo change', () => {
  it('with no finnhubKey, a non-crypto instrument routes to simulated', () => {
    const s = new Scheduler({
      manifest: [stock()],
      providers: [new FakeFinnhub(), new FakeSim()],
      finnhubKey: '',
    });
    // reconfigure() calls buildRoutes() — prime the route map without start().
    s.reconfigure({});
    expect(s._testRoutes().get('aapl')?.id).toBe('simulated');
  });

  it('reconfigure({ finnhubKey }) flips the equity to finnhub', () => {
    const s = new Scheduler({
      manifest: [stock()],
      providers: [new FakeFinnhub(), new FakeSim()],
      finnhubKey: '',
    });
    s.reconfigure({});
    expect(s._testRoutes().get('aapl')?.id).toBe('simulated');

    s.reconfigure({ finnhubKey: 'stub-key' });
    expect(s._testRoutes().get('aapl')?.id).toBe('finnhub');
  });

  it('reconfigure({ forceSimulated: true }) routes the equity back to simulated', () => {
    const s = new Scheduler({
      manifest: [stock()],
      providers: [new FakeFinnhub(), new FakeSim()],
      finnhubKey: 'stub-key',
    });
    s.reconfigure({});
    expect(s._testRoutes().get('aapl')?.id).toBe('finnhub');

    s.reconfigure({ forceSimulated: true });
    expect(s._testRoutes().get('aapl')?.id).toBe('simulated');
  });

  it('removing the key (reconfigure({ finnhubKey: "" })) flips finnhub back to simulated', () => {
    const s = new Scheduler({
      manifest: [stock()],
      providers: [new FakeFinnhub(), new FakeSim()],
      finnhubKey: 'stub-key',
    });
    s.reconfigure({});
    expect(s._testRoutes().get('aapl')?.id).toBe('finnhub');

    s.reconfigure({ finnhubKey: '' });
    expect(s._testRoutes().get('aapl')?.id).toBe('simulated');
  });

  it('reconfigure merges only the supplied fields (forceSimulated untouched when omitted)', () => {
    const s = new Scheduler({
      manifest: [stock()],
      providers: [new FakeFinnhub(), new FakeSim()],
      finnhubKey: '',
      forceSimulated: false,
    });
    s.reconfigure({});
    // Supply only finnhubKey; forceSimulated must remain false.
    s.reconfigure({ finnhubKey: 'stub-key' });
    expect(s._testRoutes().get('aapl')?.id).toBe('finnhub');
    expect(
      (s as unknown as { opts: { forceSimulated?: boolean } }).opts.forceSimulated,
    ).toBe(false);
  });

  it('reconfigure updates numFinnhubRouted (full round-robin cycle width tracks live roster)', () => {
    const s = new Scheduler({
      manifest: [stock(), stock2(), stock3()],
      providers: [new FakeFinnhub(), new FakeSim()],
      finnhubKey: '',
    });
    s.reconfigure({});
    expect((s as unknown as { numFinnhubRouted: number }).numFinnhubRouted).toBe(0);

    s.reconfigure({ finnhubKey: 'stub-key' });
    expect((s as unknown as { numFinnhubRouted: number }).numFinnhubRouted).toBe(3);

    s.reconfigure({ forceSimulated: true });
    expect((s as unknown as { numFinnhubRouted: number }).numFinnhubRouted).toBe(0);
  });
});

function stock2(): Instrument {
  const i = stock();
  return { ...i, id: 'msft', ticker: 'MSFT', providerSymbol: 'MSFT' };
}
function stock3(): Instrument {
  const i = stock();
  return { ...i, id: 'goog', ticker: 'GOOG', providerSymbol: 'GOOG' };
}