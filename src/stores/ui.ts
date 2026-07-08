/**
 * §11 UI store: screen toggle, modal flags, selected instrument, toasts, debug.
 */
import { defineStore } from 'pinia';
import { ref, reactive } from 'vue';

export type Screen = 'menu' | 'world';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success' | 'warn';
  text: string;
}

let toastSeq = 1;

export const useUiStore = defineStore('ui', () => {
  const screen = ref<Screen>('menu');
  const modals = reactive({ help: false, settings: false, invite: false, join: false });
  const selectedInstrumentId = ref<string | null>(null);
  const toasts = ref<Toast[]>([]);
  const debugOverlay = ref<boolean>(false);

  function addToast(t: Partial<Toast> & { text: string }): Toast {
    const toast: Toast = {
      id: t.id ?? toastSeq++,
      kind: t.kind ?? 'info',
      text: t.text,
    };
    const list = toasts.value.slice(-9);
    list.push(toast);
    toasts.value = list;
    return toast;
  }

  function dismissToast(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  return { screen, modals, selectedInstrumentId, toasts, debugOverlay, addToast, dismissToast };
});