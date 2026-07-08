<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';

const emit = defineEmits<{ (e: 'close'): void }>();

function onKey(e: KeyboardEvent): void {
  if (e.code === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="help-backdrop" role="dialog" aria-modal="true" aria-label="Help" @click.self="emit('close')">
    <div class="help">
      <div class="head">
        <h2>Help</h2>
        <button class="x" aria-label="Close help" @click="emit('close')">×</button>
      </div>
      <div class="body">
        <section>
          <h3>Controls</h3>
          <table class="ctl">
            <tbody>
              <tr><td><kbd>Click</kbd></td><td>Lock pointer to look around. <kbd>Esc</kbd> releases. Touch fallback: drag to look.</td></tr>
              <tr><td><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd></td><td>Move forward / left / back / right (on camera basis)</td></tr>
              <tr><td><kbd>Space</kbd> / <kbd>C</kbd></td><td>Up / down</td></tr>
              <tr><td><kbd>Shift</kbd> (hold)</td><td>Sprint ×3</td></tr>
              <tr><td>Scroll wheel</td><td>Adjust base speed 4–60 u/s (default 15), shown briefly in the HUD</td></tr>
              <tr><td><kbd>Enter</kbd></td><td>Focus chat input (releases pointer lock); <kbd>Esc</kbd> returns to the world</td></tr>
              <tr><td><kbd>`</kbd></td><td>Debug overlay (fps, draw calls, peers, data budget)</td></tr>
              <tr><td><kbd>F</kbd> · <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></td><td>Fly-to selected building · height metric (change% / mcap / price) — city features added later</td></tr>
            </tbody>
          </table>
        </section>

        <section>
          <h3>Privacy</h3>
          <p>
            This app can connect you to peers over WebRTC, using copy-paste signaling codes.
            <strong>WebRTC codes inherently contain IP candidate info</strong> — browsers
            mDNS-mask local IPs, and the STUN-derived public IP appears unless LAN-only mode
            is on. Share codes only with people you would video-call.
          </p>
        </section>

        <section>
          <h3>NAT / network limitation</h3>
          <p>
            The app uses STUN (a free, stateless utility) but deliberately has <strong>no TURN
            relay server</strong>. Over the internet, some <em>symmetric NAT / CGNAT</em> pairs
            will fail to connect — this is a known limitation. LAN-only mode (no ICE servers)
            works on a shared local network with zero internet. Enable LAN-only in Settings when
            everyone is on the same Wi-Fi.
          </p>
        </section>
      </div>
      <div class="foot">
        <button class="ok" @click="emit('close')">Got it</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.help-backdrop {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: rgba(4, 8, 12, 0.72);
  padding: 1.5rem;
}
.help {
  width: min(94vw, 36rem);
  max-height: 88vh;
  overflow: auto;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 12px;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.9rem 1.1rem;
  border-bottom: 1px solid var(--panel-border);
}
.head h2 {
  margin: 0;
  font-size: 1.1rem;
}
.x {
  background: transparent;
  border: none;
  color: var(--text-dim);
  font-size: 1.4rem;
  line-height: 1;
  padding: 0 0.4rem;
}
.x:hover {
  color: var(--text);
}
.body {
  padding: 1rem 1.1rem 0.4rem;
}
section {
  margin-bottom: 1rem;
}
h3 {
  margin: 0 0 0.4rem;
  font-size: 0.85rem;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
p {
  margin: 0.3rem 0 0;
  font-size: 0.86rem;
  line-height: 1.5;
  color: var(--text);
}
.ctl {
  border-collapse: collapse;
  width: 100%;
}
.ctl td {
  padding: 0.32rem 0.4rem 0.32rem 0;
  font-size: 0.85rem;
  vertical-align: top;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.ctl td:first-child {
  white-space: nowrap;
  color: var(--text-dim);
}
kbd {
  display: inline-block;
  padding: 0 0.34rem;
  font-family: var(--mono);
  font-size: 0.76rem;
  background: #0a1119;
  border: 1px solid var(--panel-border);
  border-bottom-width: 2px;
  border-radius: 4px;
  color: var(--text);
}
.foot {
  padding: 0.7rem 1.1rem 1rem;
  display: flex;
  justify-content: flex-end;
}
.ok {
  background: var(--accent);
  color: #06121c;
  border: none;
  border-radius: 8px;
  padding: 0.5rem 0.9rem;
  font-weight: 600;
}
.ok:hover {
  background: var(--accent-hover);
}
</style>