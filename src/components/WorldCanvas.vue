<script setup lang="ts">
/**
 * Owns the engine lifecycle: `engine.init(canvas)` on mount, `engine.dispose()`
 * on unmount (no leak across menu→world cycles). The canvas DOM element is held
 * in a plain ref — engine.init receives it directly; no Three object ever
 * enters Vue reactivity (§8.7-1). `useEngineBridge()` runs once on first mount.
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { engine } from '../engine/core';
import { useEngineBridge } from '../composables/useEngineBridge';

const canvasRef = ref<HTMLCanvasElement | null>(null);

onMounted(() => {
  const el = canvasRef.value;
  if (!el) return;
  engine.init(el);
  useEngineBridge();
});

onUnmounted(() => {
  engine.dispose();
});
</script>

<template>
  <canvas ref="canvasRef" class="world-canvas" />
</template>

<style scoped>
.world-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
  cursor: crosshair;
}
</style>