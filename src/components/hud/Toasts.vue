<script setup lang="ts">
/**
 * §4.6 / §10 Toasts — auto-mounted overlay (hud/*.vue glob in WorldScreen).
 * Reads `useUiStore.toasts[]` (M0 store + `addToast` action) and renders each
 * with a kind-specific accent. Auto-dismisses each toast after a short timeout
 * (info/success ~3.5 s, warn/error ~6 s) and on click.
 *
 * Toasts rendered here (callers live elsewhere): join/leave, copy
 * confirmations, data warnings (stale provider), and the host-background-tab
 * hint ("Keep this tab visible for smoothest updates"). This component owns NO
 * state of its own — it is a pure projection of `ui.toasts`.
 */
import { watch, onUnmounted } from 'vue';
import { useUiStore } from '../../stores/ui';

const ui = useUiStore();

const timers = new Map<number, number>();

function schedule(id: number, kind: 'info' | 'error' | 'success' | 'warn'): void {
  const ms = kind === 'warn' || kind === 'error' ? 6000 : 3500;
  const h = window.setTimeout(() => ui.dismissToast(id), ms);
  timers.set(id, h);
}

// Re-schedule whenever the toast list changes (new toasts get a timer; dismissed
// toasts have their timer cleared).
watch(
  () => ui.toasts,
  (list) => {
    const seen = new Set<number>();
    for (const t of list) {
      seen.add(t.id);
      if (!timers.has(t.id)) schedule(t.id, t.kind);
    }
    for (const id of Array.from(timers.keys())) {
      if (!seen.has(id)) {
        const h = timers.get(id);
        if (h !== undefined) window.clearTimeout(h);
        timers.delete(id);
      }
    }
  },
  { immediate: true, deep: true },
);

onUnmounted(() => {
  for (const h of timers.values()) window.clearTimeout(h);
  timers.clear();
});
</script>

<template>
  <div class="toasts" aria-live="polite">
    <transition-group name="toast">
      <button
        v-for="t in ui.toasts"
        :key="t.id"
        class="toast"
        :class="t.kind"
        role="status"
        @click="ui.dismissToast(t.id)"
      >
        <span class="dot" :class="t.kind" />
        <span class="text">{{ t.text }}</span>
      </button>
    </transition-group>
  </div>
</template>

<style scoped>
.toasts {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.45rem;
  pointer-events: none;
  z-index: 40;
  width: max-content;
  max-width: 92vw;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: rgba(8, 12, 18, 0.92);
  border: 1px solid var(--panel-border);
  border-radius: 10px;
  color: var(--text);
  font-size: 0.85rem;
  line-height: 1.3;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5);
  cursor: pointer;
  text-align: left;
}
.toast.warn { border-color: #e0a93a; }
.toast.error { border-color: var(--danger); }
.toast.success { border-color: #22c07a; }
.dot {
  flex: 0 0 auto;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-dim);
}
.dot.info { background: var(--accent); }
.dot.success { background: #22c07a; }
.dot.warn { background: #e0a93a; }
.dot.error { background: var(--danger); }
.text { white-space: normal; }

.toast-enter-active, .toast-leave-active { transition: opacity 0.18s, transform 0.18s; }
.toast-enter-from { opacity: 0; transform: translateY(8px); }
.toast-leave-to { opacity: 0; transform: translateY(8px); }
</style>