<script setup lang="ts">
/**
 * TopBar (§10) — room status pill (Solo / Hosting n / Connected · ping), Invite
 * button (host only), Join button (solo/guest entry), Leave button. Owns and
 * renders the SignalingModal (a modal — excluded from the WorldScreen overlay
 * glob — as a child so it mounts without editing App.vue). Also renders the
 * host-left [Continue solo]/[Back to menu] banner for guests.
 *
 * Text nodes only. All labels rendered as text — never v-html.
 */
import { computed, ref } from 'vue';
import { useConnectionStore } from '../../stores/connection';
import { useSettingsStore } from '../../stores/settings';
import { useUiStore } from '../../stores/ui';
import { hostInit, hostLeave } from '../../net/host';
import { guestContinueSolo, guestLeave, guestBackToMenu } from '../../net/guest';
import SignalingModal from './SignalingModal.vue';

const conn = useConnectionStore();
const settings = useSettingsStore();
const ui = useUiStore();

const modalMode = ref<'host' | 'guest' | null>(null);

const guestsCount = computed(() => Math.max(0, (conn.roster?.length ?? 0) - 1));

const pillText = computed(() => {
  if (conn.role === 'guest') {
    if (conn.status === 'connected') return `Connected · ${conn.pingMs ?? '–'}ms`;
    if (conn.status === 'connecting') return 'Connecting…';
    if (conn.status === 'disconnected') return 'Reconnecting…';
    if (conn.status === 'failed') return 'Failed';
    return 'Connecting…';
  }
  if (conn.role === 'host') {
    return guestsCount.value > 0 ? `Hosting ${guestsCount.value}` : 'Hosting';
  }
  return 'Solo';
});

const pillClass = computed(() => {
  switch (conn.status) {
    case 'connected': return 'pill green';
    case 'disconnected': return 'pill amber';
    case 'failed': return 'pill red';
    case 'connecting': return 'pill amber';
    default: return conn.role === 'solo' ? 'pill dim' : 'pill';
  }
});

const canInvite = computed(() => conn.role === 'solo' || conn.role === 'host');
const canJoin = computed(() => conn.role === 'solo' || conn.role === 'guest');

function openInvite(): void {
  conn.clearError();
  modalMode.value = 'host'; // SignalingModal owns hostInit + the paste flow
}

function openJoin(): void {
  conn.clearError();
  modalMode.value = 'guest'; // SignalingModal owns the offer generation
}

function onLeave(): void {
  if (conn.role === 'guest') guestLeave();
  else hostLeave();
  modalMode.value = null;
  ui.screen = 'menu';
}

function continueSolo(): void {
  guestContinueSolo();
}

function backToMenu(): void {
  guestBackToMenu();
  ui.screen = 'menu';
}

function closeModal(): void { modalMode.value = null; }
</script>

<template>
  <div class="topbar">
    <div :class="pillClass">{{ pillText }}</div>

    <div class="actions">
      <button v-if="canInvite" class="btn" @click="openInvite">Invite</button>
      <button v-if="canJoin" class="btn" @click="openJoin">Join a Room</button>
      <button class="btn danger" @click="onLeave">Leave</button>
    </div>

    <SignalingModal v-if="modalMode" :mode="modalMode" @close="closeModal" />

    <!-- Host-left banner (guest only). -->
    <div v-if="conn.banner === 'host-left'" class="banner-backdrop">
      <div class="banner" role="alert">
        <h2>Host disconnected — data frozen</h2>
        <p>The host left the room. You can keep exploring on your own.</p>
        <div class="banner-actions">
          <button class="btn primary" @click="continueSolo">Continue solo</button>
          <button class="btn" @click="backToMenu">Back to menu</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.topbar {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.6rem;
  pointer-events: auto;
  z-index: 40;
}
.pill {
  padding: 0.32rem 0.7rem;
  border-radius: 999px;
  font-size: 0.78rem;
  font-family: var(--mono);
  background: rgba(8, 12, 18, 0.72);
  border: 1px solid var(--panel-border);
  color: var(--text);
}
.pill.green { color: #4ade80; border-color: rgba(74, 222, 128, 0.5); }
.pill.amber { color: #fbbf24; border-color: rgba(251, 191, 36, 0.5); }
.pill.red { color: var(--danger); border-color: rgba(255, 107, 107, 0.5); }
.pill.dim { color: var(--text-dim); }
.actions { display: flex; gap: 0.4rem; }
.btn {
  background: rgba(8, 12, 18, 0.7);
  color: var(--text);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 0.32rem 0.6rem;
  font-size: 0.8rem;
}
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.danger:hover { border-color: var(--danger); color: var(--danger); }
.btn.primary { background: var(--accent); color: #06121c; border-color: var(--accent); font-weight: 600; }
.btn.primary:hover { background: var(--accent-hover); }

.banner-backdrop {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: grid;
  place-items: center;
  background: rgba(4, 8, 12, 0.74);
  pointer-events: auto;
}
.banner {
  width: min(92vw, 26rem);
  padding: 1.6rem 1.6rem 1.3rem;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 12px;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
}
.banner h2 { margin: 0 0 0.5rem; font-size: 1.15rem; }
.banner p { margin: 0 0 1.1rem; color: var(--text-dim); font-size: 0.9rem; }
.banner-actions { display: flex; gap: 0.6rem; justify-content: flex-end; }
</style>