// src/data/providers/coingecko.ts — §5.2 CoinGecko QuoteProvider (crypto).
//
// Self-registering via the scheduler's `import.meta.glob('./providers/*.ts')`:
// this module's default export is a `QuoteProvider` instance whose `id` is
// 'coingecko'. One batched call per cycle against
//   /api/v3/coins/markets?vs_currency=usd&ids=<csv>&price_change_percentage=24h
// mapping current_price→price, price_change_percentage_24h→changePct,
// market_cap→marketCap, session:'24_7'. CORS-friendly, no key.
//
// On HTTP 429: exponential backoff 2× starting at COINGECKO_INTERVAL_MS, capped
// at 10 min. We surface a `status` getter ('ok'|'rate-limited'|'down') plus a
// consecutive-failure count; the scheduler drives staleness timing, but we also
// flip emitted quotes to `stale:true` after 3 consecutive failures so the
// banner/UI can react independent of the scheduler's own cadence math.
//
// "Demo-data" toggle: `supports()` returns false when demo-mode is on, so the
// scheduler's present-provider-first routing falls crypto back to Simulated.
//
// Crypto `providerSymbol` ids have been verified once against
// /api/v3/coins/list (see M2 report): all 24 manifest crypto ids are valid.

import type { Instrument, Quote, QuoteProvider } from '../../net/protocol';
import { COINGECKO_INTERVAL_MS } from '../../config/net';
import { useSettingsStore } from '../../stores/settings';

export type CoingeckoStatus = 'ok' | 'rate-limited' | 'down' | 'no-key';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3/coins/markets';

// ---- Admiral's diagnostic surface -------------------------------------------
// Console logs tagged `eml:coingecko` are the Admiral's DevTools window into
// the (sparse, once-per-60s) crypto batch. `{@code →}` before the fetch, `{@code ←}`
// on a 2xx with the quote count, `{@code ✗}` on every failure (429 / non-ok /
// network / parse / non-array). Coingecko needs no key, so no redaction here;
// never log a key value regardless. Do not delete in a future refactor — this
// is a diagnostic, not telemetry.
/** Exponential-backoff cap (§5.2: 2×, cap 10 min). */
const BACKOFF_CAP_MS = 10 * 60_000;
/** Stale-after-N-fails (§5.2: surface consecutive-failure count → stale after 3). */
const STALE_AFTER_FAILS = 3;

interface CgRow {
  id: string;
  current_price?: number | null;
  price_change_percentage_24h?: number | null;
  market_cap?: number | null;
  last_updated?: string | null;
}

/** Pure mapping from a CoinGecko `/coins/markets` row to a `Quote[]`. Exported
 *  so unit tests can assert the field contract without network. */
export function mapCoinGeckoRow(
  row: CgRow,
  inst: Instrument,
  stale: boolean,
  ts: number,
): Quote {
  const price =
    typeof row.current_price === 'number' && Number.isFinite(row.current_price)
      ? row.current_price
      : inst.refPrice;
  let changePct = 0;
  const pct = row.price_change_percentage_24h;
  if (typeof pct === 'number' && Number.isFinite(pct)) changePct = pct;
  return {
    id: inst.id,
    price,
    changePct,
    marketCap:
      typeof row.market_cap === 'number' && Number.isFinite(row.market_cap)
        ? row.market_cap
        : inst.mcapUSD,
    ts,
    source: 'coingecko',
    session: '24_7',
    stale,
  };
}

class CoingeckoProvider implements QuoteProvider {
  readonly id = 'coingecko' as const;

  private consecutiveFailures = 0;
  /** Effective next-attempt delay; grows on 429, resets on ok. */
  private backoffMs = COINGECKO_INTERVAL_MS;
  /** Earliest wall-clock ms we may call CoinGecko again after a 429. */
  private retryAfter = 0;
  private _status: CoingeckoStatus = 'ok';
  /** Last known good prices per instrument (keep-last-known on failure). */
  private readonly lastKnown = new Map<string, Quote>();

  get status(): CoingeckoStatus {
    return this._status;
  }

  /** Consecutive failures (banner reads this for stale-timing, §5.2). */
  get failureCount(): number {
    return this.consecutiveFailures;
  }

  supports(inst: Instrument): boolean {
    if (inst.provider !== 'coingecko' || inst.category !== 'crypto') return false;
    let demo = false;
    try {
      demo = Boolean(useSettingsStore().demoMode);
    } catch {
      demo = false;
    }
    return !demo;
  }

  async fetchQuotes(batch: Instrument[]): Promise<Quote[]> {
    if (batch.length === 0) return [];
    const cryptoBatch = batch.filter((b) => b.category === 'crypto');
    if (cryptoBatch.length === 0) return [];

    // Honor ongoing backoff (no catch-up burst on tab refocus).
    if (Date.now() < this.retryAfter) {
      this._status = 'rate-limited';
      return this.emitStaleKnown(cryptoBatch);
    }

    const ids = cryptoBatch.map((b) => b.providerSymbol).join(',');
    const url =
      `${COINGECKO_BASE}?vs_currency=usd&ids=${encodeURIComponent(ids)}` +
      `&price_change_percentage=24h`;
    console.log(`[eml:coingecko] \u2192 GET markets (${cryptoBatch.length} ids)`);

    let resp: Response;
    try {
      resp = await fetch(url, { cache: 'no-store' });
    } catch {
      console.warn('[eml:coingecko] \u2717 HTTP - network error');
      return this.onFailure(cryptoBatch);
    }

    if (resp.status === 429) {
      console.warn('[eml:coingecko] \u2717 HTTP 429 rate-limited');
      this.bumpBackoff();
      this._status = 'rate-limited';
      return this.emitStaleKnown(cryptoBatch);
    }
    if (!resp.ok) {
      console.warn(`[eml:coingecko] \u2717 HTTP ${resp.status} http error`);
      return this.onFailure(cryptoBatch);
    }

    let json: unknown;
    try {
      json = await resp.json();
    } catch {
      console.warn(`[eml:coingecko] \u2717 HTTP ${resp.status} bad json`);
      return this.onFailure(cryptoBatch);
    }
    if (!Array.isArray(json)) {
      console.warn(`[eml:coingecko] \u2717 HTTP ${resp.status} no data`);
      return this.onFailure(cryptoBatch);
    }

    const rows = json as CgRow[];
    const byCgId = new Map<string, CgRow>();
    for (const r of rows) {
      if (r && typeof r.id === 'string') byCgId.set(r.id, r);
    }
    const now = Date.now();
    const stale = false; // fresh ok batch
    const out: Quote[] = [];
    let anyNew = false;
    for (const inst of cryptoBatch) {
      const row = byCgId.get(inst.providerSymbol);
      if (!row) {
        // CoinGecko returned no row for this id: keep last known, mark stale.
        out.push(this.lastKnownQuote(inst, true, now));
        continue;
      }
      const q = mapCoinGeckoRow(row, inst, stale, now);
      this.lastKnown.set(inst.id, q);
      out.push(q);
      anyNew = true;
    }
    if (anyNew) {
      this.consecutiveFailures = 0;
      this.backoffMs = COINGECKO_INTERVAL_MS;
      this.retryAfter = 0;
      this._status = 'ok';
      console.log(`[eml:coingecko] \u2190 HTTP ${resp.status} (n=${out.length})`);
    } else {
      return this.onFailure(cryptoBatch);
    }
    return out;
  }

  private bumpBackoff(): void {
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CAP_MS);
    this.retryAfter = Date.now() + this.backoffMs;
  }

  private onFailure(batch: Instrument[]): Quote[] {
    this.consecutiveFailures++;
    this._status = this.consecutiveFailures >= STALE_AFTER_FAILS ? 'down' : 'ok';
    return this.emitStaleKnown(batch);
  }

  /** Emit last-known quotes, stale if failures cross the §5.2 threshold. */
  private emitStaleKnown(batch: Instrument[]): Quote[] {
    const stale = this.consecutiveFailures >= STALE_AFTER_FAILS;
    const now = Date.now();
    return batch.map((inst) => this.lastKnownQuote(inst, stale, now));
  }

  private lastKnownQuote(inst: Instrument, stale: boolean, ts: number): Quote {
    const prev = this.lastKnown.get(inst.id);
    if (prev) {
      return { ...prev, ts, stale };
    }
    // First-ever run before any data: seed from the manifest refPrice.
    return {
      id: inst.id,
      price: inst.refPrice,
      changePct: 0,
      marketCap: inst.mcapUSD,
      ts,
      source: 'coingecko',
      session: '24_7',
      stale,
    };
  }
}

/** Self-registering default export discovered by the scheduler glob. */
export default new CoingeckoProvider();