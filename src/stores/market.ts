// src/stores/market.ts — §11 market store (Composition-API style).
//
// Holds the instrument roster + the live quotes Map + the active height metric.
// `quotes` is a `shallowRef`-wrapped Map — bridges/systems read it without
// deep-tracking 117 entries in Vue reactivity (§8.7-1: no Three object here,
// just plain data). `applyDelta` merges + reassigns so `watch`-ers fire once.
//
// This is the seam: M3's welcome reads `engine.api.market.snapshot()`, M5
// subscribes to deltas. M1 owns the full shape; later phases only add wiring.

import { defineStore } from 'pinia';
import { shallowRef, ref } from 'vue';
import type { Instrument, Quote } from '../net/protocol';
import { instruments as DEFAULT_MANIFEST } from '../data/manifest/validate';
import type { HeightMetric } from '../config/metrics';

export type ProviderStatus = 'idle' | 'live' | 'stale';

export const useMarketStore = defineStore('market', () => {
  const manifest = ref<Instrument[]>(DEFAULT_MANIFEST);
  const quotes = shallowRef<Map<string, Quote>>(new Map());
  const metric = ref<HeightMetric>(1);
  const lastUpdated = ref<number>(0);
  const providerStatus = ref<ProviderStatus>('idle');
  /** Instrument ids that have received at least one LIVE (source !== 'simulated')
   *  quote. Drives the per-district loader fill in `LoadProgress.vue`. A `Set`
   *  in a `shallowRef` — reassigned (new Set) on mutation so watchers fire. */
  const firstLoadIds = shallowRef<Set<string>>(new Set());
  /** Epoch ms of the next Finnhub burst, set by the scheduler via the bridge's
   *  `onNextRefresh` sink. Drives the `LoadProgress.vue` refresh countdown. */
  const nextRefreshTs = ref<number | null>(null);

  /** Mark `id` live (first non-simulated quote). Reassigns the Set only when a
   *  NEW id is added, so watchers don't fire on no-op merges. */
  function markFirstLoad(id: string): void {
    if (firstLoadIds.value.has(id)) return;
    const next = new Set(firstLoadIds.value);
    next.add(id);
    firstLoadIds.value = next;
  }

  /**
   * Merge `delta` into `quotes` (overwrite by id, latest wins) and reassign the
   * Map so shallow watchers observe the change. Updates `lastUpdated` to the
   * newest quote timestamp in the batch.
   */
  function applyDelta(delta: Quote[]): void {
    if (delta.length === 0) return;
    const next = new Map(quotes.value);
    let newest = lastUpdated.value;
    for (const q of delta) {
      next.set(q.id, q);
      if (q.ts > newest) newest = q.ts;
      if (q.source !== 'simulated') markFirstLoad(q.id);
    }
    quotes.value = next;
    lastUpdated.value = newest;
    if (providerStatus.value === 'idle') providerStatus.value = 'live';
  }

  /** Return a plain `Quote[]` snapshot of every known quote (for welcome/broadcast). */
  function snapshot(): Quote[] {
    return Array.from(quotes.value.values());
  }

  /** Replace the whole quote set (used by welcome / quotesFull resync). */
  function applyFull(all: Quote[]): void {
    const next = new Map<string, Quote>();
    let newest = 0;
    for (const q of all) {
      next.set(q.id, q);
      if (q.ts > newest) newest = q.ts;
      if (q.source !== 'simulated') markFirstLoad(q.id);
    }
    quotes.value = next;
    if (newest > 0) lastUpdated.value = newest;
    providerStatus.value = all.length > 0 ? 'live' : 'idle';
  }

  function setNextRefresh(ts: number | null): void {
    nextRefreshTs.value = ts;
  }

  function setMetric(m: HeightMetric): void {
    metric.value = m;
  }

  return {
    manifest,
    quotes,
    metric,
    lastUpdated,
    providerStatus,
    firstLoadIds,
    nextRefreshTs,
    applyDelta,
    applyFull,
    snapshot,
    setNextRefresh,
    setMetric,
  };
});