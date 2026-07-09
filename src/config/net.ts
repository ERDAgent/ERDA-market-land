// src/config/net.ts — frozen network/runtime constants (§4.2/§4.3/§4.5/§5).
//
// Pure constants only. NO THREE import, NO runtime state, NO side effects.
// `PROTOCOL_VERSION` is re-exported here for a single import surface; its one
// home is `src/net/protocol.ts`. Provider id constants equal the `Quote.source`
// literals in `protocol.ts`.

// Re-export so net consumers import everything from one place; home is protocol.ts.
export { PROTOCOL_VERSION } from '../net/protocol';

// ----- Peer caps (§4.2) -----
/** Max non-host guests in a session (host + MAX_GUESTS peers). */
export const MAX_GUESTS = 8;

// ----- Signaling prefix (§4.2) -----
/** Compressed signaling message prefix. */
export const PREFIX = 'EML1.';
/** Uncompressed signaling message prefix. */
export const PREFIX_UNCOMPRESSED = 'EML1u.';

// ----- DataChannels (§4.5) -----
/** Ordered, reliable channel name. */
export const CH_REL = 'rel';
/** Unordered, unreliable channel name (positions); maxRetransmits 0 at runtime. */
export const CH_POS = 'pos';

// ----- ICE (§4.3) -----
/** Public STUN server; empty array at runtime when LAN-only. */
export const STUN_URL = 'stun:stun.l.google.com:19302';

// ----- Cadences (§4.5/§5) -----
/** Local avatar position broadcast rate. */
export const POS_HZ = 12;
/** Ping interval (ms) for liveness + RTT measurement. */
export const PING_MS = 10000;
/** Consecutive missed pings before dropping a peer. */
export const PING_MISSES_DROP = 3;
/** Max chat messages a peer may send per `CHAT_RATE_WINDOW_MS`. */
export const CHAT_RATE = 5;
/** Chat rate-limit window (ms). */
export const CHAT_RATE_WINDOW_MS = 2000;
/** Max remote-position receive rate before clamping (Hz). */
export const POS_RX_MAX_HZ = 20;
/** Number of recent chat messages a newcomer receives on welcome. */
export const CHAT_TAIL = 50;
/** Max characters in a single chat message. */
export const CHAT_MAX_CHARS = 500;

// ----- Data budgets (§5) -----
/** CoinGecko poll interval (ms). */
export const COINGECKO_INTERVAL_MS = 60000;
/** Finnhub burst-then-wait: gap between per-symbol calls WITHIN a burst
 *  (250 ms × 50 = 12.5 s of fetching, spread to avoid 429 — not a slam).
 *  Replaces the old one-symbol-every-3s `FINNHUB_DRIP_MS` drip; the free tier
 *  allows ~60 calls/min, so this bursts most equities onto screen within ~13 s
 *  of mount instead of over ~5 min. Also the per-FETCH tick cadence
 *  (`tickCadenceFor('finnhub')`) so `tickLane(FINNHUB_BURST_SPACING_MS)` matches
 *  finnhub instruments during an active burst. */
export const FINNHUB_BURST_SPACING_MS = 250;
/** Finnhub burst cycle (ms): one full burst of `FINNHUB_MAX_PER_MIN` calls per
 *  60 s. Also the STALENESS cadence (`cadenceFor('finnhub')`) — each equity
 *  refreshes at least once per two cycles (round-robin persists across bursts),
 *  so the stale threshold is `STALE_MULT × FINNHUB_CYCLE_MS` ≈ 180 s (real
 *  outage), not the 250 ms per-fetch spacing. */
export const FINNHUB_CYCLE_MS = 60000;
/** Finnhub call cap per rolling 60s (= burst SIZE); a hair under the 60/min
 *  rolling limit so a stray call doesn't 429. */
export const FINNHUB_MAX_PER_MIN = 50;
/** Simulated-provider tick interval (ms). */
export const SIM_TICK_MS = 5000;
/** Force a full quote resync after this long (ms). */
export const QUOTES_RESYNC_MS = 300000;
/** A quote is stale when older than `STALE_MULT` × its source cadence. */
export const STALE_MULT = 3;

// ----- Backpressure (§4.5) -----
/** `bufferedamount` high-water mark; pause sends at/above this. */
export const BUFFER_HIGH = 1_000_000;
/** `bufferedamount` low-water mark; resume sends below this. */
export const BUFFER_LOW_THRESHOLD = 256 * 1024;

// ----- Sim sigmas per tick (§5) -----
/** Per-category relative sigma for one simulated tick (price walk step size). */
export const SIM_SIGMA = {
  crypto: 0.0015,
  stock: 0.0005,
  index: 0.0003,
  commodity: 0.0004,
  fx: 0.0001,
} as const;
/** Clamp a single simulated changePct at ±this percent. */
export const SIM_CHANGE_CLAMP_PCT = 9;

// ----- Provider id strings (§5.1) -----
// Must equal the `source` literals on `Quote` in protocol.ts.
export const PROV_COINGECKO = 'coingecko';
export const PROV_FINNHUB = 'finnhub';
export const PROV_SIMULATED = 'simulated';