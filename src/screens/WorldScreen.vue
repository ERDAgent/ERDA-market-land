<script setup lang="ts">
/**
 * WorldScreen owns the world layout: `<WorldCanvas/>` (engine lifecycle) plus a
 * HUD auto-mount seam. Later phases DROP `src/components/hud/*.vue` files and
 * they auto-mount here — this file is NEVER re-edited (no per-component import).
 *
 * Convention so modals and overlay HUDs don't collide: the glob mounts every
 * `hud/*.vue` whose name does NOT end in `Modal.vue`. Modals (HelpModal,
 * SignalingModal, SettingsModal) are app-level and mounted explicitly elsewhere;
 * overlay panels (TopBar, Roster, Chat, Info, Toolbar, Toasts) auto-mount here.
 * At M0 the only hud/*.vue is HelpModal → overlays list is empty, as expected.
 */
import { onMounted, onUnmounted, ref, markRaw, type Component } from 'vue';
import WorldCanvas from '../components/WorldCanvas.vue';
import { useHotkeys } from '../composables/useHotkeys';
import { useUiStore } from '../stores/ui';
import { engine, type EngineStats } from '../engine/core';

useHotkeys();

const ui = useUiStore();

const HudModules = import.meta.glob('../components/hud/*.vue', { eager: true }) as Record<
  string,
  { default: Component }
>;
const overlayHuds = markRaw(
  Object.entries(HudModules)
    .filter(([path]) => !/Modal\.vue$/.test(path))
    .map(([, m]) => m.default),
);

// Debug overlay: polls engine.stats (primitive numbers only) on a light timer.
// This is UI polling, NOT per-frame 3D work; the single rAF loop is untouched.
const stats = ref<EngineStats>({ ...engine.stats });
let pollHandle = 0;

// Briefly-shown base-speed readout after a scroll (§9).
const showSpeed = ref<number | null>(null);
let speedHideHandle = 0;

function startPolling(): void {
  poll();
  pollHandle = window.setInterval(poll, 200);
}
function poll(): void {
  stats.value = { ...engine.stats };
  if (engine.speedHud.until > performance.now()) {
    showSpeed.value = engine.speedHud.speed;
    if (speedHideHandle) window.clearTimeout(speedHideHandle);
    speedHideHandle = window.setTimeout(() => {
      showSpeed.value = null;
      speedHideHandle = 0;
    }, Math.max(0, engine.speedHud.until - performance.now()));
  }
}

onMounted(() => startPolling());
onUnmounted(() => {
  if (pollHandle) window.clearInterval(pollHandle);
  if (speedHideHandle) window.clearTimeout(speedHideHandle);
  pollHandle = 0;
  speedHideHandle = 0;
});

function backToMenu(): void {
  ui.screen = 'menu';
}
</script>

<template>
  <div class="world">
    <WorldCanvas />

    <!-- Overlay HUD auto-mount seam (empty at M0). -->
    <div class="hud-root">
      <component :is="c" v-for="(c, i) in overlayHuds" :key="i" />
    </div>

    <!-- Debug overlay (toggle with backtick). -->
    <div v-if="ui.debugOverlay" class="debug">
      <div>{{ Math.round(stats.fps) }} fps</div>
      <div>{{ stats.drawCalls }} draw calls</div>
      <div>systems {{ stats.systems }}</div>
      <div>peers {{ stats.peers }}</div>
      <div>data {{ Math.round(stats.dataBudgetPct) }}%</div>
    </div>

    <!-- Speed HUD (briefly after scroll). -->
    <div v-if="showSpeed !== null" class="speed-hud">{{ showSpeed }} u/s</div>

    <div class="back-row">
      <button class="back" @click="backToMenu">← Menu</button>
    </div>
  </div>
</template>

<style scoped>
.world {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: var(--bg);
}

.hud-root {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.debug {
  position: absolute;
  top: 8px;
  left: 8px;
  padding: 0.45rem 0.6rem;
  font-family: var(--mono);
  font-size: 0.72rem;
  line-height: 1.35;
  color: #d8e3ee;
  background: rgba(8, 12, 18, 0.72);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  pointer-events: none;
  white-space: pre;
}

.speed-hud {
  position: absolute;
  bottom: 50px;
  left: 50%;
  transform: translateX(-50%);
  padding: 0.3rem 0.7rem;
  font-family: var(--mono);
  font-size: 0.8rem;
  color: var(--text);
  background: rgba(8, 12, 18, 0.7);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  pointer-events: none;
}

.back-row {
  position: absolute;
  top: 8px;
  right: 8px;
  pointer-events: auto;
}
.back {
  background: rgba(8, 12, 18, 0.7);
  color: var(--text);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 0.35rem 0.6rem;
  font-size: 0.8rem;
}
.back:hover {
  border-color: var(--accent);
  color: var(--accent);
}
</style>