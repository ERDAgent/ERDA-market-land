// src/data/scheduler.ts — §5.5 local market-data scheduler.
//
// Host/solo only — started by the market bridge once on world mount. Discovers
// QuoteProviders via `import.meta.glob('./providers/*.ts', {eager:true})`, routes
// instruments to providers by priority (coingecko→crypto; finnhub→non-crypto if
// present & has key; simulated as universal fallback), and ticks each on its
// cadence from `config/net.ts`.
//
// Guard bursts against tab-refocus with elapsed-time checks (performance.now),
// NOT naive setInterval. After each batch/drip, changed Quotes go into a dirty
// set; a flusher applies the delta and invokes the `onDelta` sink at most once
// per second (the wire fan-out is M5 — this file sends NOTHING over a network;
// `scheduler.snapshot()` exists purely as the LOCAL resync hook M5 welcome /
// broadcast will consume).
//
// Staleness: an instrument not refreshed in > STALE_MULT × its cadence is
// flagged `stale: true` on the next emitted quote.
//
// M1 reality: coingecko/finnhub provider modules do not exist yet (M2), so the
// glob returns only the simulated provider and everything routes to it. That is
// the intended solo-only demo path. Implement the finnhub drip cadence in the
// loop anyway (idle-skip absent providers — no error).

import type { Instrument, Quote, QuoteProvider } from '../net/protocol';
import {
  COINGECKO_INTERVAL_MS,
  FINNHUB_DRIP_MS,
  FINNHUB_MAX_PER_MIN,
  SIM_TICK_MS,
  QUOTES_RESYNC_MS,
  STALE_MULT,
} from '../config/net';
import { instruments as DEFAULT_MANIFEST } from './manifest/validate';

export interface SchedulerOptions {
  /** Sink invoked with merged-delta `Quote[]` at most once per second. */
  onDelta?: (quotes: Quote[]) => void;
  /** Sink invoked on the full-resync cadence with the complete `Quote[]` snapshot. */
  onFull?: (quotes: Quote[]) => void;
  /** Override the manifest (tests); defaults to the frozen roster. */
  manifest?: Instrument[];
  /** Finnhub API key (M2 reads settings); at M1 absent ⇒ finnhub skipped. */
  finnhubKey?: string;
  /** Force Simulated for everything even if coingecko is present (demo mode). */
  forceSimulated?: boolean;
  /** Inject providers directly (tests); defaults to glob discovery. */
  providers?: QuoteProvider[];
}

interface Route {
  provider: QuoteProvider;
  cadence: number; // ms between ticks
  /** Rolling 60s call counter (finnhub cap). */
  calls: number[];
  lastFullTick: number;
}

const PROVIDER_MODS = import.meta.glob('./providers/*.ts', { eager: true }) as Record<
  string,
  { default?: QuoteProvider }
>;

function discoverProviders(): QuoteProvider[] {
  const out: QuoteProvider[] = [];
  for (const m of Object.values(PROVIDER_MODS)) {
    const p = m?.default;
    if (p && typeof p.id === 'string') out.push(p);
  }
  return out;
}

export class Scheduler {
  private routes = new Map<string, QuoteProvider>();
  private intervals: Array<{ fire: number; cadence: number }> = [];
  private rafHandle = 0;
  private running = false;
  private lastNow = 0;
  private lastFlush = 0;
  private lastFullResync = 0;
  private manifest: Instrument[];
  private opts: SchedulerOptions;
  private readonly instById = new Map<string, Instrument>();
  private readonly lastRefresh = new Map<string, number>();
  /** Count of instruments routed to the Finnhub drip provider (full round-robin
   *  cycle width = this × FINNHUB_DRIP_MS). Derived from the live roster. */
  private numFinnhubRouted = 0;

  // Per-provider tick tracking — refreshed from `routes` value lookup.
  private providers: QuoteProvider[] = [];

  constructor(opts: SchedulerOptions = {}) {
    this.opts = opts;
    this.manifest = opts.manifest ?? DEFAULT_MANIFEST;
    for (const inst of this.manifest) this.instById.set(inst.id, inst);
  }

  start(): void {
    if (this.running) return;
    this.buildRoutes();
    this.running = true;
    this.lastNow = performance.now();
    this.lastFullResync = this.lastNow;
    this.lastFlush = this.lastNow;
    this.intervals = [
      { fire: this.lastNow + SIM_TICK_MS, cadence: SIM_TICK_MS }, // simulated
      { fire: this.lastNow + COINGECKO_INTERVAL_MS, cadence: COINGECKO_INTERVAL_MS }, // coingecko batch
      { fire: this.lastNow + FINNHUB_DRIP_MS, cadence: FINNHUB_DRIP_MS }, // finnhub drip
    ];
    // Prime the city immediately: emit one sim tick now so buildings/labels
    // populate before the first 5s cadence elapses. Flush as soon as the
    // quotes land (allow the next frame's coalesced flush).
    this.tickLane(SIM_TICK_MS);
    this.lastFlush = this.lastNow - 1500;
    this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  private buildRoutes(): void {
    this.providers = this.opts.providers ?? discoverProviders();
    const sim = this.providers.find((p) => p.id === 'simulated');
    const coingecko = this.providers.find((p) => p.id === 'coingecko');
    const finnhub = this.providers.find((p) => p.id === 'finnhub');
    const forceSim = this.opts.forceSimulated;
    for (const inst of this.manifest) {
      let provider: QuoteProvider | undefined;
      if (inst.category === 'crypto' && coingecko && !forceSim) provider = coingecko;
      else if (finnhub && (this.opts.finnhubKey ?? '').length > 0 && !forceSim) provider = finnhub;
      else provider = sim;
      if (provider) this.routes.set(inst.id, provider);
      else if (sim) this.routes.set(inst.id, sim);
    }
    // Derive the Finnhub drip-cycle width from the live routed roster so the
    // staleness cadence tracks the actual round-robin period
    // (numFinnhubRouted × FINNHUB_DRIP_MS ≈ 95 × 1.2 s ≈ 114 s), not a
    // hardcoded constant. Each equity only refreshes once per full cycle, so
    // the stale threshold (STALE_MULT × this) ≈ 342 s only fires on a real
    // ~5.7-min outage — live data on the ~114 s cycle reads fresh.
    this.numFinnhubRouted = 0;
    for (const p of this.routes.values()) if (p.id === 'finnhub') this.numFinnhubRouted++;
  }

  /** Full quote snapshot — the LOCAL resync hook for M5's welcome/broadcast. */
  snapshot(): Quote[] {
    // Return the most recently emitted quote per instrument, re-deriving the
    // staleness flag from each instrument's last-refresh against its cadence.
    const now = Date.now();
    const out: Quote[] = [];
    for (const q of this.emittedQuotes.values()) {
      const providerId = this.routes.get(q.id)?.id;
      const cadence = this.cadenceFor(providerId);
      const last = this.lastRefresh.get(q.id);
      const cadenceStale = last != null ? now - last > STALE_MULT * cadence : false;
      // Finnhub: union with the provider-emitted stale flag (repeated 429 /
      // network failures) so a real outage still surfaces. Crypto/Simulated
      // keep the cadence-only formula (unchanged).
      const stale = providerId === 'finnhub' ? cadenceStale || q.stale === true : cadenceStale;
      out.push({ ...q, stale });
    }
    return out;
  }

  private cadenceFor(providerId: string | undefined): number {
    switch (providerId) {
      case 'coingecko':
        return COINGECKO_INTERVAL_MS;
      case 'finnhub':
        return this.numFinnhubRouted * FINNHUB_DRIP_MS;
      default:
        return SIM_TICK_MS;
    }
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.loop);
    const now = performance.now();
    // Elapsed-time guard (NOT wall-clock setInterval): a long pause (tab
    // refocus) advances `now` but we only ever fire once per cadence tick,
    // and cap the catch-up so we don't burst dozens of ticks on refocus.
    const elapsed = now - this.lastNow;
    this.lastNow = now;

    // Tick each cadence lane. We cap catch-up to at most one fire per lane per
    // frame (so a 5-min tab-hide doesn't dump 60 sim ticks at once).
    for (const lane of this.intervals) {
      if (now >= lane.fire) {
        // Reset to the next gate from "now", not from the missed tick (avoids
        // burst catch-up).
        lane.fire = now + lane.cadence;
        this.tickLane(lane.cadence);
      }
    }

    // Once per second (coalesced): flush the dirty set into the delta sink.
    if (now - this.lastFlush >= 1000 && this.dirty.length > 0) {
      this.flushDirty();
      this.lastFlush = now;
    }

    // Full resync every QUOTES_RESYNC_MS.
    if (now - this.lastFullResync >= QUOTES_RESYNC_MS) {
      this.lastFullResync = now;
      const full = this.collectAll();
      this.opts.onFull?.(full);
    }

    void elapsed;
  };

  private dirty: Quote[] = [];
  private readonly emittedQuotes = new Map<string, Quote>();

  private async tickLane(cadence: number): Promise<void> {
    // Group the instruments owned by the providers whose cadence matches `cadence`.
    const byProvider = new Map<QuoteProvider, Instrument[]>();
    for (const inst of this.manifest) {
      const p = this.routes.get(inst.id);
      if (!p) continue;
      const provCadence = this.cadenceFor(p.id);
      if (provCadence !== cadence) continue;
      // Skip providers whose module is absent (M2) — finnhub/coingecko stay in
      // the cadence lanes only if their provider object exists. The cadence
      // lane fires but routes will only include the prov if it was discovered.
      if (p.id === 'finnhub' && !this.providers.some((q) => q.id === 'finnhub')) continue;
      if (p.id === 'coingecko' && !this.providers.some((q) => q.id === 'coingecko')) continue;
      // Rate-limit finnhub: FINNHUB_MAX_PER_MIN calls per rolling 60s.
      if (p.id === 'finnhub') {
        if (!this.finnhubOkBy()) continue;
        // Note: drip is one symbol per call; here we batch the route width.
        this.finnhubCalls.push(Date.now());
      }
      let arr = byProvider.get(p);
      if (!arr) {
        arr = [];
        byProvider.set(p, arr);
      }
      arr.push(inst);
    }
    for (const [provider, batch] of byProvider) {
      try {
        const quotes = await provider.fetchQuotes(batch);
        for (const q of quotes) {
          const q2 = this.withStaleness(q);
          this.emittedQuotes.set(q.id, q2);
          this.lastRefresh.set(q.id, q.ts);
          this.dirty.push(q2);
        }
      } catch {
        // A provider error must not take down the scheduler.
      }
    }
  }

  private finnhubCalls: number[] = [0];
  private finnhubOkBy(): boolean {
    const now = Date.now();
    this.finnhubCalls = this.finnhubCalls.filter((t) => now - t < 60_000);
    return this.finnhubCalls.length < FINNHUB_MAX_PER_MIN;
  }

  private withStaleness(q: Quote): Quote {
    const providerId = this.routes.get(q.id)?.id;
    const cadence = this.cadenceFor(providerId);
    const last = this.lastRefresh.get(q.id);
    // A freshly-emitted quote is stale only if there was a prior refresh and
    // too long elapsed before this one (the loop's tick lane already gated the
    // catch-up, so this is normally false).
    const cadenceStale = last != null && q.ts - last > STALE_MULT * cadence;
    // Finnhub: also surface the provider's own stale flag (429 / network
    // failures) so a real outage still reads stale even before the cadence
    // threshold fires. Crypto/Simulated keep the cadence-only formula.
    const stale = providerId === 'finnhub' ? cadenceStale || q.stale === true : cadenceStale;
    return { ...q, stale };
  }

  private flushDirty(): void {
    if (this.dirty.length === 0) return;
    const delta = this.dirty;
    this.dirty = [];
    this.opts.onDelta?.(delta);
  }

  private collectAll(): Quote[] {
    return Array.from(this.emittedQuotes.values());
  }
}

let singleton: Scheduler | null = null;

/** Idempotently start (or reconfigure) the singleton scheduler. */
export function startScheduler(opts: SchedulerOptions): Scheduler {
  if (singleton) return singleton;
  singleton = new Scheduler(opts);
  singleton.start();
  return singleton;
}

/** Stop + drop the singleton scheduler (tests). Idempotent. */
export function stopScheduler(): void {
  singleton?.stop();
  singleton = null;
}

/** Return the running singleton (or undefined). */
export function getScheduler(): Scheduler | undefined {
  return singleton ?? undefined;
}