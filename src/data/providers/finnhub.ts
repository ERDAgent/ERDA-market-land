// src/data/providers/finnhub.ts — §5.3 Finnhub QuoteProvider (equities / ETFs).
//
// Self-registering via the scheduler's `import.meta.glob('./providers/*.ts')`:
// this module's default export is a `QuoteProvider` instance whose `id` is
// 'finnhub'. One HTTP call per symbol (`/quote?symbol=…&token=…`); the
// scheduler drips batches on FINNHUB_DRIP_MS and caps at FINNHUB_MAX_PER_MIN.
//
// We pace ourselves round-robin to honor that budget even when the scheduler
// hands us the whole finnhub-routed roster per drip: each `fetchQuotes` call
// advances exactly one instrument (the next in the round-robin ring) and
// returns its single Quote. At FINNHUB_DRIP_MS≈1200ms that is ≤50 calls/min
// and a full cycle over N equities ≈ N×1.2s (≈2 min for the ~95-name roster).
//
// Key handling: read from `useSettingsStore.finnhubKey` — localhost only,
// never transmitted to peers (this module never imports net/*). `supports`
// returns true for non-crypto instruments ONLY when a key is present AND
// demo-mode is off; otherwise the scheduler routes them to Simulated (crypto
// stays CoinGecko). On HTTP 429 we pause 60 s, then resume where the ring
// left off (no catch-up burst). A broken/non-2xx fetch surfaces `status:'down'`
// and keeps the last known price so labels don't blank out on a transient blip.
//
// `session`: US regular-hours check (Mon–Fri 09:30–16:00 America/New_York)
// via `Intl.DateTimeFormat`; holidays are NOT handled (README TODO for M5).
// Closed ⇒ emitted quotes carry `session:'closed'`. `marketCap` comes from the
// manifest's `mcapUSD` — we never spend budget on profile endpoints.

import type { Instrument, Quote, QuoteProvider } from '../../net/protocol';
import { useSettingsStore } from '../../stores/settings';

export type FinnhubStatus = 'ok' | 'no-key' | 'rate-limited' | 'down';

const FINNHUB_BASE = 'https://finnhub.io/api/v1/quote';
/** Rolling pause after a 429 (§5.3). */
const RATE_LIMIT_PAUSE_MS = 60_000;
/** A quote is stale (provider-side view) when older than this since last ok fetch. */
const STALE_AFTER_MS = 200_000;

interface FhState {
  /** Last known good price, used as the "keep last known" fallback for dp math + down. */
  price: number;
  changePct: number;
  marketCap?: number;
  lastOkTs: number;
}

/**
 * Pure changePct derivation from a Finnhub `/quote` payload (§5.3).
 *
 * Rules, in order:
 *   1. `dp` valid (finite, non-null, non-zero) → use `dp`.
 *   2. Else, if `c` and `pc` are finite & non-zero → `((c / pc) − 1) × 100`.
 *      (This covers the after-hours `c===pc` degenerate case, yielding 0, and
 *       the genuine `c!==pc` case where finnhub omitted `dp`.)
 *   3. Else keep `lastKnown` (so a freshly-listed / all-zero payload does not
 *      reset the day-change to a misleading value).
 *
 * `dp===0` is treated as degenerate because finnhub returns 0 (not null) for
 * many after-hours / premarket payloads where the real change is better read
 * from `(c/pc − 1)`.
 */
export function computeChangePct(
  c: number | null,
  dp: number | null,
  pc: number | null,
  lastKnown: number | null,
): number {
  if (typeof dp === 'number' && Number.isFinite(dp) && dp !== 0) return dp;
  if (
    typeof c === 'number' &&
    Number.isFinite(c) &&
    c !== 0 &&
    typeof pc === 'number' &&
    Number.isFinite(pc) &&
    pc !== 0
  ) {
    return (c / pc - 1) * 100;
  }
  if (typeof lastKnown === 'number' && Number.isFinite(lastKnown)) return lastKnown;
  return 0;
}

/**
 * US regular-equity session check (§5.3), via `Intl.DateTimeFormat` against the
 * America/New_York zone. Holidays are intentionally ignored (README TODO for M5).
 * Exposed for unit tests so a synthetic clock can drive `session:'closed'`.
 */
export function usMarketSession(now: Date = new Date()): 'open' | 'closed' {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  const wd = parts.weekday;
  if (wd === 'Sat' || wd === 'Sun') return 'closed';
  // hour12:false emits "24" at midnight on some runtimes; normalize to 0.
  let h = parseInt(parts.hour ?? '0', 10);
  if (h === 24) h = 0;
  const m = parseInt(parts.minute ?? '0', 10);
  const mins = h * 60 + m;
  return mins >= 570 && mins < 960 ? 'open' : 'closed'; // 09:30–16:00 ET
}

class FinnhubProvider implements QuoteProvider {
  readonly id = 'finnhub' as const;

  private readonly state = new Map<string, FhState>();
  /** Round-robin ring pointer into the currently-routed instrument set. */
  private ring: string[] = [];
  private ringIdx = 0;
  /** Wall-clock ms until we may call Finnhub again after a 429 (resume-in-place). */
  private pausedUntil = 0;
  private _status: FinnhubStatus = 'no-key';
  private consecutiveFailures = 0;

  /** Snapshot status the scheduler/banner reads (§5.5 — do not mutate from outside). */
  get status(): FinnhubStatus {
    // If a no-key state later gains a key, the next fetch lifts us to ok/down.
    return this._status;
  }

  /** Number of consecutive fetch failures (banner staleness timing; §5.2 spirit). */
  get failureCount(): number {
    return this.consecutiveFailures;
  }

  supports(inst: Instrument): boolean {
    if (inst.provider !== 'finnhub' || inst.category === 'crypto') return false;
    const s = this.keyAndDemo();
    // present-provider-first (key present, demo off) — else scheduler routes to Sim.
    return s.hasKey && !s.demo;
  }

  private keyAndDemo(): { hasKey: boolean; demo: boolean; key: string } {
    let key = '';
    let demo = false;
    try {
      const s = useSettingsStore();
      key = (s.finnhubKey ?? '').trim();
      demo = Boolean(s.demoMode);
    } catch {
      // No active pinia (tests/SSR): treat as no-key rather than throw.
      key = '';
      demo = false;
    }
    return { hasKey: key.length > 0, demo, key };
  }

  /**
   * One Finnhub call per invocation (round-robin). The scheduler drips this on
   * FINNHUB_DRIP_MS, so total calls/min ≈ 60000/FINNHUB_DRIP_MS (≤50). A full
   * refresh cycle for N equities ≈ N × FINNHUB_DRIP_MS.
   */
  async fetchQuotes(batch: Instrument[]): Promise<Quote[]> {
    const out: Quote[] = [];
    if (batch.length === 0) return out;

    const { hasKey, demo, key } = this.keyAndDemo();
    if (!hasKey || demo) {
      this._status = 'no-key';
      return out; // scheduler routes these to Simulated; nothing to do here
    }

    // Rebuild / sync the round-robin ring whenever the routed set changes shape.
    this.syncRing(batch);

    // Honor a 429 pause (resume in place — no catch-up burst).
    if (Date.now() < this.pausedUntil) {
      this._status = 'rate-limited';
      return out;
    }

    const inst = this.ring[this.ringIdx % this.ring.length];
    this.ringIdx = (this.ringIdx + 1) % this.ring.length;
    if (!inst) return out;

    const instrument = batch.find((b) => b.id === inst) ?? this.lastInstrumentFor(inst);
    if (!instrument) return out;

    const sym = instrument.providerSymbol;
    const url = `${FINNHUB_BASE}?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`;
    let resp: Response;
    try {
      resp = await fetch(url, { cache: 'no-store' });
    } catch {
      // network down / offline → keep last known, mark stale-on-failure count.
      this.recordFailure();
      this._status = 'down';
      return this.emitStaleKnown(instrument);
    }

    if (resp.status === 429) {
      this.pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
      this._status = 'rate-limited';
      return this.emitStaleKnown(instrument);
    }
    if (!resp.ok) {
      this.recordFailure();
      this._status = 'down';
      return this.emitStaleKnown(instrument);
    }

    let json: unknown;
    try {
      json = await resp.json();
    } catch {
      this.recordFailure();
      this._status = 'down';
      return this.emitStaleKnown(instrument);
    }

    const q = json as Record<string, unknown> | null;
    const c = num(q?.c);
    const dp = numOrNull(q?.dp);
    const pc = numOrNull(q?.pc);
    const t = numOrNull(q?.t);

    // Price 0 + null often means finnhub has no data for this ticker yet.
    if (c === null || !Number.isFinite(c as number)) {
      this.recordFailure();
      this._status = this.consecutiveFailures >= 3 ? 'down' : 'ok';
      return this.emitStaleKnown(instrument);
    }

    const st = this.ensureState(instrument);
    const lastKnown = st.changePct;
    const changePct = computeChangePct(c, dp, pc, lastKnown);
    st.price = c as number;
    st.changePct = changePct;
    st.lastOkTs = Date.now();
    this.consecutiveFailures = 0;
    this._status = 'ok';

    const ts = t != null && Number.isFinite(t as number) ? (t as number) * 1000 : Date.now();
    const session = usMarketSession(new Date(ts));
    const stale = Date.now() - st.lastOkTs > STALE_AFTER_MS;
    out.push({
      id: instrument.id,
      price: st.price,
      changePct,
      marketCap: instrument.mcapUSD,
      ts,
      source: 'finnhub',
      session,
      stale,
    });
    return out;
  }

  private lastInstrumentFor(id: string): Instrument | undefined {
    void id;
    return undefined;
  }

  private ensureState(inst: Instrument): FhState {
    let s = this.state.get(inst.id);
    if (!s) {
      s = {
        price: inst.refPrice,
        changePct: 0,
        marketCap: inst.mcapUSD,
        lastOkTs: 0,
      };
      this.state.set(inst.id, s);
    }
    return s;
  }

  private syncRing(batch: Instrument[]): void {
    const ids = batch.map((b) => b.id).sort();
    const same =
      ids.length === this.ring.length &&
      ids.every((id, i) => this.ring[i] === id);
    if (!same) {
      this.ring = ids;
      // Keep the pointer in range; resume roughly where we were.
      if (this.ringIdx >= this.ring.length) this.ringIdx = 0;
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
  }

  /** Emit the last known price tagged stale after a transient failure. */
  private emitStaleKnown(inst: Instrument): Quote[] {
    const s = this.ensureState(inst);
    s.lastOkTs = s.lastOkTs || 0;
    const stale = Date.now() - s.lastOkTs > STALE_AFTER_MS || s.lastOkTs === 0;
    return [
      {
        id: inst.id,
        price: s.price,
        changePct: s.changePct,
        marketCap: inst.mcapUSD,
        ts: Date.now(),
        source: 'finnhub',
        session: usMarketSession(),
        stale,
      },
    ];
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}
function numOrNull(v: unknown): number | null {
  // finnhub legitimately returns null for absent fields.
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/** Self-registering default export discovered by the scheduler glob. */
export default new FinnhubProvider();