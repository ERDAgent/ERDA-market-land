/**
 * Vue-side hotkeys for keys the engine does NOT own (the engine handles WASD,
 * Space/C, Shift, scroll). Owns: `` ` `` debug overlay toggle. Esc to release
 * pointer lock is handled by the browser automatically; we additionally close
 * any open modal on Esc.
 *
 * §9: ALL keydown handlers MUST no-op while any input/textarea is focused. The
 * engine's fly-controls enforce the same rule on their side.
 */
import { onMounted, onUnmounted } from 'vue';
import { useUiStore } from '../stores/ui';

function isInputFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}

export function useHotkeys(): void {
  const ui = useUiStore();

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isInputFocused()) return;
    if (e.code === 'Backquote') {
      e.preventDefault();
      ui.debugOverlay = !ui.debugOverlay;
      return;
    }
    if (e.code === 'Escape') {
      if (ui.modals.help) {
        e.preventDefault();
        ui.modals.help = false;
      }
    }
  };

  onMounted(() => window.addEventListener('keydown', onKeyDown));
  onUnmounted(() => window.removeEventListener('keydown', onKeyDown));
}