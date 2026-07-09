<script setup lang="ts">
/**
 * TickerSidebar (§10) — right edge, below ChatPanel. Auto-mounted by the
 * WorldScreen `hud/*.vue` glob (name does not end in `Modal`).
 *
 * A scrollable, collapsible roster of EVERY manifest instrument (~117) grouped
 * by district, each row showing: ticker + category tag, dim truncated name,
 * price (formatPrice) or — when no quote yet, day-change % (colored),
 * a LIVE / WAITING badge (LIVE iff `market.firstLoadIds` has the id — answers
 * "has it had any live data yet"), and a relative "last updated" time computed
 * from `Quote.ts` and kept fresh by a local 1-s `setInterval` (cleared on
 * unmount per §15 dispose rules).
 *
 * District headers show `live / total` (mirrors LoadProgress). A search input
 * at the top filters rows by ticker/name.
 *
 * Anchor: right side, BELOW ChatPanel. ChatPanel is `top:48px; right:8px;
 * max-height:70vh` → its lowest extent is `48px + 70vh`. This panel sits at
 * `top: calc(48px + 70vh + 6px)` down to `bottom: 8px`, so it cannot overlap
 * ChatPanel (top-right), RosterPanel (top-left), InfoPanel (mid-left),
 * LoadProgress (bottom-left) or Toolbar (bottom-center). `pointer-events:auto`
 * on the panel; the WorldScreen `.hud-root` is `none`.
 *
 * Read-only on the market store; no mutations, no Three object enters Vue
 * reactivity (pure data display). Text nodes only — never `v-html`; ticker/name
 * come from the frozen manifest but render as text defensively.
 */
import { computed, onUnmounted, ref } from 'vue';
import { useMarketStore } from '../../stores/market';
import { useUiStore } from '../../stores/ui';
import { engine } from '../../engine/core';
import type { FlyToApi } from '../../engine/systems/flyTo';
import { formatPrice, formatChangePct, districtLabel } from '../../utils/format';
import type { Instrument, Quote } from '../../net/protocol';

const market = useMarketStore();
const ui = useUiStore();

const collapsed = ref<boolean>(false); // Admiral wants to see it by default.
const query = ref<string>('');

// 1-second wall-clock tick so relative times stay fresh without spamming the
// store. Cleared on unmount (no leak across menu↔world navigation).
const nowTick = ref<number>(Date.now());
let timer = 0;
if (typeof window !== 'undefined') {
  timer = window.setInterval(() => { nowTick.value = Date.now(); }, 1000);
}
onUnmounted(() => {
  if (timer) window.clearInterval(timer);
  timer = 0;
});

/** Manifest (stable) — one read; reads off the store are reactive via ref. */
const manifest = computed<Instrument[]>(() => market.manifest as Instrument[]);
/** Quotes Map (shallowRef — reassignment from applyDelta re-triggers us). */
const quotesMap = computed<Map<string, Quote>>(
  () => market.quotes as Map<string, Quote>,
);
/** Ids that have had at least one LIVE (source !== 'simulated') quote. */
const liveIds = computed<Set<string>>(() => market.firstLoadIds as Set<string>);

const q = computed(() => query.value.trim().toLowerCase());

/** Instruments grouped by district, filtered by the search query. */
const districts = computed(() => {
  const list = manifest.value;
  const filter = q.value;
  const byId = new Map<string, Instrument[]>();
  for (const inst of list) {
    if (filter) {
      const hay = (inst.ticker + ' ' + inst.name).toLowerCase();
      if (!hay.includes(filter)) continue;
    }
    const arr = byId.get(inst.district) ?? [];
    arr.push(inst);
    byId.set(inst.district, arr);
  }
  const out: Array<{ district: string; label: string; live: number; total: number; rows: Instrument[] }> = [];
  for (const [district, rows] of byId) {
    rows.sort((a, b) => a.ticker.localeCompare(b.ticker));
    let live = 0;
    const liveSet = liveIds.value;
    for (const r of rows) if (liveSet.has(r.id)) live++;
    out.push({ district, label: districtLabel(district), live, total: rows.length, rows });
  }
  out.sort((a, b) => a.district.localeCompare(b.district));
  return out;
});

/** Total live across all districts (header summary). */
const summary = computed(() => {
  const list = manifest.value;
  const liveSet = liveIds.value;
  let live = 0;
  for (const inst of list) if (liveSet.has(inst.id)) live++;
  return { live, total: list.length };
});

/** Relative "N s/min ago" from `Quote.ts`, fresh every tick. */
function relTime(ts: number | undefined): string {
  if (!ts) return '—';
  const secs = Math.max(0, Math.round((nowTick.value - ts) / 1000));
  if (secs < 2) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function priceOf(inst: Instrument): string {
  const qt = quotesMap.value.get(inst.id);
  return qt ? formatPrice(qt.price) : '—';
}
function changeOf(inst: Instrument): { text: string; cls: string } {
  const qt = quotesMap.value.get(inst.id);
  if (!qt) return { text: '—', cls: 'neutral' };
  const cl = qt.changePct > 0 ? 'pos' : qt.changePct < 0 ? 'neg' : 'neutral';
  return { text: formatChangePct(qt.changePct), cls: cl };
}
function isLive(inst: Instrument): boolean {
  return liveIds.value.has(inst.id);
}
function lastTs(inst: Instrument): number | undefined {
  return quotesMap.value.get(inst.id)?.ts;
}

/** Select on click (opens InfoPanel / mirrors in-world pick). */
function selectRow(id: string): void {
  ui.selectedInstrumentId = id;
}
/** Optional double-click affordance: fly-to the instrument. */
function flyToRow(id: string): void {
  ui.selectedInstrumentId = id;
  (engine.api.flyTo as FlyToApi | undefined)?.go(id);
}
</script>

<template>
  <div class="ticker-sidebar" :class="{ collapsed }">
    <button class="header" @click="collapsed = !collapsed">
      <span class="title">Tickers · {{ summary.live }}/{{ summary.total }}</span>
      <span class="chev">{{ collapsed ? '◂' : '▸' }}</span>
    </button>

    <div v-if="!collapsed" class="body">
      <div class="search-row">
        <input
          v-model="query"
          class="search"
          type="text"
          placeholder="Filter ticker / name…"
          spellcheck="false"
        />
      </div>

      <div class="scroll">
        <p v-if="districts.length === 0" class="empty">No instruments match.</p>
        <details v-for="d in districts" :key="d.district" class="district" open>
          <summary class="district-head">
            <span class="district-label">{{ d.label }}</span>
            <span class="district-count" :class="{ all: d.live >= d.total }">{{ d.live }}/{{ d.total }}</span>
          </summary>
          <ul class="rows">
            <li
              v-for="inst in d.rows"
              :key="inst.id"
              class="row"
              :class="{ selected: ui.selectedInstrumentId === inst.id }"
              @click="selectRow(inst.id)"
              @dblclick="flyToRow(inst.id)"
            >
              <div class="row-main">
                <span class="ticker">{{ inst.ticker }}</span>
                <span class="cat">{{ inst.category }}</span>
              </div>
              <div class="row-name">{{ inst.name }}</div>
              <div class="row-data">
                <span class="price">{{ priceOf(inst) }}</span>
                <span class="chg" :class="changeOf(inst).cls">{{ changeOf(inst).text }}</span>
              </div>
              <div class="row-foot">
                <span class="badge" :class="isLive(inst) ? 'live' : 'waiting'">
                  {{ isLive(inst) ? 'LIVE' : 'WAITING' }}
                </span>
                <span class="last">{{ relTime(lastTs(inst)) }}</span>
              </div>
            </li>
          </ul>
        </details>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ticker-sidebar {
  position: absolute;
  /* Below ChatPanel (top:48 + max-height:70vh) so no overlap. */
  top: calc(48px + 70vh + 6px);
  right: 8px;
  bottom: 8px;
  width: 19rem;
  display: flex;
  flex-direction: column;
  background: rgba(8, 12, 18, 0.86);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  pointer-events: auto; /* interactive — rest of .hud-root is none */
  z-index: 30;
  overflow: hidden;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  background: transparent;
  border: none;
  color: var(--text);
  padding: 0.45rem 0.6rem;
  font-size: 0.8rem;
  text-align: left;
}
.chev { color: var(--text-dim); }

.body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
}

.search-row {
  padding: 0 0.5rem 0.4rem;
}
.search {
  width: 100%;
  background: #0a1119;
  color: var(--text);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 0.32rem 0.5rem;
  font-size: 0.78rem;
  outline: none;
}
.search:focus { border-color: var(--accent); }

.scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 0 0.4rem 0.4rem;
}

.empty {
  margin: 0.6rem 0.4rem;
  font-size: 0.78rem;
  color: var(--text-dim);
  font-style: italic;
}

.district {
  margin-bottom: 0.3rem;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  background: rgba(15, 22, 32, 0.6);
}
.district-head {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.36rem 0.5rem;
  font-size: 0.78rem;
  color: var(--text);
}
.district-head::-webkit-details-marker { display: none; }
.district-label { font-weight: 600; }
.district-count {
  font-family: var(--mono);
  font-size: 0.7rem;
  color: var(--text-dim);
  border: 1px solid var(--panel-border);
  border-radius: 999px;
  padding: 0 0.4rem;
}
.district-count.all { color: #22c07a; border-color: rgba(34, 192, 122, 0.4); }

.rows {
  list-style: none;
  margin: 0;
  padding: 0.1rem 0.2rem 0.3rem;
}

.row {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto auto;
  gap: 0.1rem 0.5rem;
  align-items: center;
  padding: 0.28rem 0.4rem;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s ease;
}
.row:hover { background: rgba(255, 255, 255, 0.05); }
.row.selected { background: rgba(74, 168, 255, 0.14); outline: 1px solid rgba(74, 168, 255, 0.35); }

.row-main {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}
.ticker {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 0.8rem;
  color: var(--text);
}
.cat {
  font-size: 0.6rem;
  color: var(--text-dim);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  padding: 0 0.25rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.row-name {
  grid-column: 1 / -1;
  font-size: 0.7rem;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-data {
  grid-column: 1 / -1;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--mono);
  font-size: 0.74rem;
}
.price { color: var(--text); }
.chg.neutral { color: var(--text-dim); }
.chg.pos { color: #22c07a; }
.chg.neg { color: #d64550; }

.row-foot {
  grid-column: 1 / -1;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.4rem;
}
.badge {
  font-family: var(--mono);
  font-size: 0.62rem;
  font-weight: 700;
  padding: 0 0.35rem;
  border-radius: 4px;
  letter-spacing: 0.04em;
}
.badge.live {
  color: #22c07a;
  border: 1px solid rgba(34, 192, 122, 0.45);
  background: rgba(34, 192, 122, 0.08);
}
.badge.waiting {
  color: #f5a623;
  border: 1px solid rgba(245, 166, 35, 0.45);
  background: rgba(245, 166, 35, 0.08);
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
.last {
  font-size: 0.62rem;
  color: var(--text-dim);
  font-family: var(--mono);
}

.ticker-sidebar.collapsed {
  top: calc(48px + 70vh + 6px);
  bottom: auto;
  width: auto;
  max-height: none;
}
</style>