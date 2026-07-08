// src/bridges/connection.ts — store↔engine glue for the connection concern (M3).
//
// Glob-discovered by `useEngineBridge` and run once after `engine.init`. Most net
// logic lives in `net/host.ts` + `net/guest.ts`; this bridge only registers the
// `engine.api.connection` sliver (read via optional chaining by later phases)
// and mirrors the live peer count into `engine.stats` for the debug overlay.
import { watchEffect } from 'vue';
import { useConnectionStore } from '../stores/connection';
import { broadcastRel } from '../net/host';
import { hostLeave } from '../net/host';
import { guestLeave } from '../net/guest';
import type { Env } from '../net/protocol';
import type { Engine } from '../engine/core';

/** The connection api sliver other phases read via `engine.api.connection?.…`. */
export interface ConnectionApi {
  /** Fan-out an Env to every guest `rel` channel (M5 quotes-broadcast bridge). */
  broadcastRel(env: Env): Promise<void>;
  /** Leave the current room from any role. */
  leave(): void;
}

export default function setupConnection(engine: Engine): void {
  const conn = useConnectionStore();

  engine.api.connection = {
    broadcastRel,
    leave: () => {
      if (conn.role === 'guest') guestLeave();
      else hostLeave();
    },
  } satisfies ConnectionApi;

  // Mirror the live (non-self) peer count into the engine stats overlay field.
  watchEffect(() => {
    engine.stats.peers = Math.max(0, (conn.roster?.length ?? 0) - 1);
  });
}