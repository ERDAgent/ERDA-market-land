// tests/no-api-on-guest.spec.ts — §5 / §16 THE gate: a guest makes ZERO API
// calls. M1's `src/bridges/market.ts` starts `startScheduler()` at world mount,
// which builds provider routes + primes a sim tick → provider `fetchQuotes`
// fires. M5 adds a 2-line role-guard so the market bridge skips
// `startScheduler()` when `connection.role === 'guest'` (the scheduler's
// providers — CoinGecko/Finnhub/Simulated — then never instantiate on a guest
// ⇒ no outbound fetch). Solo/host roles still start the scheduler.
//
// The market store, engine.api.market seam, watches + pick wiring still run on
// a guest (so welcome.quotes / quotesDelta / quotesFull can populate the store
// over the wire) — only the fetch loop is suppressed.
//
// Strategy: mock every provider default export with a counting fetchQuotes,
// stub `requestAnimationFrame` (the scheduler loop) to a no-op so a solo/host
// start is test-safe in node, drive the live market bridge default export with
// each role, and assert fetch call counts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// --- hoisted counters (vi.mock factories close over these via vi.hoisted) -------
const counters = vi.hoisted(() => ({ simulated: 0, coingecko: 0, finnhub: 0 }));

vi.mock('../src/data/providers/simulated.ts', () => ({
  default: {
    id: 'simulated',
    supports: () => true,
    fetchQuotes: async (batch: unknown[]) => {
      counters.simulated++;
      void batch;
      return [];
    },
  },
}));
vi.mock('../src/data/providers/coingecko.ts', () => ({
  default: {
    id: 'coingecko',
    supports: () => true,
    fetchQuotes: async (batch: unknown[]) => {
      counters.coingecko++;
      void batch;
      return [];
    },
  },
}));
vi.mock('../src/data/providers/finnhub.ts', () => ({
  default: {
    id: 'finnhub',
    supports: () => true,
    fetchQuotes: async (batch: unknown[]) => {
      counters.finnhub++;
      void batch;
      return [];
    },
  },
}));

// The scheduler's rAF loop must not run in node; stub to a no-op so solo/host
// start (which calls start() → requestAnimationFrame) is observable without
// crashing. The prime `tickLane(SIM_TICK_MS)` is a fire-and-forget await that
// resolves on the microtask queue — that is what we count.
let rafCount = 0;
beforeEach(() => {
  setActivePinia(createPinia());
  counters.simulated = 0;
  counters.coingecko = 0;
  counters.finnhub = 0;
  rafCount = 0;
  vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback): number => {
    rafCount++;
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', (_h: number): void => { /* no-op */ });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function importBridge(): Promise<{ default: (e: unknown) => void }> {
  return (await import('../src/bridges/market.ts')) as unknown as {
    default: (e: unknown) => void;
  };
}

function makeEngine(): { api: Record<string, unknown>; events: { on: () => () => void } } {
  return {
    api: {},
    events: {
      on: () => () => { /* off */ },
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  // Let the scheduler's prime tickLane(SIM_TICK_MS) await chain resolve.
  await new Promise<void>((r) => setTimeout(r, 5));
}

describe('M5 no-api-on-guest (§5 / §16)', () => {
  it('guest role: mounting the market bridge makes ZERO provider fetch calls', async () => {
    const { useConnectionStore } = await import('../src/stores/connection');
    const conn = useConnectionStore();
    conn.setRole('guest');
    conn.setSelfId('g1');

    const bridge = await importBridge();
    bridge.default(makeEngine());
    await flushMicrotasks();

    expect(counters.simulated).toBe(0);
    expect(counters.coingecko).toBe(0);
    expect(counters.finnhub).toBe(0);
    expect(rafCount).toBe(0);
  });

  it('solo role: the scheduler starts and the simulated provider is fetched at least once (prime tick)', async () => {
    const { useConnectionStore } = await import('../src/stores/connection');
    const conn = useConnectionStore();
    conn.setRole('solo');
    conn.setSelfId('H');

    const bridge = await importBridge();
    bridge.default(makeEngine());
    await flushMicrotasks();

    expect(counters.simulated).toBeGreaterThanOrEqual(1);
    expect(rafCount).toBeGreaterThanOrEqual(1);
  });

  it('host role: the scheduler starts (host is the data authority) and fetches fire', async () => {
    const { useConnectionStore } = await import('../src/stores/connection');
    const conn = useConnectionStore();
    conn.setRole('host');
    conn.setSelfId('H');

    const bridge = await importBridge();
    bridge.default(makeEngine());
    await flushMicrotasks();

    expect(counters.simulated).toBeGreaterThanOrEqual(1);
    expect(rafCount).toBeGreaterThanOrEqual(1);
  });

  it('guest role: engine.api.market seam is still installed (welcome.quotes can populate the store)', async () => {
    const { useConnectionStore } = await import('../src/stores/connection');
    const conn = useConnectionStore();
    conn.setRole('guest');
    conn.setSelfId('g1');

    const eng = makeEngine();
    const bridge = await importBridge();
    bridge.default(eng);
    await flushMicrotasks();

    expect(eng.api.market).toBeDefined();
    expect(counters.simulated).toBe(0);
  });
});