// src/stores/players.ts — §11 players store: roster-derived metadata only.
//
// Live transforms live in the engine (M4), NOT Pinia. This store exposes the
// roster (with deterministic avatar color) so M4 can read peer metadata without
// importing the net layer. `colorFromId` is the §4.1 deterministic HSL from an
// id hash — shared here so host assignment and UI rendering agree.
import { defineStore } from 'pinia';
import { computed } from 'vue';
import { useConnectionStore } from './connection';
import type { PeerInfo } from '../net/protocol';

/** Deterministic avatar color: HSL from a stable id hash (§4.1). */
export function colorFromId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  // fixed S/L for a readable palette against the dark world
  return `hsl(${hue} 70% 62%)`;
}

export const usePlayersStore = defineStore('players', () => {
  const conn = useConnectionStore();

  /** Roster with guaranteed colors (host 'H' + guests). */
  const players = computed<PeerInfo[]>(() =>
    (conn.roster ?? []).map((p) => ({
      ...p,
      color: p.color || colorFromId(p.id),
    })),
  );

  const self = computed<PeerInfo | null>(() => {
    const me = players.value.find((p) => p.id === conn.selfId);
    return me ?? null;
  });

  const count = computed(() => players.value.length);

  return { players, self, count };
});