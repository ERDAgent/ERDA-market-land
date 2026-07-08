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
  --bg: #0b0f14;
  --panel: #0f1620;
  --panel-border: #1b2a3a;
  --text: #e6edf3;
  --text-dim: #8b98a8;
  --accent: #4aa8ff;
  --accent-hover: #6bc1ff;
  --danger: #ff6b6b;
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif,
    'Apple Color Emoji';
  --mono: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
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