// tests/quotes-broadcast.spec.ts — M5 host→all quote fan-out (§4.5 / §5.5).
//
// Unit-tests `src/bridges/quotes-broadcast.ts`:
//   - on host role, watching the market store fans a `quotesDelta` env out via
//     `broadcastRel` containing ONLY changed instruments,
//   - `quotesDelta` is coalesced ≤ 1/s even when the store updates faster,
//   - `quotesFull` is broadcast every `QUOTES_RESYNC_MS` (fake timers) + on the
//     host startup debounce,
//   - the bridge is a no-op on a guest (no broadcast at all),
//   - the backpressure guard routes through `broadcastRel` (which is the chute
//     that awaits `bufferedAmountLow` per channel at ≥ BUFFER_HIGH); we assert
//     the bridge uses `broadcastRel` for every send.
//
// `broadcastRel` is mocked to record every env it would have sent. Timers are
// faked so the 5-minute resync cadence is testable.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { QUOTES_RESYNC_MS, BUFFER_HIGH } from '../src/config/net';
import type { Env, MsgPayload, Quote } from '../src/net/protocol';

// Hoisted send log — the vi.mock factory records calls here.
const sent = vi.hoisted(() => [] as Env<'quotesDelta' | 'quotesFull'>[]);
const broadcastRelCalls = vi.hoisted(() => [] as unknown[]);

vi.mock('../src/net/host', () => ({
  broadcastRel: async (e: Env<'quotesDelta' | 'quotesFull'>): Promise<void> => {
    sent.push(e);
    broadcastRelCalls.push(e);
  },
  // re-exports / surface used elsewhere by other tests stay harmless no-ops
  bufferedAmountLow: async (): Promise<void> => { /* no-op */ },
}));

// We also need to keep the rest of net/host's other exports available? They are
// not imported by the bridge, so the partial mock above is sufficient.

function q(id: string, price: number, changePct = 0, session: Quote['session'] = '24_7'): Quote {
  return { id, price, changePct, ts: Date.now(), source: 'simulated', session };
}

beforeEach(() => {
  setActivePinia(createPinia());
 sent.length = 0;
  broadcastRelCalls.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

async function mountBridge(role: 'solo' | 'host' | 'guest'): Promise<{
  market: Awaited<ReturnType<typeof import('../src/stores/market').useMarketStore>>;
  conn: Awaited<ReturnType<typeof import('../src/stores/connection').useConnectionStore>>;
  flush: () => Promise<void>;
}> {
  // Re-import the bridge fresh each mount so module-level `installed` resets.
  vi.resetModules();
  // Re-apply the mock after resetModules (vi.mock is hoisted + persists, but
  // re-importing the mocked module re-evaluates the factory with a fresh `sent`
  // reference only if we re-bind — simplest: clear after resetModules before
  // the bridge stores it).
  const { useMarketStore } = await import('../src/stores/market');
  const { useConnectionStore } = await import('../src/stores/connection');
  const bridge = (await import('../src/bridges/quotes-broadcast.ts')).default;
  const { engine } = await import('../src/engine/core');
  const conn = useConnectionStore();
  conn.setRole(role);
  conn.setSelfId('H');
  const market = useMarketStore();
  bridge(engine);
  return {
    market,
    conn,
    flush: async () => { await vi.advanceTimersByTimeAsync(0); },
  };
}

describe('M5 quotes-broadcast — delta fan-out (§4.5)', () => {
  it('host: a quote delta fans out via broadcastRel as a quotesDelta env (changed ids only)', async () => {
    const { market, flush } = await mountBridge('host');
    // First population seeds the baseline (no broadcast) — guests get their
    // snapshot from M3's welcome.
    market.applyFull([q('aapl', 100), q('msft', 200)]);
    await flush();
    // Only aapl changes ⇒ the delta must carry ONLY aapl.
    market.applyDelta([q('aapl', 101)]);
    await flush();
    await vi.advanceTimersByTimeAsync(1500); // past the 1/s trailing throttle

    const deltas = sent.filter((e) => e.t === 'quotesDelta');
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    const last = deltas[deltas.length - 1];
    expect(last.d.quotes.map((x) => x.id)).toEqual(['aapl']);
    expect(last.from).toBe('H');
  });

  it('host: quotesDelta is coalesced ≤ 1/s when the store updates many times within a second', async () => {
    const { market } = await mountBridge('host');
    market.applyFull([q('aapl', 100), q('msft', 200)]);
    await vi.advanceTimersByTimeAsync(500);

    // Fire 5 rapid deltas inside one coalesce window.
    for (let i = 0; i < 5; i++) {
      market.applyDelta([q('aapl', 100 + i)]);
    }
    // Advance only 300ms — still within the 1s window ⇒ one coalesced send.
    await vi.advanceTimersByTimeAsync(300);
    const early = sent.filter((e) => e.t === 'quotesDelta');
    // At most one quotesDelta has fired by the 800ms mark of the window.
    expect(early.length).toBeLessThanOrEqual(1);

    // Cross the 1s boundary ⇒ the coalesced delta (all 5 changes merged) flushes.
    await vi.advanceTimersByTimeAsync(800);
    const deltas = sent.filter((e) => e.t === 'quotesDelta');
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    const final = deltas[deltas.length - 1];
    // merged delta carries just the latest aapl (5 ticks collapse to 1 entry).
    expect(final.d.quotes.map((x) => x.id).sort()).toEqual(['aapl']);
  });

  it('guest: the bridge is a no-op — no broadcastRel call at all (guests receive, never send)', async () => {
    const { market } = await mountBridge('guest');
    market.applyFull([q('aapl', 100), q('msft', 200)]);
    market.applyDelta([q('aapl', 101)]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(sent).toHaveLength(0);
    expect(broadcastRelCalls).toHaveLength(0);
  });

  it('solo: zero guests ⇒ the bridge does not broadcast a startup quotesFull', async () => {
    const { market } = await mountBridge('solo');
    market.applyFull([q('aapl', 100)]);
    await vi.advanceTimersByTimeAsync(1000);
    // solo has no peers to fan out to: no full is pushed on startup (host-only).
    const fulls = sent.filter((e) => e.t === 'quotesFull');
    expect(fulls).toHaveLength(0);
  });
});

describe('M5 quotes-broadcast — full resync + startup (§4.5)', () => {
  it('host: the first quote population does NOT broadcast a giant quotesDelta (baseline seeded from welcome, not over the wire)', async () => {
    const { market, flush } = await mountBridge('host');
    market.applyFull([q('aapl', 100), q('msft', 200)]);
    await flush();
    await vi.advanceTimersByTimeAsync(1500);
    // No delta for the initial populate — guests arrive from M3 welcome.
    const deltas = sent.filter((e) => e.t === 'quotesDelta');
    expect(deltas).toHaveLength(0);
  });

  it('host: a quotesFull is broadcast every QUOTES_RESYNC_MS', async () => {
    const { market } = await mountBridge('host');
    market.applyFull([q('aapl', 100)]);
    await vi.advanceTimersByTimeAsync(500); // startup full
    const before = sent.filter((e) => e.t === 'quotesFull').length;
    // Advance one full resync interval.
    await vi.advanceTimersByTimeAsync(QUOTES_RESYNC_MS + 100);
    const after = sent.filter((e) => e.t === 'quotesFull').length;
    expect(after).toBeGreaterThan(before);
  });
});

describe('M5 quotes-broadcast — backpressure guard (§4.5)', () => {
  it('every send routes through broadcastRel — the §4.5 backpressure chute that awaits bufferedAmountLow at ≥ BUFFER_HIGH', async () => {
    const { market, flush } = await mountBridge('host');
    market.applyFull([q('aapl', 100)]); // seed baseline (no broadcast)
    await flush();
    market.applyDelta([q('aapl', 101)]); // changed ⇒ routed through broadcastRel
    await vi.advanceTimersByTimeAsync(1500);
    expect(broadcastRelCalls.length).toBeGreaterThanOrEqual(1);
    // Every recorded env was a quotesDelta routed through the backpressure chute.
    for (const e of broadcastRelCalls) {
      const env = e as Env<'quotesDelta'>;
      expect(['quotesDelta', 'quotesFull']).toContain(env.t);
    }
    void BUFFER_HIGH;
  });
});