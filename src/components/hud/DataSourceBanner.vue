<script setup lang="ts">
/**
 * §10 DataSourceBanner — global overlay (NOT inside TopBar) summarising the
 * live data state. Reads the M1 market store (read-only: providerStatus,
 * quotes) and the M0 settings store (finnhubKey / demoMode). Surfaced cases:
 *
 *   • Demo-data ON                        → "Demo data — all quotes simulated"
 *   • No Finnhub key + equities simulated → "No Finnhub key — equities simulated"
 *   • Any quote stale / provider 'stale'  → "Data stale — showing last known prices"
 *   • All live                            → no banner (a small status pill + gear only)
 *
 * The gear (top-right) opens `ui.modals.settings` and hosts `<SettingsModal>`
 * as a child (modals are excluded from WorldScreen's overlay glob; mounting
 * it here avoids touching App.vue). Quotes here are the SAME market store Map
 * the InfoPanel reads, so the two surfaces always agree (single source of truth).
 *
 * Per-building SIM badges + grey stale-price label styling are M1's labels
 * system (keys off `quote.source`/`quote.stale`) — not this file's concern.
 */
import { computed } from 'vue';
import { useMarketStore } from '../../stores/market';
import { useSettingsStore } from '../../stores/settings';
import { useUiStore } from '../../stores/ui';
import type { Quote, Instrument } from '../../net/protocol';
import SettingsModal from './SettingsModal.vue';

const market = useMarketStore();
const settings = useSettingsStore();
const ui = useUiStore();

function isEquity(inst: Instrument): boolean {
  return inst.category !== 'crypto';
}

/** Aggregate the current quote snapshot into banner-relevant counts. */
const summary = computed(() => {
  const qs = market.quotes as Map<string, Quote>;
  const manifest = market.manifest;
  const equityIds = new Set(manifest.filter(isEquity).map((m) => m.id));
  let simEquities = 0;
  let simCrypto = 0;
  let liveEquities = 0;
  let liveCrypto = 0;
  let staleCount = 0;
  let total = 0;
  for (const q of qs.values()) {
    total++;
    if (q.stale) staleCount++;
    if (q.source === 'simulated') {
      if (equityIds.has(q.id)) simEquities++;
      else simCrypto++;
    } else if (equityIds.has(q.id)) liveEquities++;
    else liveCrypto++;
  }
  return { simEquities, simCrypto, liveEquities, liveCrypto, staleCount, total };
});

type BannerKind = 'demo' | 'no-key' | 'stale' | 'down' | null;

const banner = computed<{ kind: BannerKind; text: string }>(() => {
  const s = summary.value;
  if (settings.demoMode) {
    return { kind: 'demo', text: 'Demo data — all quotes simulated' };
  }
  // No-key path: equities simulated while crypto is live (the spec'd no-key mode).
  const noKey = (settings.finnhubKey ?? '').trim().length === 0;
  if (noKey && s.simEquities > 0) {
    return { kind: 'no-key', text: 'No Finnhub key — equities simulated (add one in Settings)' };
  }
  // Stale / down: provider flag OR any quote stale.
  if (market.providerStatus === 'stale' || s.staleCount > 0) {
    return { kind: 'stale', text: 'Data stale — showing last known prices' };
  }
  return { kind: null, text: '' };
});

/** Status pill text for the always-on corner cluster. */
const pillText = computed(() => {
  const s = summary.value;
  if (settings.demoMode) return 'Demo · simulated';
  const noKey = (settings.finnhubKey ?? '').trim().length === 0;
  const parts: string[] = [];
  if (s.liveCrypto > 0) parts.push(`${s.liveCrypto} live crypto`);
  if (noKey) parts.push('equities SIM');
  else if (s.liveEquities > 0) parts.push(`${s.liveEquities} live`);
  if (s.staleCount > 0) parts.push(`${s.staleCount} stale`);
  return parts.length ? parts.join(' · ') : 'idle';
});

const pillClass = computed(() => {
  if (settings.demoMode) return 'pill amber';
  if ((settings.finnhubKey ?? '').trim().length === 0) return 'pill dim';
  if (market.providerStatus === 'stale' || summary.value.staleCount > 0) return 'pill amber';
  return 'pill green';
});

function openSettings(): void {
  ui.modals.settings = true;
}
function closeSettings(): void {
  ui.modals.settings = false;
}
</script>

<template>
  <div class="dsb-root">
    <!-- Always-on corner cluster: gear + status pill (top-left; top-right is
         the WorldScreen's own ← Menu button, top-center is TopBar). -->
    <div class="corner">
      <button class="gear" title="Settings" aria-label="Open settings" @click="openSettings">⚙</button>
      <span :class="pillClass">{{ pillText }}</span>
    </div>

    <!-- Global banner (only when something notable). -->
    <div v-if="banner.kind" class="banner" :class="banner.kind" role="status">
      <span class="dot" />
      {{ banner.text }}
    </div>

    <!-- Settings modal hosted here (modals are excluded from WorldScreen's glob). -->
    <SettingsModal v-if="ui.modals.settings" @close="closeSettings" />
  </div>
</template>

<style scoped>
.dsb-root {
  position: absolute;
  top: 8px;
  left: 8px;
  pointer-events: none;
  z-index: 35;
}

.corner {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  pointer-events: auto;
}
.gear {
  width: 1.9rem;
  height: 1.9rem;
  border-radius: 8px;
  background: rgba(8, 12, 18, 0.72);
  border: 1px solid var(--panel-border);
  color: var(--text);
  font-size: 1rem;
  line-height: 1;
  padding: 0;
}
.gear:hover { border-color: var(--accent); color: var(--accent); }

.pill {
  padding: 0.32rem 0.66rem;
  border-radius: 999px;
  font-size: 0.74rem;
  font-family: var(--mono);
  background: rgba(8, 12, 18, 0.72);
  border: 1px solid var(--panel-border);
  color: var(--text);
  white-space: nowrap;
}
.pill.green { color: #4ade80; border-color: rgba(74, 222, 128, 0.5); }
.pill.amber { color: #fbbf24; border-color: rgba(251, 191, 36, 0.5); }
.pill.dim { color: var(--text-dim); }

.banner {
  margin-top: 0.4rem;
  padding: 0.42rem 0.8rem;
  border-radius: 8px;
  font-size: 0.8rem;
  background: rgba(8, 12, 18, 0.86);
  border: 1px solid var(--panel-border);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  max-width: min(60vw, 26rem);
}
.banner .dot {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  flex: 0 0 auto;
}
.banner.no-key { color: #fbbf24; border-color: rgba(251, 191, 36, 0.45); }
.banner.no-key .dot { background: #fbbf24; }
.banner.demo { color: var(--accent); border-color: rgba(74, 168, 255, 0.45); }
.banner.demo .dot { background: var(--accent); }
.banner.stale { color: #fbbf24; border-color: rgba(251, 191, 36, 0.45); }
.banner.stale .dot { background: #fbbf24; }
.banner.down { color: var(--danger); border-color: rgba(255, 107, 107, 0.45); }
.banner.down .dot { background: var(--danger); }
</style>