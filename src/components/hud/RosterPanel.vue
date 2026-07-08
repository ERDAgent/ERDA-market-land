<script setup lang="ts">
/**
 * RosterPanel (§10) — top-left, collapsible. Colored dot, name, (host) tag,
 * ping (rttMs). Text nodes only — names rendered as text, never v-html.
 */
import { ref } from 'vue';
import { usePlayersStore } from '../../stores/players';

const players = usePlayersStore();
const collapsed = ref<boolean>(false);
</script>

<template>
  <div class="roster" :class="{ collapsed }">
    <button class="header" @click="collapsed = !collapsed">
      <span class="title">Roster · {{ players.count }}</span>
      <span class="chev">{{ collapsed ? '▸' : '▾' }}</span>
    </button>
    <ul v-if="!collapsed" class="list">
      <li v-for="p in players.players" :key="p.id" class="row">
        <span class="dot" :style="{ background: p.color }" />
        <span class="name">{{ p.name }}</span>
        <span v-if="p.isHost" class="tag">host</span>
        <span class="ping">{{ p.rttMs != null ? `${p.rttMs}ms` : '' }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.roster {
  position: absolute;
  top: 8px;
  left: 8px;
  width: 14rem;
  max-height: 60vh;
  overflow: auto;
  background: rgba(8, 12, 18, 0.72);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  pointer-events: auto;
  z-index: 30;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  background: transparent;
  border: none;
  color: var(--text);
  padding: 0.45rem 0.6rem;
  font-size: 0.8rem;
  text-align: left;
}
.chev { color: var(--text-dim); }
.list { list-style: none; margin: 0; padding: 0 0.4rem 0.4rem; }
.row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.2rem;
  font-size: 0.82rem;
}
.dot { width: 0.7rem; height: 0.7rem; border-radius: 50%; flex: 0 0 auto; }
.name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag {
  font-size: 0.66rem;
  color: var(--accent);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  padding: 0 0.3rem;
}
.ping { color: var(--text-dim); font-family: var(--mono); font-size: 0.72rem; }
</style>