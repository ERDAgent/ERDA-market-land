<script setup lang="ts">
/**
 * §10 SettingsModal — display name, Finnhub API key (password), LAN-only,
 * Demo-data toggle, pixel-ratio cap. Binds the M0 settings store directly
 * (the store persists to localStorage via its own watcher). The Finnhub key is
 * a password field stored LOCALLY ONLY and is NEVER shared with peers — this
 * module never imports net/*, so the key cannot leave the browser except as a
 * Finnhub fetch querystring to api.finnhub.io.
 *
 * A modal (name ends in `Modal.vue`): excluded from WorldScreen's overlay glob,
 * so it must be mounted explicitly. Here it is rendered as a child of
 * DataSourceBanner (the auto-mounted overlay owns a gear button + this modal),
 * avoiding edits to App.vue / WorldScreen.vue. Opened via `ui.modals.settings`.
 */
import { computed, onMounted, onUnmounted } from 'vue';
import { useSettingsStore } from '../../stores/settings';

const settings = useSettingsStore();
const emit = defineEmits<{ (e: 'close'): void }>();

const nameValid = computed(() => {
  const n = (settings.displayName ?? '').trim();
  return n.length >= 1 && n.length <= 32;
});

const dprValid = computed(
  () => Number.isFinite(settings.dprCap) && settings.dprCap >= 1 && settings.dprCap <= 4,
);

const keyEdited = computed(() => (settings.finnhubKey ?? '').trim().length > 0);

function onKeydown(e: KeyboardEvent): void {
  if (e.code === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="settings-backdrop" role="dialog" aria-modal="true" aria-label="Settings" @click.self="emit('close')">
    <div class="settings">
      <div class="head">
        <h2>Settings</h2>
        <button class="x" aria-label="Close settings" @click="emit('close')">×</button>
      </div>

      <div class="body">
        <section>
          <label class="lbl" for="set-name">Display name</label>
          <input
            id="set-name"
            v-model="settings.displayName"
            class="inp"
            type="text"
            maxlength="32"
            autocomplete="off"
            placeholder="Your name"
          />
          <p class="hint" :class="{ bad: !nameValid }">Shown to peers. 1–32 chars.</p>
        </section>

        <section>
          <label class="lbl" for="set-key">Finnhub API key</label>
          <input
            id="set-key"
            v-model="settings.finnhubKey"
            class="inp"
            type="password"
            autocomplete="off"
            placeholder="optional — live equity quotes"
          />
          <p class="hint">
            Stored locally in your browser only —
            <strong>never shared with peers</strong>.
            Without a key, equities run simulated (crypto stays live). Get a free key
            at finnhub.io. Applied on the next world entry.
          </p>
        </section>

        <section class="toggles">
          <label class="switch">
            <input v-model="settings.lanOnly" type="checkbox" />
            <span class="track"><span class="knob" /></span>
            <span class="txt">LAN-only mode</span>
          </label>
          <p class="hint">Drops public STUN; works on a shared local network with zero internet.</p>

          <label class="switch">
            <input v-model="settings.demoMode" type="checkbox" />
            <span class="track"><span class="knob" /></span>
            <span class="txt">Demo data (force simulated)</span>
          </label>
          <p class="hint">Routes every instrument to the Simulated provider — no network calls.</p>
        </section>

        <section>
          <label class="lbl" for="set-dpr">Pixel-ratio cap</label>
          <input
            id="set-dpr"
            v-model.number="settings.dprCap"
            class="inp narrow"
            type="number"
            min="1"
            max="4"
            step="0.5"
          />
          <p class="hint" :class="{ bad: !dprValid }">Limits devicePixelRatio the renderer uses (1–4).</p>
        </section>

        <p v-if="keyEdited" class="key-ok">✓ Finnhub key set (hidden).</p>
      </div>

      <div class="foot">
        <button class="ok" @click="emit('close')">Done</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-backdrop {
  position: fixed;
  inset: 0;
  z-index: 65;
  display: grid;
  place-items: center;
  background: rgba(4, 8, 12, 0.74);
  padding: 1.5rem;
  pointer-events: auto;
}
.settings {
  width: min(94vw, 30rem);
  max-height: 90vh;
  overflow: auto;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 12px;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
}
.head { display: flex; align-items: center; justify-content: space-between; padding: 0.9rem 1.1rem; border-bottom: 1px solid var(--panel-border); }
.head h2 { margin: 0; font-size: 1.1rem; }
.x { background: transparent; border: none; color: var(--text-dim); font-size: 1.4rem; line-height: 1; padding: 0 0.4rem; }
.x:hover { color: var(--text); }
.body { padding: 1rem 1.1rem 0.4rem; display: flex; flex-direction: column; gap: 1rem; }
section { display: block; }
.lbl { display: block; font-size: 0.78rem; color: var(--text-dim); margin-bottom: 0.4rem; }
.inp {
  width: 100%;
  padding: 0.55rem 0.65rem;
  font-size: 0.92rem;
  color: var(--text);
  background: #0a1119;
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  outline: none;
}
.inp:focus { border-color: var(--accent); }
.inp.narrow { width: 6rem; }
.hint { margin: 0.4rem 0 0; font-size: 0.78rem; color: var(--text-dim); line-height: 1.45; }
.hint.bad { color: var(--danger); }
.hint strong { color: var(--text); }
.key-ok { margin: 0.2rem 0 0; font-size: 0.8rem; color: #4ade80; }

.toggles { display: flex; flex-direction: column; gap: 0.3rem; }
.switch { display: flex; align-items: center; gap: 0.6rem; cursor: pointer; }
.switch input { display: none; }
.txt { font-size: 0.9rem; color: var(--text); }
.track {
  position: relative;
  width: 2.6rem;
  height: 1.3rem;
  border-radius: 999px;
  background: #1b2a3a;
  border: 1px solid var(--panel-border);
  transition: background 0.15s;
}
.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: calc(1.3rem - 6px);
  height: calc(1.3rem - 6px);
  border-radius: 50%;
  background: var(--text-dim);
  transition: transform 0.15s, background 0.15s;
}
.switch input:checked + .track { background: var(--accent); }
.switch input:checked + .track .knob { transform: translateX(1.3rem); background: #06121c; }

.foot { padding: 0.7rem 1.1rem 1rem; display: flex; justify-content: flex-end; }
.ok { background: var(--accent); color: #06121c; border: none; border-radius: 8px; padding: 0.5rem 0.9rem; font-weight: 600; }
.ok:hover { background: var(--accent-hover); }
</style>