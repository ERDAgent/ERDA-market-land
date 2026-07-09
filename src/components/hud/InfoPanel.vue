<script setup lang="ts">
/**
 * §10 InfoPanel — pick focus. Auto-mounted by WorldScreen's hud/*.vue glob.
 * Shows the selected instrument's name/ticker/district/price/day%/mcap,
 * source + SIM/stale badge, session, last-updated, proxyNote, and a
 * [Fly to] button (engine.api.flyTo). Reacts to market.quotes (live ticks)
 * and ui.selectedInstrumentId (set by the 'pick' event bridge).
 */
import { computed } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useMarketStore } from '../../stores/market';
import { engine } from '../../engine/core';
import { formatPrice, formatChangePct, formatMarketCap, districtLabel } from '../../utils/format';
import type { FlyToApi } from '../../engine/systems/flyTo';

const ui = useUiStore();
const market = useMarketStore();

const instrument = computed(() => {
  const id = ui.selectedInstrumentId;
  if (!id) return null;
  return market.manifest.find((m) => m.id === id) ?? null;
});

const quote = computed(() => {
  const id = ui.selectedInstrumentId;
  if (!id) return null;
  const qs = market.quotes as Map<string, import('../../net/protocol').Quote>;
  return qs.get(id) ?? null;
});

const show = computed(() => instrument.value != null);

function close(): void {
  ui.selectedInstrumentId = null;
}

function flyTo(): void {
  const id = ui.selectedInstrumentId;
  if (id) (engine.api.flyTo as FlyToApi | undefined)?.go(id);
}

const lastUpdated = computed(() => {
  const ts = quote.value?.ts;
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString();
});
</script>

<template>
  <div v-if="show && instrument" class="panel">
    <div class="head">
      <div class="name">
        <span class="ticker">{{ instrument.ticker }}</span>
        <span class="full">{{ instrument.name }}</span>
      </div>
      <button class="x" aria-label="Close info" @click="close">×</button>
    </div>

    <dl>
      <div class="row"><dt>District</dt><dd>{{ districtLabel(instrument.district) }}</dd></div>
      <div class="row">
        <dt>Price</dt>
        <dd>
          {{ quote ? formatPrice(quote.price) : '—' }}
          <span v-if="quote?.session === 'closed'" class="closed-note">market closed — last price</span>
        </dd>
      </div>
      <div class="row">
        <dt>Day %</dt>
        <dd :class="quote && quote.changePct >= 0 ? 'pos' : 'neg'">
          {{ quote ? formatChangePct(quote.changePct) : '—' }}
        </dd>
      </div>
      <div class="row"><dt>Market cap</dt><dd>{{ formatMarketCap(instrument.mcapUSD) }}</dd></div>
      <div class="row">
        <dt>Source</dt>
        <dd>
          <span class="badge" :class="quote?.source">{{ quote?.source ?? '—' }}</span>
          <span v-if="quote?.source === 'simulated'" class="sim">SIM</span>
          <span v-if="quote?.stale" class="stale">stale</span>
        </dd>
      </div>
      <div class="row"><dt>Session</dt><dd>{{ quote?.session ?? '—' }}</dd></div>
      <div class="row"><dt>Last updated</dt><dd>{{ lastUpdated }}</dd></div>
    </dl>

    <p v-if="instrument.proxyNote" class="note">{{ instrument.proxyNote }}</p>

    <div class="foot">
      <button class="fly" :disabled="!quote" @click="flyTo">Fly to</button>
    </div>
  </div>
</template>

<style scoped>
.panel {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: min(86vw, 20rem);
  padding: 0.85rem 0.95rem 0.75rem;
  background: rgba(8, 12, 18, 0.92);
  border: 1px solid var(--panel-border);
  border-radius: 12px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
  pointer-events: auto;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.6rem;
}
.ticker {
  display: block;
  font-family: var(--mono);
  font-size: 1.26rem;
  font-weight: 700;
  color: var(--text);
}
.full {
  display: block;
  font-size: 0.98rem;
  color: var(--text-dim);
}
.x {
  background: transparent;
  border: none;
  color: var(--text-dim);
  font-size: 1.56rem;
  line-height: 1;
  padding: 0 0.3rem;
}
.x:hover { color: var(--text); }

dl { margin: 0; }
.row {
  display: flex;
  justify-content: space-between;
  gap: 0.6rem;
  padding: 0.22rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  font-size: 0.98rem;
}
.row dt { color: var(--text-dim); }
.row dd { color: var(--text); font-family: var(--mono); text-align: right; }
.pos { color: #4dff66 !important; }
.neg { color: #ff4540 !important; }

.badge {
  display: inline-block;
  padding: 0 0.4rem;
  border-radius: 4px;
  font-size: 0.86rem;
  background: #1b2a3a;
  color: var(--text);
}
.sim {
  margin-left: 0.3rem;
  padding: 0 0.32rem;
  border-radius: 4px;
  font-size: 0.84rem;
  background: var(--accent);
  color: #06121c;
  font-weight: 700;
}
.stale {
  margin-left: 0.3rem;
  font-size: 0.86rem;
  color: var(--text-dim);
}
.closed-note {
  display: block;
  margin-top: 0.2rem;
  font-size: 0.84rem;
  color: var(--text-dim);
  font-style: italic;
}

.note {
  margin: 0.5rem 0 0;
  color: var(--text-dim);
  font-size: 0.94rem;
  line-height: 1.4;
  font-style: italic;
}

.foot {
  margin-top: 0.6rem;
  display: flex;
  justify-content: flex-end;
}
.fly {
  background: var(--accent);
  color: #06121c;
  border: none;
  border-radius: 8px;
  padding: 0.45rem 0.85rem;
  font-weight: 600;
  font-size: 1.02rem;
}
.fly:hover:not(:disabled) { background: var(--accent-hover); }
</style>