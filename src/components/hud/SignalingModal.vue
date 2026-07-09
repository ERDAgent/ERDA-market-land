<script setup lang="ts">
/**
 * SignalingModal (§10) — two guided copy-paste flows with big monospaced code
 * boxes, copy/paste controls, and live status. Auto-advance on channel open.
 *
 *   Host/Invite  : paste join → copy reply → connected ✓
 *   Guest/Join   : copy join  → paste reply → connecting → ✓
 *
 * Text nodes only — codes are rendered in <textarea>/<pre>, never v-html.
 */
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useConnectionStore } from '../../stores/connection';
import { useSettingsStore } from '../../stores/settings';
import { useUiStore } from '../../stores/ui';
import { useClipboard } from '../../composables/useClipboard';
import { SignalError, signalErrorMessage } from '../../net/signaling';
import { hostInit, hostReceiveOfferCode, hostSendChat } from '../../net/host';
import { guestApplyReply, guestBeginJoin } from '../../net/guest';

const props = defineProps<{ mode: 'host' | 'guest' }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const conn = useConnectionStore();
const settings = useSettingsStore();
const ui = useUiStore();
const cb = useClipboard();

const pasteBuf = ref<string>('');
const busy = ref<boolean>(false);
const localErr = ref<string | null>(null);

const codeToShow = computed<string | null>(() =>
  props.mode === 'guest' ? conn.offerCode : conn.replyCode,
);

const stepLabel = computed<string>(() => {
  if (props.mode === 'guest') {
    if (conn.phase === 'connected') return '✓ Connected';
    if (conn.phase === 'awaiting-reply') return 'Connecting…';
    return 'Step 1 · Copy your join code';
  }
  // host
  if (conn.phase === 'copy-reply') return 'Step 2 · Copy your reply code';
  if (conn.phase === 'connected') return '✓ Peer connected';
  return 'Step 1 · Paste the guest’s join code';
});

const pastePlaceholder = computed<string>(() =>
  props.mode === 'guest' ? 'Paste the host’s reply code here…' : 'Paste the guest’s join code here…',
);

function showErr(e: unknown): void {
  if (e instanceof SignalError) localErr.value = signalErrorMessage(e.code);
  else localErr.value = e instanceof Error ? e.message : 'Something went wrong.';
  conn.setError(localErr.value);
}

async function onGuestApplied(): Promise<void> {
  if (props.mode !== 'guest') return;
  busy.value = true;
  try {
    await guestBeginJoin();
  } catch (e) {
    showErr(e);
  } finally {
    busy.value = false;
  }
}

async function onCopyCode(): Promise<void> {
  const c = codeToShow.value;
  if (!c) return;
  await cb.copy(c);
}

async function onGuestPasteReply(): Promise<void> {
  if (props.mode !== 'guest') return;
  localErr.value = null;
  conn.clearError();
  if (!pasteBuf.value.trim()) return;
  busy.value = true;
  try {
    await guestApplyReply(pasteBuf.value);
    pasteBuf.value = '';
  } catch (e) {
    showErr(e);
  } finally {
    busy.value = false;
  }
}

async function onHostPasteJoin(): Promise<void> {
  if (props.mode !== 'host') return;
  localErr.value = null;
  conn.clearError();
  if (!pasteBuf.value.trim()) return;
  busy.value = true;
  try {
    await hostReceiveOfferCode(pasteBuf.value);
    pasteBuf.value = '';
  } catch (e) {
    showErr(e);
  } finally {
    busy.value = false;
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.code === 'Escape') { e.preventDefault(); close(); }
}

function close(): void { emit('close'); }

// Host mode: ensure the host session is live before the first paste.
watch(
  () => props.mode,
  (m) => {
    if (m === 'host' && (conn.role === 'solo' || conn.role === 'host')) {
      hostInit(settings.displayName.trim() || 'Host');
      conn.setPhase('paste-join');
    }
    if (m === 'guest') {
      conn.setPhase('copy-offer');
      void onGuestApplied();
    }
    localErr.value = null;
    pasteBuf.value = '';
  },
  { immediate: true },
);

// Auto-advance / auto-close on channel open (guest's welcome → connected).
watch(
  () => conn.phase,
  (p) => { if (p === 'connected') { /* keep modal open to show ✓; user closes */ } },
);

// Keep `engine.api` peers etc. unaffected; hostSendChat is a no-op import guard
// referenced so tree-shaking keeps the host chat path reachable.
void hostSendChat;

onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <div class="sig-backdrop" role="dialog" aria-modal="true" @click.self="close">
    <div class="sig">
      <div class="head">
        <h2>{{ mode === 'host' ? 'Invite a Player' : 'Join a Room' }}</h2>
        <button class="x" aria-label="Close" @click="close">×</button>
      </div>

      <div class="body">
        <div class="step">{{ stepLabel }}</div>

        <!-- GUEST: show the join code to copy first -->
        <section v-if="mode === 'guest' && conn.offerCode" class="box-row">
          <label>Your join code — copy and send it to the host out of band:</label>
          <textarea class="code" readonly :value="conn.offerCode" rows="6" />
          <div class="row">
            <button class="primary" @click="onCopyCode">Copy code</button>
            <span v-if="cb.showFallback.value" class="hint">Copy manually (Ctrl/Cmd‑C) — clipboard blocked.</span>
          </div>
        </section>

        <!-- GUEST: paste the host's reply -->
        <section v-if="mode === 'guest'" class="box-row">
          <label>{{ pastePlaceholder }}</label>
          <textarea
            v-model="pasteBuf"
            class="code paste"
            :placeholder="pastePlaceholder"
            rows="4"
            :data-clipboard-fallback="cb.showFallback.value ? 'guest' : null"
          />
          <div class="row">
            <button class="primary" :disabled="busy || !pasteBuf.trim() || conn.phase === 'connected'" @click="onGuestPasteReply">
              {{ conn.phase === 'connected' ? 'Connected' : 'Apply reply' }}
            </button>
          </div>
        </section>

        <!-- HOST: paste the guest's join code -->
        <section v-if="mode === 'host' && conn.phase !== 'copy-reply'" class="box-row">
          <label>{{ pastePlaceholder }}</label>
          <textarea
            v-model="pasteBuf"
            class="code paste"
            :placeholder="pastePlaceholder"
            rows="4"
          />
          <div class="row">
            <button class="primary" :disabled="busy || !pasteBuf.trim()" @click="onHostPasteJoin">Generate reply</button>
          </div>
        </section>

        <!-- HOST: show the reply code to copy -->
        <section v-if="mode === 'host' && conn.replyCode" class="box-row">
          <label>Your reply code — copy and send back to the guest:</label>
          <textarea class="code" readonly :value="conn.replyCode" rows="6" />
          <div class="row">
            <button class="primary" @click="onCopyCode">Copy reply</button>
            <span v-if="cb.showFallback.value" class="hint">Copy manually (Ctrl/Cmd‑C).</span>
          </div>
        </section>

        <div v-if="localErr" class="err">⚠ {{ localErr }}</div>
        <div v-if="conn.phase === 'connected'" class="ok">✓ Connected</div>
      </div>

      <div class="foot">
        <button class="ghost" @click="close">{{ conn.phase === 'connected' ? 'Done' : 'Cancel' }}</button>
      </div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.sig-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  background: rgba(4, 8, 12, 0.72);
  padding: 1.5rem;
  pointer-events: auto;
}
.sig {
  width: min(94vw, 40rem);
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
.body { padding: 1rem 1.1rem 0.4rem; }
.step { font-size: 0.82rem; color: var(--accent); margin-bottom: 0.8rem; text-transform: uppercase; letter-spacing: 0.5px; }
.box-row { margin-bottom: 1rem; }
label { display: block; font-size: 0.82rem; color: var(--text-dim); margin-bottom: 0.4rem; }
.code {
  width: 100%;
  font-family: var(--mono);
  font-size: 0.74rem;
  color: var(--text);
  background: #0a1119;
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  padding: 0.6rem;
  resize: vertical;
  outline: none;
  word-break: break-all;
}
.code.paste:focus { border-color: var(--accent); }
.row { display: flex; align-items: center; gap: 0.7rem; margin-top: 0.6rem; flex-wrap: wrap; }
.hint { font-size: 0.78rem; color: var(--text-dim); }
.primary { background: var(--accent); color: #06121c; border: 1px solid var(--accent); border-radius: 8px; padding: 0.5rem 0.9rem; font-weight: 600; }
.primary:hover:not(:disabled) { background: var(--accent-hover); }
.ghost { background: transparent; color: var(--text); border: 1px solid var(--panel-border); border-radius: 8px; padding: 0.5rem 0.9rem; }
.err { color: var(--danger); font-size: 0.84rem; margin: 0.4rem 0; }
.ok { color: #4ade80; font-size: 0.92rem; margin: 0.4rem 0; font-weight: 600; }
.foot { padding: 0.7rem 1.1rem 1rem; display: flex; justify-content: flex-end; }
</style>