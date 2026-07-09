<script setup lang="ts">
/**
 * §10 LoadProgress — auto-mounted overlay (hud/*.vue glob in WorldScreen).
 *
 * Live-data first-load surface for the Finnhub burst-then-wait UX:
 *   • per-district loaders: for every NON-cRYPTO district whose instruments are
 *     not yet 100% live (have received at least one non-simulated quote), show a
 *     small "Loading <district>…" row with a live/total fill bar. Districts at
 *     100% live drop out; once ALL non-crypto districts are 100% live the whole
 *     loader section hides.
 *   • refresh countdown: "Next data refresh in N s" computed from
 *     `market.nextRefreshTs` (set by the scheduler via the bridge's
 *     `onNextRefresh` sink). Hidden when N ≤ 0 (a burst is in progress) or there
 *     is no scheduled burst.
 *
 * Hidden entirely when there is no Finnhub key (no-live mode) or demo-mode is
 * on — this is a live-data progress surface, irrelevant otherwise. Bottom-left,
 * low z-index (above the scene, below modals), `pointer-events: none` — purely
 * informational, never blocks clicks.
 */
import { computed, onUnmounted, ref } from 'vue';
import { useMarketStore } from '../../stores/market';
import { useSettingsStore } from '../../stores/settings';
import type { Instrument } from '../../net/protocol';

const market = useMarketStore();
const settings = useSettingsStore();

/** Whole surface hides in no-live / demo modes. */
const liveMode = computed(
  () => !settings.demoMode && (settings.finnhubKey ?? '').trim().length > 0,
);

/** Non-crypto instruments grouped by district (the live-data roster). */
const districtRows = computed(() => {
  const manifest = market.manifest as Instrument[];
  const live = market.firstLoadIds as Set<string>;
  const byDistrict = new Map<string, { total: number; live: number }>();
  for (const inst of manifest) {
    if (inst.category === 'crypto') continue; // crypto = CoinGecko, not this surface
    const row = byDistrict.get(inst.district) ?? { total: 0, live: 0 };
    row.total++;
    if (live.has(inst.id)) row.live++;
    byDistrict.set(inst.district, row);
  }
  // Only districts still <100% live are shown; all-100% ⇒ loader section hides.
  const rows: Array<{ district: string; live: number; total: number; pct: number }> = [];
  for (const [district, r] of byDistrict) {
    if (r.live >= r.total) continue;
    rows.push({ district, live: r.live, total: r.total, pct: r.total > 0 ? r.live / r.total : 0 });
  }
  // Stable ordering by district name.
  rows.sort((a, b) => a.district.localeCompare(b.district));
  return rows;
});

const loaderVisible = computed(() => districtRows.value.length > 0);

// 1-second ticker so the countdown recomputes off wall-clock time.
const now = ref(Date.now());
let timer = 0;
function tick(): void {
  now.value = Date.now();
}
if (typeof window !== 'undefined') {
  timer = window.setInterval(tick, 1000);
}
onUnmounted(() => {
  if (timer) window.clearInterval(timer);
  timer = 0;
});

/** Whole seconds until the next burst; null when no burst scheduled / in progress. */
const countdownSecs = computed<number | null>(() => {
  const ts = market.nextRefreshTs;
  if (ts == null) return null;
  const secs = Math.ceil((ts - now.value) / 1000);
  return secs > 0 ? secs : null;
});

const countdownVisible = computed(() => countdownSecs.value != null);

let loggedFull = false;
const surfaceVisible = computed(() => liveMode.value && (loaderVisible.value || countdownVisible.value));
// One diagnostic log when the live roster fully loads (eml:load tag).
const wasLoading = ref<boolean | null>(null);
const logFull = computed(() => {
  const loading = loaderVisible.value;
  if (wasLoading.value === true && !loading && !loggedFull) {
    loggedFull = true;
    console.log('[eml:load] all non-crypto districts live');
  }
  wasLoading.value = loading;
  return loading;
});
void logFull;
</script>

<template>
  <div v-if="surfaceVisible" class="load-progress" aria-live="polite">
    <div v-if="loaderVisible" class="loaders">
      <div v-for="row in districtRows" :key="row.district" class="row">
        <div class="label">
          <span class="dot" />
          Loading {{ row.district }}…
          <span class="count">{{ row.live }}/{{ row.total }}</span>
        </div>
        <div class="bar"><div class="fill" :style="{ width: row.pct * 100 + '%' }" /></div>
      </div>
    </div>
    <div v-if="countdownVisible" class="countdown">Next data refresh in {{ countdownSecs }} s</div>
  </div>
</template>

<style scoped>
.load-progress {
  position: absolute;
  bottom: 10px;
  left: 10px;
  z-index: 10; /* above the scene, below modals */
  pointer-events: none;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  max-width: min(40vw, 16rem);
  font-family: var(--mono);
}

.loaders {
  display: flex;
  flex-direction: column;
  gap: 0.32rem;
  padding: 0.5rem 0.6rem;
  background: rgba(8, 12, 18, 0.72);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 0.22rem;
}

.label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.74rem;
  color: var(--text);
}
.label .dot {
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 50%;
  background: var(--accent);
  flex: 0 0 auto;
  opacity: 0.85;
}
.label .count {
  margin-left: auto;
  color: var(--text-dim);
  font-size: 0.68rem;
}

.bar {
  height: 4px;
  width: 100%;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 2px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.25s ease-out;
}

.countdown {
  padding: 0.32rem 0.6rem;
  font-size: 0.72rem;
  color: var(--text);
  background: rgba(8, 12, 18, 0.72);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  white-space: nowrap;
}
</style>