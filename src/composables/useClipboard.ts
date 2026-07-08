// src/composables/useClipboard.ts — clipboard write with a textarea fallback
// (§4.3). `navigator.clipboard.writeText` is only available in secure contexts;
// otherwise we select a read-only `<textarea>` and hint "copy manually".
import { ref } from 'vue';
import { useUiStore } from '../stores/ui';

export interface ClipboardApi {
  /** Set true when the prompt needs the read-only textarea fallback shown. */
  showFallback: ReturnType<typeof ref<boolean>>;
  /** The textarea ref bound to the fallback UI; given focus+select when shown. */
  fallbackText: ReturnType<typeof ref<string>>;
  /** Copy `text` to the clipboard; returns true on the async API path. */
  copy(text: string): Promise<boolean>;
}

/**
 * Copy-to-clipboard with graceful degradation. Call `copy(text)`; when the
 * async Clipboard API is unavailable the composable sets `showFallback` and
 * populates `fallbackText` so a read-only textarea can be auto-selected.
 */
export function useClipboard(): ClipboardApi {
  const showFallback = ref<boolean>(false);
  const fallbackText = ref<string>('');

  async function copy(text: string): Promise<boolean> {
    const ui = useUiStore();
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      try {
        await navigator.clipboard.writeText(text);
        ui.addToast({ kind: 'success', text: 'Copied' });
        return true;
      } catch {
        // permission denied etc. → fall through to textarea fallback
      }
    }
    fallbackText.value = text;
    showFallback.value = true;
    ui.addToast({ kind: 'warn', text: 'Copy failed — select manually' });
    // auto-select the textarea on the next tick (caller renders it)
    queueMicrotask(() => {
      const el = document.querySelector<HTMLTextAreaElement>('[data-clipboard-fallback]');
      if (el) { el.focus(); el.select(); }
    });
    return false;
  }

  return { showFallback, fallbackText, copy };
}