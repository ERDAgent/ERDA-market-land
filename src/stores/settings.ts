/**
 * §11 settings store, persisted to localStorage (JSON, key `eml.settings.v1`).
 * No Pinia plugin — a tiny self-contained watcher persists on change.
 */
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

const KEY = 'eml.settings.v1';

interface SettingsShape {
  displayName: string;
  finnhubKey: string;
  lanOnly: boolean;
  demoMode: boolean;
  dprCap: number;
}

function load(): Partial<SettingsShape> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return typeof v === 'object' && v ? v : {};
  } catch {
    return {};
  }
}

function save(v: SettingsShape): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable — no-op */
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const stored = load();
  const displayName = ref<string>(typeof stored.displayName === 'string' ? stored.displayName : '');
  const finnhubKey = ref<string>(typeof stored.finnhubKey === 'string' ? stored.finnhubKey : '');
  const lanOnly = ref<boolean>(Boolean(stored.lanOnly));
  const demoMode = ref<boolean>(Boolean(stored.demoMode));
  const dprCap = ref<number>(
    typeof stored.dprCap === 'number' && Number.isFinite(stored.dprCap) && stored.dprCap > 0
      ? stored.dprCap
      : 2,
  );

  watch(
    [displayName, finnhubKey, lanOnly, demoMode, dprCap],
    () => {
      save({
        displayName: displayName.value,
        finnhubKey: finnhubKey.value,
        lanOnly: lanOnly.value,
        demoMode: demoMode.value,
        dprCap: dprCap.value,
      });
    },
    { deep: true },
  );

  return { displayName, finnhubKey, lanOnly, demoMode, dprCap };
});