<script setup lang="ts">
/**
 * §10 Toolbar — height-metric switcher (1/2/3) + legend + label repaint debug.
 * Auto-mounted by WorldScreen's `hud/*.vue` glob (name does not end in Modal).
 *
 * Keys 1/2/3 switch the market metric (reactive → buildings recompute heights);
 * `F` flies to the selected building via `engine.api.flyTo`. The per-frame label
 * repaint count is surfaced when the backtick debug overlay is open (§8.3 budget
 * asserted here).
 */
import { onMounted, onUnmounted, ref, computed } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useMarketStore } from '../../stores/market';
import { engine } from '../../engine/core';
import type { HeightMetric } from '../../config/metrics';
import type { FlyToApi } from '../../engine/systems/flyTo';
import type { LabelsApi } from '../../engine/systems/labels';

const ui = useUiStore();
const market = useMarketStore();

const metrics: { key: HeightMetric; label: string; hint: string }[] = [
  { key: 1, label: '1 · Day %', hint: 'h = 4 + 46·clamp(|Δ%|/5)  (±5% pegs)' },
  { key: 2, label: '2 · Mkt Cap', hint: 'h = mapClamp(log10(mcap),[8.5,13.3],[3,60])' },
  { key: 3, label: '3 · Price', hint: 'h = mapClamp(log10(price),[−2,5.1],[2,58])' },
];

const legendOpen = ref(false);
const activedMetric = computed(() => market.metric as HeightMetric);
const repaints = ref(0);
let poll = 0;

function isInputFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}

function setMetric(m: HeightMetric): void {
  market.setMetric(m);
}

function flyToSelected(): void {
  const id = ui.selectedInstrumentId;
  if (id) (engine.api.flyTo as FlyToApi | undefined)?.go(id);
}

function onKeyDown(e: KeyboardEvent): void {
  if (isInputFocused()) return;
  if (e.code === 'Digit1') {
    e.preventDefault();
    setMetric(1);
  } else if (e.code === 'Digit2') {
    e.preventDefault();
    setMetric(2);
  } else if (e.code === 'Digit3') {
    e.preventDefault();
    setMetric(3);
  } else if (e.code === 'KeyF') {
    e.preventDefault();
    flyToSelected();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
  poll = window.setInterval(() => {
    repaints.value = (engine.api.labels as LabelsApi | undefined)?.repaints ?? 0;
  }, 200);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
  if (poll) window.clearInterval(poll);
  poll = 0;
});
</script>

<template>
  <div class="toolbar">
    <div class="seg">
      <button
        v-for="m in metrics"
        :key="m.key"
        class="seg-btn"
        :class="{ active: activedMetric === m.key }"
        :title="m.hint"
        @click="setMetric(m.key)"
      >
        {{ m.label }}
      </button>
    </div>

    <button class="icon" :class="{ active: legendOpen }" title="Legend" @click="legendOpen = !legendOpen">
      Legend
    </button>

    <div v-if="ui.debugOverlay" class="debug-extra">
      label repaints/f: {{ repaints }}
    </div>

    <Transition name="legend">
      <div v-if="legendOpen" class="legend">
        <div class="legend-title">Current metric: {{ metrics.find((m) => m.key === activedMetric)?.label }}</div>
        <div class="legend-row">{{ metrics.find((m) => m.key === activedMetric)?.hint }}</div>
        <div class="bar">
          <span class="stop red">−3%</span>
          <span class="stop neu">0%</span>
          <span class="stop green">+3%</span>
        </div>
        <div class="legend-note">Color is always day-change, regardless of height mode.</div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.toolbar {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  pointer-events: auto;
}

.seg {
  display: flex;
  background: rgba(8, 12, 18, 0.78);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  overflow: hidden;
}
.seg-btn {
  background: transparent;
  border: none;
  color: var(--text-dim);
  padding: 0.5rem 0.85rem;
  font-size: 0.82rem;
  font-family: var(--mono);
  border-right: 1px solid var(--panel-border);
}
.seg-btn:last-child {
  border-right: none;
}
.seg-btn:hover {
  color: var(--text);
}
.seg-btn.active {
  background: var(--accent);
  color: #06121c;
  font-weight: 600;
}

.icon {
  background: rgba(8, 12, 18, 0.78);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  color: var(--text-dim);
  padding: 0.5rem 0.7rem;
  font-size: 0.82rem;
}
.icon.active {
  color: var(--accent);
  border-color: var(--accent);
}

.debug-extra {
  font-family: var(--mono);
  font-size: 0.72rem;
  color: var(--text-dim);
  background: rgba(8, 12, 18, 0.78);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 0.3rem 0.5rem;
  pointer-events: none;
  white-space: pre;
}

.legend {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 50%;
  transform: translateX(-50%);
  width: min(90vw, 26rem);
  padding: 0.7rem 0.9rem;
  background: rgba(8, 12, 18, 0.92);
  border: 1px solid var(--panel-border);
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  font-size: 0.82rem;
}
.legend-title {
  color: var(--accent);
  margin-bottom: 0.3rem;
}
.legend-row {
  color: var(--text);
  font-family: var(--mono);
  font-size: 0.76rem;
  margin-bottom: 0.5rem;
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  margin-bottom: 0.4rem;
}
.stop {
  padding: 0.18rem 0.5rem;
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 0.72rem;
  color: #06121c;
}
.stop.red { background: #d64550; color: #fff; }
.stop.neu { background: #6b7683; color: #fff; }
.stop.green { background: #22c07a; }
.legend-note {
  color: var(--text-dim);
  font-size: 0.76rem;
}

.legend-enter-active, .legend-leave-active { transition: opacity 0.15s; }
.legend-enter-from, .legend-leave-to { opacity: 0; }
</style>