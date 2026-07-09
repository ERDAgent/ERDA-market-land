<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { useUiStore } from '../stores/ui';
import { VERSION_STRING } from '../version';

const versionString = VERSION_STRING;
const repoUrl = 'https://github.com/ERDAgent/ERDA-market-land';

const settings = useSettingsStore();
const ui = useUiStore();

const canStartSolo = computed(
  () => settings.displayName.trim().length >= 1 && settings.displayName.trim().length <= 32,
);

function startSolo(): void {
  if (!canStartSolo.value) return;
  ui.screen = 'world';
}

// M5G menu wiring: enter the world screen and set a one-shot TopBar honors to
// open SignalingModal in the requested mode. Role assignment stays owned by
// hostInit/guestBeginJoin inside SignalingModal (TopBar's openInvite/openJoin).
function startHost(): void {
  if (!canStartSolo.value) return;
  ui.setPendingMode('host');
  ui.screen = 'world';
}

function startJoin(): void {
  if (!canStartSolo.value) return;
  ui.setPendingMode('guest');
  ui.screen = 'world';
}

function openHelp(): void {
  ui.modals.help = true;
}
</script>

<template>
  <div class="menu">
    <div class="card">
      <h1 class="title">Virtual&nbsp;<span>Market&nbsp;Space</span></h1>
      <p class="subtitle">Client hosted 3D multiuser financial explorer. Fly the skyline, read quotes at a glance, with friends or solo.</p>

      <label class="field" for="name">Display name</label>
      <input
        id="name"
        v-model="settings.displayName"
        class="name-input"
        type="text"
        maxlength="32"
        autocomplete="off"
        placeholder="Your name"
        @keydown.enter="startSolo"
      />

      <div class="row">
        <button class="primary" :disabled="!canStartSolo" @click="startSolo">Fly Solo</button>
        <button class="ghost" :disabled="!canStartSolo" @click="startHost">Host</button>
        <button class="ghost" :disabled="!canStartSolo" @click="startJoin">Join</button>
      </div>

      <p class="context">
        <strong>Live data:</strong> grab a free API key at
        <a href="https://finnhub.io" target="_blank" rel="noopener noreferrer">finnhub.io</a>
        and paste it into <strong>Settings</strong> (the key icon) to switch from simulated
        quotes to live market data. Because the free tier is rate-limited, data loads in
        rolling waves rather than all at once.
      </p>

      <div class="footer">
        <a class="link" role="button" tabindex="0" @click="openHelp" @keydown.enter="openHelp">Help
          (controls · privacy · NAT)</a>
        <a class="version" :href="repoUrl" target="_blank" rel="noopener noreferrer">{{ versionString }}</a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.menu {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: radial-gradient(circle at 50% 35%, #16222e 0%, var(--bg) 70%);
  overflow: auto;
  padding: 2rem;
}

.card {
  width: min(92vw, 24rem);
  padding: 2rem 2rem 1.25rem;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
}

.title {
  margin: 0 0 0.5rem;
  font-size: 1.9rem;
  font-weight: 700;
  letter-spacing: 0.2px;
}
.title span {
  color: var(--accent);
}

.subtitle {
  margin: 0 0 1.25rem;
  color: var(--text-dim);
  font-size: 0.92rem;
  line-height: 1.4;
}

.field {
  display: block;
  font-size: 0.78rem;
  color: var(--text-dim);
  margin-bottom: 0.4rem;
}

.name-input {
  width: 100%;
  padding: 0.6rem 0.7rem;
  font-size: 1rem;
  color: var(--text);
  background: #0a1119;
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  outline: none;
}
.name-input:focus {
  border-color: var(--accent);
}

.row {
  display: flex;
  gap: 0.6rem;
  margin-top: 1.1rem;
  flex-wrap: wrap;
}

button {
  border-radius: 8px;
  border: 1px solid var(--panel-border);
  padding: 0.6rem 1rem;
  font-size: 0.95rem;
  transition: background 0.12s, border-color 0.12s;
}

.primary {
  background: var(--accent);
  color: #06121c;
  border-color: var(--accent);
  font-weight: 600;
}
.primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.ghost {
  background: transparent;
  color: var(--text);
}

.context {
  margin-top: 1.1rem;
  font-size: 0.8rem;
  color: var(--text-dim);
  line-height: 1.45;
}
.context a {
  color: var(--accent);
}

.footer {
  margin-top: 1.2rem;
  border-top: 1px solid var(--panel-border);
  padding-top: 0.9rem;
  text-align: center;
}
.link {
  font-size: 0.85rem;
  color: var(--accent);
}
.version {
  display: block;
  margin-top: 0.5rem;
  font-size: 0.7rem;
  font-family: var(--mono);
  color: var(--text-dim);
  text-decoration: none;
}
.version:hover {
  color: var(--accent);
}
</style>