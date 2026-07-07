# ERDA-market-land — Project Plan v1.1

**A peer-to-peer, browser-only, multiplayer 3D market visualization.** Users fly through a miniature city where every building is a financial instrument (stock, index, commodity, currency, crypto). Building height encodes a selectable metric; color encodes daily change. One user hosts a room; others join by exchanging copy-paste WebRTC connection codes. No backend, no accounts, no dedicated servers. Ships as static files.

> **Audience:** This document is the build spec for an agentic build system — a **GLM-5.2 captain orchestrating one-to-many GLM-5.2 crew agents** (orchestration model in §13.0). It is intentionally explicit about formulas, schemas, message protocols, and acceptance criteria so crew briefs can quote it verbatim. **MUST** = non-negotiable. **SHOULD** = strong default, deviations only via the escalation path in §13.0.

---

## 0. Locked decisions (do not revisit)

| Area | Decision |
|---|---|
| Framework | Vue 3, Composition API only (`<script setup lang="ts">`), Pinia for state |
| Language | TypeScript, `strict: true` |
| Build tool | Vite |
| 3D engine | Three.js (plain, imperative — **not** TresJS; see §3) |
| Multiplayer | WebRTC RTCDataChannels, **star topology** (host = hub, guests connect only to host) |
| Signaling | **100% manual copy-paste** of compressed offer/answer codes. No signaling server, no PeerJS, no trackers. |
| Market data | **Host fetches, broadcasts to all peers.** CoinGecko (keyless) for crypto; Finnhub (free key) for equities + ETF proxies; built-in Simulated provider as universal fallback. |
| Presence | Flying avatars with name tags; chat panel with join/leave system messages |
| Servers | None. Deployable to any static host (GitHub Pages, Netlify, `npx serve`). |
| Runtime deps | `vue`, `pinia`, `three` — **nothing else** without a PROGRESS-log justification. Dev deps: `typescript`, `vite`, `@vitejs/plugin-vue`, `vitest`. |

**One nuance on "100% serverless":** WebRTC across the public internet effectively requires a STUN server to discover public IPs (STUN is a stateless, free, public utility — no app data flows through it; default `stun:stun.l.google.com:19302`). This is the *only* external touchpoint besides market-data APIs. A **"LAN-only mode"** toggle (Settings) MUST exist that removes all ICE servers — in that mode the app touches literally nothing external and works on a shared LAN. Without TURN (deliberately excluded — it's a relay server), some symmetric-NAT / CGNAT pairs will fail to connect over the internet. Document this in the in-app help and README as a known limitation.

---

## 1. Product summary & user stories

- As a user, I open a static webpage, enter a display name, and either **Start Solo**, **Host a Room**, or **Join a Room**.
- As a host, I click **Invite**, receive a "reply code" for each guest's "join code," and send it back over any out-of-band channel (text, Discord, email).
- As a guest, I click **Join**, copy my auto-generated join code to the host, paste the host's reply code, and I'm in — the city, live prices, chat history, and everyone's avatars hydrate immediately.
- As any user, I fly freely (WASD + mouse-look) around a miniature city split into districts: Indexes, Tech, Finance, Healthcare, Consumer, Energy & Industrials, Crypto, Commodities, FX.
- Every building is a labeled cube: **ticker, price, day change %** floating above it; height = my selected metric (Day Change % / Market Cap / Price); color = green/red by day change.
- I click a building to see full details; I press a key to fly to it.
- I see other users as small colored avatars with name tags, moving smoothly.
- The chat log shows messages plus "Alice joined" / "Bob left" system lines.
- If I'm the host, the app fetches quotes on a budget-respecting schedule and everyone sees identical, near-live data. If I have no API key, equities run in clearly-badged demo (simulated) mode while crypto stays live.

**Explicitly view-only.** No trading, no portfolios, no auth.

---

## 2. Architecture overview

```
┌────────────────────────────  Browser (each peer)  ───────────────────────────┐
│                                                                              │
│  Vue 3 UI (HUD)                Pinia stores               Engine (plain TS)  │
│  ┌──────────────┐   watch/actions  ┌────────────┐  applyX() ┌─────────────┐  │
│  │ Menu screens │◄────────────────►│ connection │◄─────────►│ Three scene │  │
│  │ Chat panel   │                  │ market     │           │ city/labels │  │
│  │ Signaling UI │                  │ chat       │           │ avatars     │  │
│  │ Info panel   │                  │ players    │           │ fly camera  │  │
│  │ Settings     │                  │ settings/ui│           │ picking     │  │
│  └──────────────┘                  └────────────┘           └─────────────┘  │
│         ▲                                ▲                        ▲          │
│         │                                │                        │          │
│  ┌──────┴────────────────────────────────┴────────────────────────┴───────┐  │
│  │ net/  RTC wrapper · manual signaling codec · protocol · host/guest    │  │
│  └──────────────────────────────┬─────────────────────────────────────────┘  │
│                                 │ RTCDataChannels ("rel" + "pos")            │
└─────────────────────────────────┼────────────────────────────────────────────┘
                                  │
              Host peer also runs │ data/  providers (CoinGecko, Finnhub, Sim)
              the quote scheduler │        scheduler → broadcasts quotes
```

- **Star topology:** each guest holds exactly one RTCPeerConnection (to the host). The host holds one per guest. Host relays chat/positions and is the single source of truth for the roster and quotes.
- **Solo mode** = the same code path as hosting with zero guests. The scheduler runs locally. This means M1/M2 are fully testable before any networking exists.
- **Engine ↔ Vue bridge:** the engine is plain TypeScript classes/modules holding all Three.js objects. Vue components never touch `Object3D`s; stores never contain them (§11 performance rules). Communication is: stores → engine via explicit `engine.applyQuotes()`, `engine.setMetric()`, etc. (driven by `watch`/`store.$subscribe` in one bridge composable), and engine → stores via a tiny typed event emitter (`engine.events.on('pick', ...)`). Hand-roll the emitter (~15 lines); do not add a dependency.

---

## 3. Tech stack rationale (for the record)

- **Plain Three.js over TresJS:** hundreds of per-frame instance-matrix updates and canvas-texture label regeneration fight Vue's reactivity model. A declarative wrapper adds version-coupling risk for crew agents and makes the "keep Three out of reactivity" rule harder to enforce. Imperative Three in an `engine/` module with a thin bridge is the most reliable pattern for crew-built code.
- **InstancedMesh** for all building cubes (one draw call for geometry; per-instance color). Labels are individual `THREE.Sprite`s with `CanvasTexture`s (cheap at this count, ~117 buildings).
- **Two data channels per connection:** `"rel"` (reliable/ordered — control, chat, quotes) and `"pos"` (unordered, `maxRetransmits: 0` — avatar transforms). Classic game-networking split; stale positions must never queue behind fresh ones.
- **JSON envelopes everywhere.** At ≤ ~16 peers and 12 Hz position updates, JSON is trivially fast and far easier for crew agents to debug. Binary packing is a listed v2 optimization, not v1.
- **No vue-router.** Two screens (Menu, World) toggled by a `ui` store flag. No routes, no dep.

---

## 4. Networking design

### 4.1 Roles & lifecycle

- **Roles:** `solo` | `host` | `guest`. Solo is host-with-no-peers; "Host a Room" and "Start Solo" differ only in whether the Invite UI is surfaced.
- **Peer IDs:** host is `"H"`. Host assigns each guest a 4-char base36 id on `hello`. Avatar color = deterministic HSL from id hash.
- **Peer cap:** default **8 guests** (constant `MAX_GUESTS` in `config/net.ts`). Star + manual signaling makes larger rooms impractical; enforce with a polite rejection message.
- **Host leaves ⇒ room ends.** Guests detect channel close → banner: *"Host disconnected — data frozen"* with buttons **[Continue solo]** (become host of a fresh room, keeping current quotes as seed) and **[Back to menu]**. No host migration in v1 (§16).
- **Guest leaves:** host detects `rel` channel close (or 3 missed pings) → removes from roster → broadcasts `roster` + system chat "X left".

### 4.2 RTCPeerConnection config

```ts
const rtcConfig: RTCConfiguration = settings.lanOnly
  ? { iceServers: [] }
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
```

- **Non-trickle ICE is MANDATORY** (manual signaling can't deliver candidates incrementally): after `setLocalDescription`, wait for `pc.iceGatheringState === 'complete'` (listen to `icegatheringstatechange`) **with a 4 s timeout fallback** (export whatever gathered — mDNS/host candidates are enough on LAN), then serialize `pc.localDescription`.
- **Guest is the offerer** and therefore MUST create both data channels *before* `createOffer()`:

```ts
const rel = pc.createDataChannel('rel', { ordered: true });
const pos = pc.createDataChannel('pos', { ordered: false, maxRetransmits: 0 });
```

Host receives them via `pc.ondatachannel` (distinguish by `channel.label`).

### 4.3 Manual signaling — the copy-paste codec

Codes are gzip-compressed, base64url-encoded session descriptions with a version prefix. Raw SDP is ~2–4 KB; encoded codes land around **0.9–1.6 KB of paste-safe text**.

```ts
const PREFIX = 'EML1.';

export async function encodeSignal(desc: RTCSessionDescriptionInit): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify({ t: desc.type, s: desc.sdp }));
  const gz = await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer();
  return PREFIX + base64url(new Uint8Array(gz));
}

export async function decodeSignal(code: string): Promise<RTCSessionDescriptionInit> {
  if (!code.trim().startsWith(PREFIX)) throw new SignalError('BAD_PREFIX');
  const gz = base64urlDecode(code.trim().slice(PREFIX.length));
  const raw = await new Response(
    new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))
  ).arrayBuffer();
  const { t, s } = JSON.parse(new TextDecoder().decode(raw));
  return { type: t, sdp: s };
}
```

- `CompressionStream`/`DecompressionStream` are baseline in modern Chrome/Edge/Firefox/Safari. Feature-detect anyway; **fallback** = uncompressed base64url with prefix `EML1u.` (bigger paste, still works).
- Clipboard: use `navigator.clipboard.writeText` when available (secure contexts only) with a **fallback** of a read-only auto-selected `<textarea>` + "copy manually" hint. Paste side is always a textarea (no permission needed).
- Validate on decode: prefix, gzip integrity, JSON shape, `type ∈ {offer, answer}`. Every failure maps to a friendly UI message ("That doesn't look like an ERDA-market-land code — make sure you copied the whole thing").
- **Privacy note (put in UI help + README):** WebRTC codes inherently contain IP candidate info (browsers mDNS-mask local IPs; the STUN-derived public IP appears unless LAN-only mode is on). Codes should be shared only with people you'd video-call.

### 4.4 Join handshake (sequence)

```
GUEST                                   (out-of-band)                       HOST
  │ click Join                                                                │
  │ new pc, create rel+pos channels                                           │
  │ createOffer → gather ICE → encode ──── "join code" ───────────────► paste │
  │                                                     setRemote(offer)      │
  │                                                     createAnswer → gather │
  │ paste ◄─────────────── "reply code" ─────────────── encode                │
  │ setRemote(answer)                                                         │
  │ ...ICE connects, channels open...                                         │
  │ rel: hello {name, ver} ─────────────────────────────────────────────────► │
  │                              validate ver/name, assign id, dedupe name    │
  │ ◄─── rel: welcome {selfId, roster, quotes[], manifestHash, chatTail,      │
  │                    hostName}                                              │
  │                              broadcast to others: roster + sys "X joined" │
  │ start pos stream (12 Hz)                                                  │
```

- **One pending join at a time** on the host (a single "pending pc" slot). The Invite modal walks the host through: *paste guest's join code → copy reply code → waiting for connection…* Additional joiners queue socially ("finish inviting Alice first").
- `hello.ver` = `PROTOCOL_VERSION` (start at 1). Mismatch ⇒ host replies `error {code:'VERSION'}` and closes; guest shows "Host is running a different version."
- `manifestHash` = FNV-1a hash (hex) of the instruments manifest JSON. If the guest's built-in manifest hash differs, host follows `welcome` with `manifestFull` and the guest rebuilds the city from it. (Hand-rolled FNV-1a — no async, no secure-context requirement, ~10 lines.)
- Name dedupe: trim, strip control chars, clamp 1–20 chars; collision ⇒ append `#2`, `#3`, ….

### 4.5 Wire protocol

Single JSON envelope on both channels:

```ts
interface Env<T extends MsgType = MsgType> {
  v: 1;            // protocol version
  t: T;            // message type
  from: string;    // peer id ("H" = host); host preserves original `from` when relaying
  ts: number;      // sender epoch ms
  d: MsgPayload[T];
}
```

**Reliable channel (`rel`) message types**

| `t` | Direction | Payload `d` | Notes |
|---|---|---|---|
| `hello` | guest→host | `{ name, ver }` | first message after open |
| `welcome` | host→guest | `{ selfId, roster: PeerInfo[], quotes: Quote[], manifestHash, chatTail: ChatMsg[], hostName }` | chatTail = last 50 |
| `manifestFull` | host→guest | `{ manifest: Instrument[] }` | only on hash mismatch |
| `roster` | host→all | `{ roster: PeerInfo[] }` | on every join/leave |
| `chat` | any→host→all | `{ text }` | host stamps `from`, relays to everyone incl. echo to sender |
| `sys` | host→all | `{ kind: 'join'\|'leave'\|'info', text }` | rendered italic in chat |
| `quotesDelta` | host→all | `{ quotes: Quote[] }` | changed instruments only; coalesced ≤ 1/s |
| `quotesFull` | host→all | `{ quotes: Quote[] }` | on welcome + every 5 min safety resync |
| `ping` / `pong` | host↔guest | `{ n }` | 10 s cadence; RTT → roster UI; 3 misses ⇒ drop |
| `error` | host→guest | `{ code, msg }` | e.g. VERSION, ROOM_FULL |
| `bye` | any | `{}` | graceful leave before close |

**Unreliable channel (`pos`)**

| `t` | Payload | Notes |
|---|---|---|
| `pos` | `{ p: [x,y,z], q: [x,y,z,w] }` | 12 Hz sender-side cap; host relays to all *other* guests; receivers interpolate (§8.6) |

```ts
interface PeerInfo { id: string; name: string; color: string; isHost: boolean; rttMs?: number }
interface ChatMsg  { id: string; from: string; name: string; text: string; ts: number }
```

**Hard input validation on receive (both sides):** unknown `t` ⇒ ignore; `chat.text` clamped to 500 chars; per-peer chat rate limit 5 msgs / 2 s (host-enforced, drop + `sys` warn); `pos` accepted ≤ 20 Hz per peer (drop extras); all strings rendered as **text nodes only — never `v-html`** (XSS rule, §15).

**Backpressure:** before sending `quotesFull`/`welcome` (~30–60 KB), check `dc.bufferedAmount < 1_000_000`; if exceeded, wait for `bufferedamountlow` (set `bufferedAmountLowThreshold = 256 * 1024`).

### 4.6 Connection-state UX

`pc.connectionState` → status pill in HUD: `connected` (green) / `disconnected` (amber, "reconnecting…" — transient states sometimes self-heal) / `failed` (red ⇒ treat as left; manual signaling cannot do ICE restarts, so recovery = fresh join with new codes). Host tab throttling note: browsers clamp background-tab timers to ~1/min — **relay still works** (event-driven `onmessage`), and the 60 s poll cadence tolerates it, but show the host a one-time toast: "Keep this tab visible for smoothest updates."

---

## 5. Market data design

### 5.1 Provider abstraction

```ts
interface Quote {
  id: string;                 // manifest instrument id
  price: number;
  changePct: number;          // day change % (equities) or 24h % (crypto)
  marketCap?: number;         // live for crypto; static (manifest) for equities
  ts: number;
  source: 'coingecko' | 'finnhub' | 'simulated';
  session: 'open' | 'closed' | '24_7';
  stale?: boolean;            // set by scheduler when provider errors persist
}

interface QuoteProvider {
  readonly id: Quote['source'];
  supports(inst: Instrument): boolean;
  /** May partial-fill; throw only on total failure. */
  fetchQuotes(batch: Instrument[]): Promise<Quote[]>;
}
```

The scheduler (§5.5) runs **only** on host/solo. Guests never fetch; they consume `quotesDelta`/`quotesFull`.

### 5.2 CoinGecko adapter (crypto — keyless)

- One batched call per cycle:
  `GET https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=<comma-joined ids>&price_change_percentage=24h`
- Map: `current_price → price`, `price_change_percentage_24h → changePct`, `market_cap → marketCap`, `session: '24_7'`.
- CORS-friendly, no key. Budget: **1 call / 60 s** (well under the keyless public limit). On HTTP 429: exponential backoff 2× (60 s → cap 10 min), mark affected quotes `stale: true` after 3 consecutive failures.
- Manifest crypto ids MUST be verified once against `/api/v3/coins/list` during M2 (crew: do this check and fix any drifted ids — e.g. token migrations).

### 5.3 Finnhub adapter (equities, ETF proxies — free key)

- Per-symbol: `GET https://finnhub.io/api/v1/quote?symbol=AAPL&token=<key>` → `{ c, d, dp, h, l, o, pc, t }`. Map `c → price`, `dp → changePct` (if `dp` is null/0 with `c===pc`, compute `((c/pc)-1)*100`; if still degenerate, keep last known).
- **Key handling:** host enters key in Settings; stored in `localStorage` only; **never transmitted to peers** — only resulting quotes are broadcast. Empty key ⇒ equities fall back to Simulated (crypto stays live). Surface this clearly: "No Finnhub key — equity districts running on simulated data."
- Budget: free tier is 60 calls/min. Scheduler uses **max 50/min** (1 call / 1.2 s) round-robin over all Finnhub instruments (~93 symbols ⇒ full refresh ≈ every 2 min 15 s). On 429: pause that provider 60 s, then resume where it left off.
- `session`: simple US-hours check (Mon–Fri 09:30–16:00 America/New_York via `Intl.DateTimeFormat`; holidays intentionally ignored — acceptable v1 imprecision, note in README). Closed ⇒ UI dims building color saturation 40% and info panel shows "market closed — last price".
- Equity `marketCap` comes from the manifest's static `mcapUSD` (§6.1) — do NOT burn API budget on profile endpoints in v1.

### 5.4 Simulated provider (always available)

- Purpose: zero-key demo, offline dev, and per-category fallback. Every simulated quote carries `source:'simulated'`; UI shows a **SIM badge** on labels/info panel and a global banner when *any* category is simulated.
- Model: per-instrument geometric random walk, ticked every 5 s. Seed `price = refPrice` (manifest); keep `sessionOpen` = first price of the run; `changePct = (price/sessionOpen − 1) × 100`.
- Per-tick step: `price *= 1 + gauss() * sigma[category]` with Box–Muller `gauss()`, sigma per tick: crypto 0.15%, stock 0.05%, index 0.03%, commodity 0.04%, fx 0.01%. Clamp cumulative `changePct` to ±9%.

### 5.5 Scheduler & broadcast

- Lives in `data/scheduler.ts`; started by host/solo bootstrap; owns provider instances + retry state.
- Loop: crypto batch on a 60 s interval; Finnhub drip at 1/1.2 s; sim ticks at 5 s for whichever instruments it owns.
- After each batch/drip completes, push changed `Quote`s into a dirty set; a flusher broadcasts `quotesDelta` **at most once per second** and applies the same delta locally (host is just another consumer of its own broadcasts — one code path).
- `quotesFull` resync every 5 min and inside every `welcome`.
- Staleness: any instrument not refreshed in > 3× its expected cadence ⇒ `stale: true` (UI: grey label price + "stale" tooltip).

---

## 6. Instrument manifest & default roster

### 6.1 Schema (`src/data/manifest/instruments.json`, validated by a hand-rolled checker at load)

```ts
interface Instrument {
  id: string;              // unique slug: "aapl", "btc", "spy"
  ticker: string;          // display: "AAPL", "BTC", "SPY"
  name: string;            // "Apple Inc.", "Bitcoin", "S&P 500 (SPY)"
  category: 'index' | 'stock' | 'crypto' | 'commodity' | 'fx';
  district: DistrictId;    // §7.1
  provider: 'finnhub' | 'coingecko';
  providerSymbol: string;  // "AAPL" | coingecko id "bitcoin"
  proxyNote?: string;      // "ETF proxy for spot gold"
  refPrice: number;        // sim seed; rough recent price, precision irrelevant
  mcapUSD?: number;        // static approx (equities); used for sizeTier + mcap height mode
  sizeTier: 1 | 2 | 3;     // footprint tier: <100B → 1, 100–500B → 2, ≥500B → 3 (ETFs: default 2; SPY/QQQ/GLD → 3)
}
```

The manifest is **data, not code** — the whole city is generated from it, so editing the roster requires zero code changes. Layout is derived from manifest order/fields only (never from live data) so the city geometry is identical and stable across all peers; only heights/colors animate.

### 6.2 Default roster (117 buildings — crew: fill `name`, `refPrice`, `mcapUSD`, `sizeTier` per rules above)

| District | Category | Tickers / CoinGecko ids |
|---|---|---|
| **Indexes** (9) | index | SPY, QQQ, DIA, IWM, VTI, EFA, EEM, TLT, VNQ *(all ETF proxies — set `proxyNote`)* |
| **Tech** (16) | stock | AAPL, MSFT, NVDA, GOOGL, META, AVGO, TSM, AMD, ORCL, CRM, ADBE, QCOM, INTC, CSCO, IBM, PLTR |
| **Finance** (12) | stock | JPM, V, MA, BAC, WFC, GS, MS, BLK, SCHW, AXP, C, PYPL |
| **Healthcare** (10) | stock | LLY, UNH, JNJ, ABBV, MRK, PFE, TMO, ABT, AMGN, ISRG |
| **Consumer** (14) | stock | AMZN, TSLA, WMT, COST, HD, PG, KO, PEP, MCD, NKE, SBUX, DIS, NFLX, LOW |
| **Energy & Industrials** (12) | stock | XOM, CVX, COP, SLB, CAT, BA, GE, HON, UPS, RTX, DE, LMT |
| **Crypto** (24) | crypto | bitcoin, ethereum, solana, ripple, binancecoin, dogecoin, cardano, tron, avalanche-2, chainlink, sui, stellar, litecoin, polkadot, uniswap, near, aptos, internet-computer, monero, bitcoin-cash, the-open-network, filecoin, cosmos, aave |
| **Commodities** (12) | commodity | GLD, SLV, PPLT, PALL, USO, BNO, UNG, CPER, URA, WEAT, CORN, DBA *(ETF proxies — set `proxyNote`, e.g. "GLD ≈ spot gold")* |
| **FX** (8) | fx | UUP, UDN, FXE, FXY, FXB, FXF, FXC, FXA *(ETF proxies — labels like "US Dollar (UUP)")* |

Notes: stablecoins deliberately excluded (flat buildings). All non-crypto symbols route through Finnhub, including the commodity/FX/index proxies — one API, one budget. Verify CoinGecko ids in M2 (§5.2).

---

## 7. City layout (deterministic, data-driven)

### 7.1 District plots — 3×3 grid, Indexes at center

World units ≈ meters. Plot = 150×150 u; streets = 30 u; grid pitch = 180 u. `plotCenter(col,row) = (col·180, 0, row·180)` with `col,row ∈ {−1,0,1}`.

```
        col −1          col 0            col +1
row −1  CRYPTO          TECH             FINANCE
row  0  COMMODITIES     INDEXES          HEALTHCARE
row +1  FX              CONSUMER         ENERGY & INDUSTRIALS
```

`DistrictId = 'indexes'|'tech'|'finance'|'healthcare'|'consumer'|'energy_industrial'|'crypto'|'commodities'|'fx'`. Each district: a raised ground slab (150×0.3×150, dark tint unique per district — palette in `config/city.ts`) + a large floating district-name sprite (canvas texture) at y≈28 over the plot's −z edge.

### 7.2 Building placement within a plot

1. Sort district instruments by `sizeTier` desc, then `mcapUSD` desc (undefined last), then `ticker` asc.
2. `cols = ceil(sqrt(n))`, row-major placement, **pitch 16 u** both axes (max footprint 10 u + margin — no collisions possible by construction).
3. Center the block on the plot: `x0 = plotX − (cols−1)·16/2`, same for z with `rows`.
4. Footprint by `sizeTier`: 1 → 6 u, 2 → 8 u, 3 → 10 u (square).

Pure function `layoutCity(manifest) → Map<instrumentId, {x, z, footprint, districtId}>` in `engine/layout.ts` — **unit-test this** (stability, no overlaps, all placed).

### 7.3 Height metrics (user-switchable, per-user, keys 1/2/3)

Shared helper `mapClamp(v, [a,b], [c,d])`. `H_MIN = 2`, `H_MAX = 60`.

| Mode | Formula | Notes |
|---|---|---|
| **1 · Day change %** *(default)* | `h = 4 + 46 · clamp(|changePct| / 5, 0, 1)` | ±5% pegs the scale; direction shown by color, magnitude by height |
| **2 · Market cap** | `h = mapClamp(log10(mcap), [8.5, 13.3], [3, 60])` | ~$300 M → $2 T+; instruments without mcap render at `H_MIN` with dashed label note |
| **3 · Price** | `h = mapClamp(log10(price), [−2, 5.1], [2, 58])` | spans $0.01 → $100k+ (BTC) |

**Color is always day-change** regardless of height mode (constant meaning): three-stop lerp `red #d64550 ← neutral #6b7683 → green #22c07a` with `t = clamp(changePct / 3, −1, 1)`; `|changePct| < 0.05` ⇒ neutral. Apply via `InstancedMesh.setColorAt`. Market-closed equities: multiply saturation ×0.6. Stale: desaturate further + grey label price.

**Height animation:** cube geometry is unit-height translated +0.5 (origin at base), so `scaleY = h` grows from the ground. On quote change, tween current→target height over 0.6 s ease-out inside the render loop (per-instance target array; no tween library).

---

## 8. Rendering design (engine/)

### 8.1 Scene & atmosphere

- Dark "trading floor at night" theme: `scene.background = #0b0f14`, matching `THREE.Fog(#0b0f14, 250, 900)`. Ground: one huge plane `#10161d` + subtle `GridHelper` (120 divisions, low-contrast). Lighting: `HemisphereLight(#8899bb, #10161d, 0.9)` + one `DirectionalLight(#ffffff, 0.7)` at (1, 2, 1)·300. **Shadows OFF** (perf; flat aesthetic reads better anyway).
- Renderer: `antialias: true`, `setPixelRatio(min(devicePixelRatio, 2))`, resize handler, single `requestAnimationFrame` loop with clock delta. `renderer.info.render.calls` exposed to a debug FPS/draw-call overlay (toggle with backtick).

### 8.2 Buildings

- One `THREE.InstancedMesh(unitBoxGeom, MeshLambertMaterial({vertexColors via instanceColor}), N)` for **all** cubes. Per-instance: compose matrix from `(x, z)` position, `(footprint, hCurrent, footprint)` scale. `instanceMatrix.setUsage(DynamicDrawUsage)`.
- Maintain parallel typed arrays: `hCurrent`, `hTarget`, index maps `instrumentId ↔ instanceIndex`. Render loop: for dirty instances, ease `hCurrent → hTarget`, write matrix, set `needsUpdate` once per frame.

### 8.3 Labels (the only expensive part — follow this exactly)

- One `THREE.Sprite` per building, `CanvasTexture` from an offscreen 256×128 canvas: line 1 ticker (bold 44 px), line 2 price (formatted, 30 px), line 3 signed changePct (30 px, green/red) + SIM badge when simulated. Sprite anchored above the cube: `y = hCurrent + 4`, updated when height animates.
- **LOD by camera distance**, evaluated ~4×/s (not per frame): `< 60 u` full 3-line texture; `60–160 u` cached ticker-only texture (pre-render once per instrument); `> 160 u` `sprite.visible = false`.
- **Texture regeneration budget:** quotes mark labels dirty; a queue repaints **≤ 8 canvases per frame**, nearest-first. Never repaint invisible labels (repaint lazily when they re-enter range).
- District name sprites: same technique, 1024×256 canvas, `sizeAttenuation: true`, always visible.

### 8.4 Picking & focus

- `Raycaster` on click/tap against the InstancedMesh → `intersection.instanceId` → instrument → open Info Panel (Vue) via `engine.events.emit('pick', id)`. Hover (throttled 10 Hz raycast) sets a subtle emissive highlight: swap instance color toward white by 15%.
- **Fly-to** (`F` key or Info Panel button): tween camera over 1.2 s to a point offset from the building (distance 3× its height, 30° elevation), easing in/out; user input cancels the tween.

### 8.5 Avatars

- Per remote peer: `THREE.Group` = cone (r 0.8, h 2, tip pointing −z = view direction) in the peer's roster color + name-tag sprite (192×64 canvas) at +2.8 u. Add/remove on roster changes.
- Local player sends `pos` at **12 Hz** (timer-gated, only if moved > 1 cm or rotated > 0.5°).

### 8.6 Remote interpolation

Keep the **last two** received snapshots per peer `{t, p, q}` (plain `Map` in the engine — NOT in Pinia). Render each avatar at `now − 150 ms`: lerp positions, slerp quaternions between bracketing snapshots; if newest snapshot is older than 400 ms, hold position; older than 5 s, fade avatar to 40% opacity ("stalled"); roster removal deletes it. This makes 12 Hz input look continuous at any frame rate.

### 8.7 Performance rules (crew: treat as MUSTs)

1. **No Three.js object ever enters Vue reactivity.** Engine state lives in module scope / class fields. If a ref must hold one, use `shallowRef` + `markRaw` — but prefer not to.
2. Pinia `players` store holds roster metadata only; live transforms live in the engine's `Map` (§8.6).
3. One rAF loop owns all per-frame work (height tweens, interpolation, hover raycast throttle, label queue).
4. No per-frame allocations in hot paths (reuse `Vector3`/`Quaternion`/`Matrix4` scratch objects).
5. Label repaint budget (§8.3) and LOD are not optional.
6. Target: 60 fps on integrated graphics with 117 buildings + 8 avatars; draw calls < 200.

---

## 9. Controls

| Input | Action |
|---|---|
| Click canvas | Pointer lock (mouse-look). Esc releases. Fallback if lock unavailable (iOS): drag-to-look. |
| `W A S D` | Move fwd/left/back/right on camera basis |
| `Space` / `C` | Up / down |
| `Shift` (hold) | Sprint ×3 |
| Scroll wheel | Adjust base speed 4–60 u/s (default 15), shown briefly in HUD |
| `F` | Fly to selected building |
| `1 / 2 / 3` | Height metric: change% / mcap / price |
| `Enter` | Focus chat input (releases pointer lock); `Esc` blurs back to world |
| `` ` `` | Debug overlay (fps, draw calls, peers, data budget) |

Movement is delta-time based, damped (accel 40 u/s², friction 8/s) for smoothness. Clamp: `y ∈ [1.5, 400]`, horizontal distance from origin ≤ 700 u (soft push-back). Spawn: `(0, 80, 260)` looking at origin — full-city establishing view. **Key handling MUST ignore keydowns when any input/textarea is focused.**

---

## 10. UI spec (Vue components)

Screens toggled by `ui.screen: 'menu' | 'world'`. All HUD panels overlay the canvas (absolute positioning, pointer-events scoped).

- **MenuScreen** — name input (persisted), buttons: Start Solo / Host a Room / Join a Room; footer links: Help (controls, privacy note, NAT limitation), Settings.
- **WorldScreen** — `<WorldCanvas>` (owns engine lifecycle in `onMounted`/`onUnmounted`) plus HUD:
  - **TopBar** — room status pill (Solo / Hosting n / Connected · ping), data-source banner when any category simulated or stale, Invite button (host only), Leave button.
  - **RosterPanel** (top-left, collapsible) — colored dot, name, (host) tag, ping.
  - **ChatPanel** (right, collapsible) — scrollback (auto-stick to bottom unless user scrolled up), 500-char input, system messages italicized, unread badge when collapsed. Renders text nodes only.
  - **InfoPanel** (left, on pick) — name, ticker, district, price, day %, market cap (+"static" note for equities), source + SIM/stale badge, session state, last-updated, `proxyNote`, [Fly to] button.
  - **Toolbar** (bottom-center) — metric switcher (3 segmented buttons mirroring keys 1/2/3), legend popover (color scale, height meaning for current metric), Settings gear.
  - **SignalingModal** — two guided flows with big monospaced code boxes, copy buttons, paste textareas, live status ("waiting for reply code…", "connecting…", error strings from §4.3):
    - *Host/Invite:* Step 1 paste guest's join code → Step 2 copy reply code → Step 3 connected ✓ (auto-advances on channel open).
    - *Guest/Join:* Step 1 copy your join code (auto-generated on modal open) → Step 2 paste reply code → connecting → ✓.
  - **SettingsModal** — display name, Finnhub API key (password field, "stored locally, never shared with peers"), LAN-only mode toggle, Demo-data toggle (forces Simulated for everything), pixel-ratio cap.
  - **Toasts** — join/leave, copy confirmations, data warnings, host-tab-visibility hint.

---

## 11. Pinia stores (Composition-API style: `defineStore(id, () => {...})`)

| Store | State (shape) | Notes |
|---|---|---|
| `useSettingsStore` | `displayName, finnhubKey, lanOnly, demoMode, dprCap` | persisted to localStorage via a tiny plugin (JSON, key `eml.settings.v1`) |
| `useUiStore` | `screen, modals, selectedInstrumentId, toasts[], debugOverlay` | |
| `useConnectionStore` | `role, selfId, roster: PeerInfo[], status, pendingInvite state` | actions delegate to `net/` |
| `useMarketStore` | `manifest: Instrument[], quotes: Map<id, Quote>, metric: 1|2|3, lastUpdated, providerStatus` | `quotes` may be `shallowRef`-wrapped Map; bridge composable forwards deltas to engine |
| `useChatStore` | `messages: (ChatMsg|SysMsg)[], unread` | cap 500 in memory |
| `usePlayersStore` | roster-derived metadata only | transforms live in engine (§8.7-2) |

**Bridge composable** `useEngineBridge(engine)`: wires store watchers → engine (`applyQuotes`, `setMetric`, `syncAvatars`) and engine events → stores/actions (`pick`, `requestPointerLockFailed`, …). This is the *only* file where Vue and the engine meet.

---

## 12. Project structure

```
src/
  main.ts, App.vue
  screens/        MenuScreen.vue, WorldScreen.vue
  components/     TopBar.vue, RosterPanel.vue, ChatPanel.vue, InfoPanel.vue,
                  Toolbar.vue, SignalingModal.vue, SettingsModal.vue, Toasts.vue,
                  WorldCanvas.vue
  composables/    useEngineBridge.ts, useHotkeys.ts, useClipboard.ts
  engine/         engine.ts (facade), scene.ts, loop.ts, layout.ts, buildings.ts,
                  labels.ts, districts.ts, avatars.ts, flyControls.ts, picking.ts,
                  flyTo.ts, emitter.ts, scratch.ts
  net/            rtc.ts (PC wrapper), signaling.ts (codec §4.3), protocol.ts (types §4.5),
                  host.ts, guest.ts, validate.ts
  data/           providers/{coingecko,finnhub,simulated}.ts, scheduler.ts,
                  manifest/instruments.json, manifest/validate.ts
  stores/         settings.ts, ui.ts, connection.ts, market.ts, chat.ts, players.ts
  config/         city.ts (dims, palette, districts), metrics.ts (§7.3 formulas),
                  net.ts (MAX_GUESTS, cadences, limits)
  utils/          base64url.ts, fnv1a.ts, gauss.ts, mapClamp.ts, format.ts (price/pct)
tests/            layout.spec.ts, metrics.spec.ts, signaling.spec.ts, protocol.spec.ts,
                  simulated.spec.ts, format.spec.ts   (vitest, pure logic only)
```

---

## 13. Build phases & orchestration (GLM-5.2 captain / crew)

### 13.0 Orchestration model

**Roles.** The **captain** owns this document end-to-end: it decomposes phases into crew briefs, independently verifies acceptance criteria, merges branches in DAG order, and is the sole writer of the PROGRESS log (§17). **Crew** agents execute exactly one brief at a time in an isolated git worktree/branch and finish with a handoff report: files touched, deviations, quirks discovered, build/test output. Crew never edit this document.

**Dependency DAG & parallelism.**

```
        ┌─► M1 ─► M2 ─────┐
  M0 ───┤                 ├─► M5
        └─► M3 ──────► M4 ┘

  M4 requires M1 + M3 · M5 requires M2 + M4
```

Maximum useful parallelism is **two crew**: after M0 merges, Track A runs M1 → M2 (rendering + data) while Track B runs M3 (networking). Both tracks merge before M4 opens. Do **not** split a single phase across multiple crew unless it stalls — intra-phase splits buy little here and cost merges; if the captain does split one, it defines the seam as an explicit interface first.

**Contracts commit (before opening parallel tracks).** Immediately after M0 merges, the captain lands one small commit on main that both tracks build against: `net/protocol.ts` containing every type in §4.5 **and** §5.1 (`Env`, all payloads, `PeerInfo`, `ChatMsg`, `Quote`), plus the `config/net.ts` and `config/city.ts` constants.

**Frozen contracts (change-controlled).** `net/protocol.ts`, the engine facade surface (§11 bridge), Pinia store shapes (§11), the manifest schema (§6.1), and everything under `config/`. Crew MUST NOT modify these unilaterally; a needed change goes to the captain, who updates this document first, then re-briefs affected crew.

**Crew briefs.** Every brief is self-contained: the phase's task list and acceptance criteria **verbatim from this section**, pasted copies of the doc sections the phase depends on (don't make crew infer from repo archaeology), the §15 checklist lines relevant to the phase, and the frozen-contract list. Restate constraints in every brief — crew context does not carry over between tasks.

**Verification gate.** A phase is done only when the captain has run the acceptance steps itself on the merged result and `npm run build && npx vitest run` is green. Crew self-reports are inputs, not proof.

**Escalation.** If a MUST can't be met, crew stops and reports — no improvising. SHOULD deviations are allowed with justification in the handoff; the captain records accepted ones in PROGRESS. Ambiguity touching a frozen contract goes back to the captain; crew never silently guesses there.

**Phase gate:** a phase may start only when all of its DAG parents have merged and passed the verification gate.

### M0 — Scaffold & empty world *(small)*
Vite + Vue3 + TS strict + Pinia + Three. MenuScreen → WorldScreen. Scene, fog, ground grid, lighting, resize, rAF loop, fly controls + pointer lock (full §9), debug overlay, world clamps.
**Accept:** `npm run dev` → enter name → Start Solo → fly around an empty grid at 60 fps; Esc/Enter focus rules work; `npm run build` clean; no TS errors.

### M1 — City from manifest (simulated data) *(large)*
Manifest + validator + full default roster (§6.2). `layoutCity` + unit tests. Districts (slabs, name sprites). InstancedMesh buildings, colors, height tween. Metric switching (1/2/3) with §7.3 formulas + unit tests. Labels with LOD + repaint budget. Picking, hover highlight, InfoPanel, fly-to. Simulated provider + scheduler (solo) + unit tests. Toolbar + legend.
**Accept:** Solo mode shows the full 117-building city; prices tick every 5 s; heights animate; colors correct (verify a hand-computed case); metric keys re-scale the skyline; clicking any building opens correct info; fps ≥ 60; label repaints ≤ 8/frame (assert via debug counter).

### M2 — Live data *(medium)*
CoinGecko + Finnhub adapters, scheduler integration (budgets, backoff, staleness §5), Settings (key entry, demo toggle, LAN toggle placeholder), SIM/stale badges + banner, session open/closed dimming, CoinGecko id verification pass.
**Accept:** with a key: crypto updates ≤ 60 s, equities cycle ≈ 2 min, network tab shows ≤ 50 Finnhub calls/min; without a key: crypto live + equities SIM-badged; kill network → stale styling appears; restore → recovers. Quotes identical in UI and InfoPanel.

### M3 — Networking core: signaling, chat, roster *(large)*
Signaling codec + tests (§4.3 incl. fallback path), RTC wrapper (non-trickle, dual channels, state events), host/guest session logic, hello/welcome/roster/chat/sys/ping/error/bye (§4.4–4.5), validation + rate limits, SignalingModal both flows, ChatPanel, RosterPanel, status pill, host-leave banner, ROOM_FULL, name dedupe.
**Accept:** two browser profiles on localhost complete the copy-paste handshake; guest hydrates roster + chat tail; chat relays both ways; join/leave system messages fire; killing host tab shows the guest banner with working [Continue solo]; malformed/truncated codes produce friendly errors; version mismatch simulated (bump const) rejects cleanly.

### M4 — Avatars & movement streaming *(medium)*
`pos` channel wiring, 12 Hz sender gate, host relay, engine snapshot buffers + interpolation (§8.6), avatar meshes + name tags, stall fade, add/remove on roster.
**Accept:** with 3 peers (3 profiles), each sees the other two flying smoothly (no teleport-jitter at 12 Hz — verify interpolation by throttling to 5 Hz in debug); name tags readable; closing a guest removes its avatar everywhere within 15 s worst-case.

### M5 — Live-data-over-wire + polish + docs *(medium)*
`quotesDelta`/`quotesFull` broadcast + welcome snapshot; guests render host data with zero own fetching (assert: guest makes no API calls); backpressure guard; 5-min resync; toasts; help screen (controls, privacy/IP note, NAT limitation, "keep host tab visible"); README (run/build/deploy, key setup, roster editing guide, known limitations); final perf pass (§8.7-6 targets with 8 simulated peers).
**Accept:** full two-machine LAN test in LAN-only mode (no STUN, no internet needed except data APIs on host); a fresh guest joining mid-session sees identical prices to host within 1 s of welcome; Definition of Done (§16) checklist fully green.

**Working agreements (captain & crew):** conventional commits; one branch per phase (`m0-scaffold`, `m1-city`, …); captain merges in DAG order and rebases/merges Track B onto main after M2 lands, before opening M4; any added runtime dependency beyond §0 requires captain sign-off logged in PROGRESS; discovered API quirks and accepted deviations get dated PROGRESS entries; this file is the single source of truth and only the captain edits it.

---

## 14. Local multiplayer test procedure

1. `npm run dev`; open two browser **profiles** (or Chrome + Firefox) at `localhost:5173`.
2. Window A: Host a Room. Window B: Join → copy join code → paste into A's Invite → copy reply code → paste into B.
3. Localhost note: host/mDNS ICE candidates suffice — works even in LAN-only mode with zero internet.
4. Two-device LAN test: serve `npm run dev -- --host`, repeat over two machines, LAN-only ON.
5. Internet/NAT test: one peer on a phone hotspot, STUN ON. If `connectionState: failed`, you've likely hit symmetric NAT — expected limitation, verify the error UX reads well.

## 15. Risks & gotchas checklist (captain: fold the relevant lines into every crew brief)

- [ ] **Never** wrap Three objects in `reactive()`/`ref()` (§8.7-1) — this is the #1 way this app dies.
- [ ] Non-trickle ICE: export SDP only after gathering completes (or 4 s timeout) — §4.2.
- [ ] Guest creates data channels **before** `createOffer` — §4.2.
- [ ] `CompressionStream` feature-detect + `EML1u.` fallback; Clipboard API needs secure context → textarea fallback — §4.3.
- [ ] CoinGecko 429 backoff; Finnhub ≤ 50/min drip; never let both providers burst on tab-refocus (guard with elapsed-time checks, not naive `setInterval` alone).
- [ ] Background-tab timer throttling: host toast + tolerant cadence math — §4.6.
- [ ] Chat/labels/name tags render as **text only**; validate every inbound message shape; clamp lengths; rate-limit — §4.5.
- [ ] `bufferedAmount` check before large sends — §4.5.
- [ ] Keydown handlers must no-op while inputs are focused — §9.
- [ ] Finnhub `dp` can be null/degenerate after hours — fallback math in §5.3.
- [ ] Raycaster + InstancedMesh returns `instanceId` — map through the index table, don't assume ordering.
- [ ] Dispose textures/geometries on WorldScreen unmount (leave → menu → rejoin must not leak).
- [ ] API key never appears in any outbound peer message (grep test in M5).

## 16. Out of scope for v1 (parked v2 ideas)

Host migration; TURN relay; mobile touch controls; mesh (non-star) topology; binary position packing; historical sparklines in InfoPanel; day/night cycle; sound; QR-code signaling exchange; persistence of chat; dynamic top-N crypto roster; WebTransport/WebSocket alt transports; spectator URL sharing.

### Definition of Done (v1)

- [ ] All M0–M5 acceptance criteria pass, including the two-machine LAN-only test.
- [ ] `npm run build` output runs from any static file server with zero console errors.
- [ ] Solo mode is fully functional with no API key (all-SIM) and with key (live).
- [ ] 3-peer session: chat, join/leave messages, avatars, identical quotes on all peers.
- [ ] README covers setup, key config, roster editing, controls, privacy note, known NAT limitation.
- [ ] Vitest suite green; no `any` leaks in `protocol.ts`, `signaling.ts`, `metrics.ts`, `layout.ts`.

---

## 17. PROGRESS log (captain-only — newest first)

| Date | Phase | Author | Notes / deviations / discoveries |
|---|---|---|---|
| — | — | — | *(empty — begin with M0)* |
