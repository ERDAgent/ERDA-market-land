# ERDA Market Land

A 3D trading floor in your browser. Fly a city skyline where each building is a
tradeable instrument; building height encodes a metric (day-change %, market cap,
or price) and color encodes day-change direction. Live quotes come from
**Finnhub** (equities/ETFs) or **CoinGecko** (crypto), with an offline
**Simulated** random-walk provider so the app runs with zero keys. Multiplayer
(peers flying together + shared quotes) is P2P over WebRTC with **manual
copy-paste signaling** — no signaling server, no account.

> **Solo** is a host with zero guests. **Host** is the data authority: it runs
> the scheduler and broadcasts quotes to peers. **Guests never make API calls** —
> they receive quote snapshots from the host over the wire.

---

## Quick start

```bash
npm install        # once
npm run dev        # dev server on http://localhost:5173
# production:
npm run build      # type-check (vue-tsc --noEmit) + vite build → dist/
npm run preview    # serve dist/ on localhost
npm test           # vitest run --passWithNoTests
```

Requirements: Node 18+, a modern browser (WebRTC + CompressionStream baseline).

### Deploying the build

`npm run build` emits a static site in `dist/`. Serve it from **any** static
file server at the domain root:

```bash
cd dist && python3 -m http.server 8080
# or: npx serve dist
```

Assets use absolute paths (`/assets/...`), so serve at the domain root. There is
no backend, no env file, and no server-side state — everything runs in the
browser.

---

## Running modes

1. **Solo (no key).** Enter a display name → **Start Solo**. The Simulated
   provider walks every instrument; the city populates immediately. Fully
   functional offline.
2. **Solo (with Finnhub key).** Open **Settings** (gear), paste a Finnhub API
   key, close Settings, **Start Solo**. Non-crypto instruments route to Finnhub;
   crypto routes to CoinGecko. Keep the **Demo mode** toggle off to use live
   data, on to force everything to Simulated.
3. **Host a room.** (Networking UI.) Host → copy-paste a guest's join code out
   of band → copy the reply back. The host is the data authority and broadcasts
   quotes to every guest.
4. **Join a room.** Guest → copy your join code, send it to the host out of band,
   paste the host's reply. **Guests make ZERO API calls** — they hydrate from the
   `welcome` snapshot and stay in sync via `quotesDelta` / `quotesFull`.

---

## Key setup

- **Finnhub** (equities/ETFs): get a free key at <https://finnhub.io>. Paste it
  in **Settings → Finnhub API key**. The key is stored in `localStorage` only
  (key `eml.settings.v1`); it is **never transmitted to peers** — it is used
  solely as a `token=` query param on the host's own Finnhub HTTP calls. This is
  asserted by `tests/key-never-over-wire.spec.ts`.
- **CoinGecko** (crypto): no key required for the free tier used here.
- **No key at all** ⇒ the scheduler routes everything to the Simulated provider
  (demo mode). The app is fully functional without any key.

Settings persist locally per browser. Clearing localStorage clears the key.

---

## Editing the roster

The tradeable universe is the frozen manifest at
`src/data/manifest/instruments.json` (117 instruments by default). Each entry:

```jsonc
{
  "id": "aapl",                       // lowercase slug, unique
  "ticker": "AAPL",                    // display ticker
  "name": "Apple Inc.",
  "category": "stock",                 // index | stock | crypto | commodity | fx
  "district": "tech",                  // one of 9 frozen districts (see below)
  "provider": "finnhub",              // finnhub | coingecko (crypto must be coingecko)
  "providerSymbol": "AAPL",           // finnhub ticker OR CoinGecko coin id (crypto)
  "proxyNote": "ETF proxy for ...",   // optional, shown in InfoPanel
  "refPrice": 225,                    // rough recent price (sim seed)
  "mcapUSD": 3000000000000,           // optional (stocks/crypto/ETFs)
  "sizeTier": 3                       // 1 | 2 | 3 (height-class hint)
}
```

Districts (frozen grid in `src/config/city.ts`): `indexes`, `tech`, `finance`,
`healthcare`, `consumer`, `energy_industrial`, `crypto`, `commodities`, `fx`.

Rules enforced by `src/data/manifest/validate.ts`:

- Unique `id` and unique `ticker`.
- Crypto instruments MUST use `provider: "coingecko"` (and a CoinGecko
  `providerSymbol`); non-crypto use `"finnhub"`.
- The district must be one of the nine frozen districts.

To add an instrument, append a JSON object to the array matching the schema. Do
not remove the frozen 117 without re-validating district counts; the validator
runs at module load and surfaces any errors. Editing the manifest is the only
supported way to change the roster — it is loaded eagerly and hashed into the
protocol's `manifestHash` so a host and guest with different manifests detect
the mismatch.

---

## Controls

| Input | Action |
| --- | --- |
| **Click** | Lock pointer to look around. **Esc** releases. (Touch: drag to look.) |
| **W A S D** | Move forward / left / back / right (camera-relative) |
| **Space** / **C** | Up / down |
| **Shift** (hold) | Sprint ×3 |
| **Scroll wheel** | Adjust base speed 4–60 u/s (default 15), shown briefly in the HUD |
| **Enter** | Focus chat input (releases pointer lock); **Esc** returns to the world |
| **`** (backtick) | Debug overlay — fps, draw calls, peers, data budget |
| **F** | Fly to the selected (clicked) building |
| **1 / 2 / 3** | Height metric: day-change % / market cap / price |

Click a building to select it; the **InfoPanel** (left) shows name, district,
price, day %, market cap, source, session, last-updated, and a Fly-to button.
When the market is **closed** (`session === 'closed'`, US regular hours
Mon–Fri 09:30–16:00 ET for Finnhub equities), the InfoPanel shows
*"market closed — last price"* and building colors are desaturated (saturation
×0.6). When a quote is **stale** (older than 3× its provider cadence), its label
renders the price in grey with a small "stale" indicator.

Chat: type in the chat panel; messages relay host→all. Roster + join/leave
toasts appear bottom-center.

---

## Multiplayer: signaling + networking

- **Manual copy-paste signaling** (no server): the guest copies an offer code
  and sends it to the host out of band (any chat app); the host pastes it,
  generates a reply code, and sends it back; the guest pastes the reply. Only
  two messages exchange, end-to-end.
- **Two DataChannels** per peer: `rel` (ordered/reliable — chat, roster, quotes,
  control) and `pos` (unreliable/unordered — avatar positions at 12 Hz).
- **Quotes over the wire** (M5): the host broadcasts `quotesDelta` (changed
  instruments only, coalesced ≤ 1/s) and `quotesFull` (full snapshot on a
  5-minute resync cadence). The `welcome` message carries the initial quote
  snapshot, so a fresh guest sees prices identical to the host within ~1 s of
  joining. Guests apply these to their market store and never fetch themselves.
- **Backpressure**: large sends (`welcome`, `quotesFull`) are guarded — before
  each send the host checks `bufferedAmount < BUFFER_HIGH` (1 MB) and, if
  exceeded, waits for `bufferedamountlow` at `BUFFER_LOW_THRESHOLD` (256 KB)
  via the frozen `bufferedAmountLow` helper. No send is dropped; it is deferred.

---

## Privacy

- **Signaling codes carry ICE candidates**, which include IP info. Browsers
  mDNS-mask local IPs; the STUN-derived public IP appears unless **LAN-only
  mode** is on. Share codes only with people you would video-call.
- **API keys never leave the host's browser.** The Finnhub key lives in
  `localStorage` and is used only for the host's outbound HTTP calls to Finnhub.
  It is never serialized into any peer envelope — verified by
  `tests/key-never-over-wire.spec.ts` (records every outbound `broadcastRel`
  envelope and asserts no transmitted object contains a `finnhubKey`-shaped
  string or property).
- **Guests make zero API calls.** A guest's market bridge skips the scheduler
  (role-guard in `src/bridges/market.ts`), so providers never instantiate on a
  guest — verified by `tests/no-api-on-guest.spec.ts`.

---

## NAT / network limitation

The app uses **STUN** (a free, stateless utility) and deliberately has **no
TURN relay server**. Over the open internet, some **symmetric NAT / CGNAT**
pairs will fail to establish a peer connection — this is a known limitation.
**LAN-only mode** (toggle in Settings; no ICE servers) works on a shared local
network with zero internet. Enable LAN-only when everyone is on the same Wi-Fi.

> **Keep the host's tab visible.** The host drives quote updates for everyone;
> backgrounding the host tab degrades update cadence for all peers (browsers
> throttle timers/`requestAnimationFrame` in background tabs). A toast reminds
> the host when the tab is backgrounded.

---

## Architecture (brief)

- **Vue 3 + Pinia** for UI/state; **Three.js** (imperative) for the 3D city.
- **Engine** (`src/engine/core.ts`): a singleton owning the scene, a single
  `requestAnimationFrame` loop, and a `systems/*.ts` registry (buildings, labels,
  avatars, picking, fly-to) discovered by glob.
- **Bridges** (`src/bridges/*.ts`): glob-discovered wirings between Pinia stores
  and the engine (market, connection, avatars, quotes-broadcast). One-time,
  idempotent.
- **Providers** (`src/data/providers/*.ts`): self-registering `QuoteProvider`s
  discovered by the scheduler's glob. `simulated` ships in-box; `coingecko` and
  `finnhub` are the live providers.
- **Net** (`src/net/*`): the WebRTC plumbing, host/guest session state, and the
  frozen wire protocol (`protocol.ts`). The wire envelope is `Env<T>` with a
  typed `MsgPayload[T]`; `protocol.ts` and `config/*` are change-controlled
  contracts.

See `PROJECT_PLAN.md` for the full spec (§0–§16).

---

## Tests

```bash
npm run build && npx vitest run --passWithNoTests
```

Key suites: contracts, protocol, scheduler cadence, providers, layout, metrics,
format, signaling, pos-sender, and the M5 gates: `tests/quotes-broadcast.spec.ts`
(delta/full fan-out + backpressure), `tests/no-api-on-guest.spec.ts` (zero guest
fetches), `tests/key-never-over-wire.spec.ts` (key isolation).