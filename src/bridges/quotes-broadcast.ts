// src/bridges/quotes-broadcast.ts — M5 host→all quote fan-out (§4.5 / §5.5).
//
// Glob-discovered by M0's `useEngineBridge` runner (called once with `engine`
// ONLY — stores accessed via `useXStore()`). HOST role ONLY: watches the market
// store, coalesces the changed-quote delta ≤ 1/s, and fans it out to every
// guest `rel` channel via M3's frozen `broadcastRel(env)` helper — which is
// itself backpressure-aware (it awaits `bufferedAmountLow` per channel whenever
// `bufferedAmount ≥ BUFFER_HIGH`, the §4.5 guard). Every `QUOTES_RESYNC_MS` it
// broadcasts a full `quotesFull` snapshot so a guest that lost a delta resyncs.
//
// Baseline seeding: the very first quote change after mount seeds `lastSent`
// from the full store WITHOUT broadcasting a delta — guests arrive at their
// baseline from M3's `welcome` (which carries `engine.api.market.snapshot()`
// at join time), so the host's first population is not a "delta over the wire".
// Only later changes diff against that baseline → "changed instruments only".
//
// On a guest or solo role this bridge is a no-op for quote fan-out (guests
// receive over the wire; solo has zero peers). The toast side-concerns
// (§4.6/§10) still wire on host + guest.
//
// This is a SEAM file: never re-edited by a later phase. It does NOT edit M1's
// scheduler or M3's host — it only consumes the frozen hooks they export.

import { watch } from 'vue';
import { useMarketStore } from '../stores/market';
import { useConnectionStore } from '../stores/connection';
import { useUiStore } from '../stores/ui';
import { broadcastRel } from '../net/host';
import { makeEnv } from '../net/rtc';
import { QUOTES_RESYNC_MS } from '../config/net';
import type { Quote, Env } from '../net/protocol';
import type { Engine } from '../engine/core';

const DELTA_COALESCE_MS = 1000;

let installed = false;
let resyncTimer: number | undefined;
let deltaFlushTimer: number | undefined;
let stopWatch: (() => void) | null = null;
let marketRef: ReturnType<typeof useMarketStore> | null = null;
/** Delta accumulator: id → latest quote, drained ≤ once per second. */
const pendingDelta = new Map<string, Quote>();
/** Last snapshot we sent so the delta diff is "changed instruments only". */
let lastSent: Map<string, Quote> = new Map();

function env(t: 'quotesDelta' | 'quotesFull', quotes: Quote[]): Env<'quotesDelta' | 'quotesFull'> {
  return makeEnv(t, 'H', { quotes });
}

export default function quotesBroadcastBridge(engine: Engine): void {
  void engine; // engine.api.market exists, but the store is the cleaner read here.
  if (installed) return;
  installed = true;

  const conn = useConnectionStore();
  const ui = useUiStore();

  // Join/leave toasts matter to both host (guests arriving) and guests (peers
  // arriving/leaving); wire them for both roles. Solo has no peers ⇒ no-op.
  if (conn.role === 'guest') {
    wireJoinLeaveToasts(conn, ui);
    return;
  }
  if (conn.role !== 'host') {
    // solo: zero peers, no broadcasts, no host-tab hint.
    return;
  }

  // --- HOST: quote fan-out -----------------------------------------------------
  const market = useMarketStore();
  marketRef = market;

  stopWatch = watch(
    () => [market.quotes, market.lastUpdated] as const,
    ([qs]) => {
      if (lastSent.size === 0) {
        // Baseline seed: guests got their snapshot from M3's welcome; the
        // host's first population is not a wire delta. Seed so subsequent
        // changes diff against this baseline ("changed instruments only").
        lastSent = new Map(qs);
        return;
      }
      diffDelta(qs);
      scheduleDeltaFlush();
    },
  );

  resyncTimer = setInterval(() => {
    if (marketRef) void sendFull(marketRef.snapshot());
  }, QUOTES_RESYNC_MS);

  wireHostVisibilityHint(ui);
  wireJoinLeaveToasts(conn, ui);
}

/** Diff the new quotes Map against the last snapshot we sent → changed quotes. */
function diffDelta(qs: Map<string, Quote>): void {
  for (const q of qs.values()) {
    const prev = lastSent.get(q.id);
    if (
      !prev ||
      prev.price !== q.price ||
      prev.changePct !== q.changePct ||
      prev.ts !== q.ts ||
      prev.stale !== q.stale ||
      prev.session !== q.session
    ) {
      pendingDelta.set(q.id, q);
    }
  }
}

/** Trailing-throttle flush: at most one `quotesDelta` per `DELTA_COALESCE_MS`. */
function scheduleDeltaFlush(): void {
  if (deltaFlushTimer !== undefined) return;
  deltaFlushTimer = setTimeout(() => {
    deltaFlushTimer = undefined;
    flushDelta();
  }, DELTA_COALESCE_MS);
}

function flushDelta(): void {
  if (pendingDelta.size === 0 || !marketRef) return;
  const delta = Array.from(pendingDelta.values());
  pendingDelta.clear();
  // Update the baseline so the next diff is genuinely "changed only".
  for (const q of delta) lastSent.set(q.id, q);
  // `broadcastRel` itself checks `bufferedAmount ≥ BUFFER_HIGH` per channel and
  // awaits `bufferedAmountLow(...)` before sending — the §4.5 backpressure guard.
  void broadcastRel(env('quotesDelta', delta));
}

/** Broadcast a full snapshot (welcome-style resync), guarded by backpressure. */
async function sendFull(all: Quote[]): Promise<void> {
  if (all.length === 0) return;
  lastSent = new Map(all.map((q) => [q.id, q] as const));
  pendingDelta.clear();
  await broadcastRel(env('quotesFull', all));
}

// ---- toast side-concerns (§4.6 / §10) ----------------------------------------

function wireJoinLeaveToasts(
  conn: ReturnType<typeof useConnectionStore>,
  ui: ReturnType<typeof useUiStore>,
): void {
  let prevIds = new Set<string>(
    (conn.roster ?? []).map((p) => p.id).filter((id) => id !== conn.selfId),
  );
  watch(
    () => conn.roster,
    (roster) => {
      const next = new Set(
        (roster ?? []).map((p) => p.id).filter((id) => id !== conn.selfId),
      );
      for (const id of next) {
        if (!prevIds.has(id)) {
          const p = (roster ?? []).find((r) => r.id === id);
          ui.addToast({ kind: 'info', text: `${p?.name ?? 'Peer'} joined` });
        }
      }
      for (const id of prevIds) {
        if (!next.has(id)) {
          const p = prevRosterName(conn, id);
          ui.addToast({ kind: 'info', text: `${p ?? 'Peer'} left` });
        }
      }
      prevIds = next;
    },
  );
}

function prevRosterName(
  conn: ReturnType<typeof useConnectionStore>,
  id: string,
): string | undefined {
  // The roster already changed; the previous roster is unrecoverable from the
  // store, so we fall back to 'Peer'. (Names are best-effort in the toast.)
  void conn;
  void id;
  return undefined;
}

function wireHostVisibilityHint(ui: ReturnType<typeof useUiStore>): void {
  if (typeof document === 'undefined') return;
  let hinted = false;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && !hinted) {
      hinted = true;
      ui.addToast({ kind: 'warn', text: 'Keep this tab visible for smoothest updates.' });
    } else if (document.visibilityState === 'visible') {
      hinted = false;
    }
  });
}

/** Test-only: reset module-level state so unit tests can re-mount the bridge. */
export function _testResetQuotesBroadcast(): void {
  if (deltaFlushTimer !== undefined) { clearTimeout(deltaFlushTimer); deltaFlushTimer = undefined; }
  if (resyncTimer !== undefined) { clearInterval(resyncTimer); resyncTimer = undefined; }
  if (stopWatch) { stopWatch(); stopWatch = null; }
  pendingDelta.clear();
  lastSent = new Map();
  marketRef = null;
  installed = false;
}