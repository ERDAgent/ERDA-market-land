// src/data/providers/simulated.ts — §5.4 Simulated QuoteProvider.
//
// Per-instrument geometric random walk, ticked every 5 s by the scheduler.
// Self-registering via the scheduler's `import.meta.glob('./providers/*.ts')`:
// this module's default export is a `QuoteProvider` instance.
//
//   seed      price = refPrice (manifest); sessionOpen = first price of the run;
//   changePct = (price / sessionOpen − 1) × 100;
//   per tick  price *= 1 + gauss() * sigma[category];
//   clamp     cumulative changePct at ±SIM_CHANGE_CLAMP_PCT;
//   quote     { source:'simulated', session:'24_7' }.
//
// `fetchQuotes(batch)` is the per-tick entry the scheduler calls; it advances
// every instrument in `batch` one step and returns the new quotes. Like all
// providers it is stateful across calls (it owns the walk state).

import type { Instrument, Quote, QuoteProvider } from '../../net/protocol';
import { SIM_SIGMA, SIM_CHANGE_CLAMP_PCT } from '../../config/net';
import { gauss } from '../../utils/gauss';

interface WalkState {
  price: number;
  sessionOpen: number;
  /** True once the first quote has been emitted (sessionOpen is locked in). */
  primed: boolean;
  marketCap?: number;
  stale: boolean;
  lastTs: number;
}

export class SimulatedProvider implements QuoteProvider {
  readonly id = 'simulated' as const;

  private readonly state = new Map<string, WalkState>();
  /** Instruments the provider will own (set when the scheduler routes them in). */
  private readonly owned = new Set<string>();

  /** Claim ownership of an instrument; seed its walk state from the manifest. */
  private ensure(inst: Instrument): WalkState {
    let s = this.state.get(inst.id);
    if (!s) {
      s = {
        price: inst.refPrice,
        sessionOpen: inst.refPrice,
        primed: false,
        marketCap: inst.mcapUSD,
        stale: false,
        lastTs: 0,
      };
      this.state.set(inst.id, s);
      this.owned.add(inst.id);
    }
    return s;
  }

  supports(_inst: Instrument): boolean {
    return true; // simulated is the universal fallback
  }

  /**
   * Advance every instrument in `batch` one tick and return the resulting
   * Quotes. The scheduler calls this on the sim cadence (SIM_TICK_MS).
   */
  async fetchQuotes(batch: Instrument[]): Promise<Quote[]> {
    const now = Date.now();
    const out: Quote[] = [];
    for (const inst of batch) {
      const s = this.ensure(inst);
      const sigma = SIM_SIGMA[inst.category] ?? 0.0005;
      // Step the geometric random walk.
      s.price = s.price * (1 + gauss() * sigma);
      if (s.price <= 0) s.price = inst.refPrice > 0 ? inst.refPrice : 1;

      let changePct = (s.price / s.sessionOpen - 1) * 100;
      // Clamp cumulative day-change at ±SIM_CHANGE_CLAMP_PCT.
      if (changePct > SIM_CHANGE_CLAMP_PCT) {
        changePct = SIM_CHANGE_CLAMP_PCT;
        // Reflect the clamp back into price so the walk can recover symmetrically.
        s.price = s.sessionOpen * (1 + SIM_CHANGE_CLAMP_PCT / 100);
      } else if (changePct < -SIM_CHANGE_CLAMP_PCT) {
        changePct = -SIM_CHANGE_CLAMP_PCT;
        s.price = s.sessionOpen * (1 - SIM_CHANGE_CLAMP_PCT / 100);
      }

      const q: Quote = {
        id: inst.id,
        price: s.price,
        changePct,
        marketCap: s.marketCap,
        ts: now,
        source: 'simulated',
        session: '24_7',
        stale: false,
      };
      out.push(q);
      s.primed = true;
      s.lastTs = now;
    }
    return out;
  }
}

/** Self-registering default export discovered by the scheduler glob. */
export default new SimulatedProvider();