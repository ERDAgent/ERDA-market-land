// src/net/protocol.ts — frozen wire + data contract.
//
// Every wire type in §4.5, the data types + QuoteProvider interface in §5.1,
// and the Instrument schema in §6.1. Pure types + `PROTOCOL_VERSION` only:
// NO THREE import, NO runtime state, NO side effects. Change-controlled — a
// crew that needs a wire-shape change STOPS and SOSes; never edits silently.
//
// `config/city.ts` (frozen) owns `DistrictId`; `Instrument` reuses it here so
// the manifest schema + the city layout share one definition of a district.

import type { DistrictId } from '../config/city';

/** Wire protocol version. One home (here); `config/net.ts` re-exports it. */
export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// §5.1 / §6.1 — data types (shared by net + data providers + manifest)
// ---------------------------------------------------------------------------

/** A peer's network-visible identity (§4.5). */
export interface PeerInfo {
  id: string;
  name: string;
  color: string;
  isHost: boolean;
  /** Round-trip time in ms, measured by ping/pong; undefined until known. */
  rttMs?: number;
}

/** One persisted chat message (§4.5). */
export interface ChatMsg {
  id: string;
  from: string;
  name: string;
  text: string;
  ts: number;
}

/** A market quote for one instrument (§5.1). */
export interface Quote {
  id: string;
  price: number;
  changePct: number;
  marketCap?: number;
  ts: number;
  source: 'coingecko' | 'finnhub' | 'simulated';
  session: 'open' | 'closed' | '24_7';
  /** True when the quote is older than `STALE_MULT` × the source cadence. */
  stale?: boolean;
}

/** The source literal on a `Quote`; provider id constants must equal these. */
export type QuoteSource = Quote['source'];

/** A market-data provider (§5.1). Providers self-register; M1 implements
 *  simulated, M2 adds coingecko/finnhub — the contract type must exist first. */
export interface QuoteProvider {
  readonly id: QuoteSource;
  supports(inst: Instrument): boolean;
  fetchQuotes(batch: Instrument[]): Promise<Quote[]>;
}

/** One building in the city — a tradeable instrument (§6.1). */
export interface Instrument {
  /** lowercase slug, unique across the roster (aapl, btc, spy, …). */
  id: string;
  ticker: string;
  name: string;
  category: 'index' | 'stock' | 'crypto' | 'commodity' | 'fx';
  /** Frozen DistrictId from `config/city.ts`; picks this building's plot. */
  district: DistrictId;
  provider: 'finnhub' | 'coingecko';
  /** finnhub symbol (ticker) for non-crypto; CoinGecko id for crypto. */
  providerSymbol: string;
  /** Free-text note for ETF proxies of an underlying index/commodity/fx. */
  proxyNote?: string;
  /** Rough recent price — precision is irrelevant; used for sim seeding. */
  refPrice: number;
  /** Market cap (stocks/crypto) or AUM (ETFs), in USD. */
  mcapUSD?: number;
  /** Height class: <100B→1, 100–500B→2, ≥500B→3; ETFs default 2 (SPY/QQQ/GLD→3). */
  sizeTier: 1 | 2 | 3;
}

// ---------------------------------------------------------------------------
// §4.5 — wire envelope + per-message payloads
// ---------------------------------------------------------------------------

/** Discriminator for the `Env.t` field. `pos` rides the unreliable channel. */
export type MsgType =
  | 'hello'
  | 'welcome'
  | 'manifestFull'
  | 'roster'
  | 'chat'
  | 'sys'
  | 'quotesDelta'
  | 'quotesFull'
  | 'ping'
  | 'pong'
  | 'error'
  | 'bye'
  | 'pos';

/** Reliable-channel payloads (hello … bye) + the unreliable `pos` payload. */
export interface MsgPayload {
  hello: { name: string; ver: number };
  welcome: {
    selfId: string;
    roster: PeerInfo[];
    quotes: Quote[];
    manifestHash: string;
    chatTail: ChatMsg[];
    hostName: string;
  };
  manifestFull: { manifest: Instrument[] };
  roster: { roster: PeerInfo[] };
  chat: { text: string };
  sys: { kind: 'join' | 'leave' | 'info'; text: string };
  quotesDelta: { quotes: Quote[] };
  quotesFull: { quotes: Quote[] };
  ping: { n: number };
  pong: { n: number };
  error: { code: string; msg: string };
  bye: Record<string, never>;
  pos: { p: [number, number, number]; q: [number, number, number, number] };
}

/**
 * The wire envelope (§4.5). `v` is pinned to 1; `from` is the sender's peer id;
 * `ts` is the sender's epoch-ms clock at send time; `d` is the typed payload
 * for message kind `t`. Fully typed — no `any`.
 */
export interface Env<T extends MsgType = MsgType> {
  v: 1;
  t: T;
  from: string;
  ts: number;
  d: MsgPayload[T];
}