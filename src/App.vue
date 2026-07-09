<script setup lang="ts">
import { useUiStore } from './stores/ui';
import MenuScreen from './screens/MenuScreen.vue';
import WorldScreen from './screens/WorldScreen.vue';
import HelpModal from './components/hud/HelpModal.vue';

const ui = useUiStore();
</script>

<template>
  <MenuScreen v-if="ui.screen === 'menu'" />
  <WorldScreen v-else />
  <HelpModal v-if="ui.modals.help" @close="ui.modals.help = false" />
</template>

<style>
:root {
  --bg: #020804;
  --panel: #04120a;
  --panel-border: #125a2e;
  --text: #5dff7a;
  --text-dim: #2e8a44;
  --accent: #7dff8a;
  --accent-hover: #9dffaa;
  --danger: #ffb347;
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif,
    'Apple Color Emoji';
  --mono: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
}

/* CRT scanline + vignette overlay: fixed full-screen, above the 3D canvas and
   HUD panels (z 30-40) but below modals (HelpModal 50, SignalingModal 60,
   SettingsModal 65). pointer-events:none so it never blocks input. */
body::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 49;
  background-color: rgba(0, 40, 10, 0.04);
  background-image: repeating-linear-gradient(
    0deg,
    rgba(0, 0, 0, 0.18) 0,
    rgba(0, 0, 0, 0.18) 1px,
    transparent 1px,
    transparent 3px
  );
  box-shadow: inset 0 0 180px 40px rgba(0, 0, 0, 0.55);
}

* {
  box-sizing: border-box;
}

html,
body,
#app {
  margin: 0;
  padding: 0;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
}

button {
  font-family: var(--font);
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

input,
textarea {
  font-family: var(--font);
}

a {
  color: var(--accent);
  cursor: pointer;
}
</style>