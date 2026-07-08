// src/bridges/market.ts — store↔engine wiring for market data + selection.
//
// Discovered by M0's `useEngineBridge` glob runner (one-time, first world
// mount). Registers the `engine.api.market` seam (M3's welcome reads
// `snapshot()`, M5 subscribes to deltas), wires `engine.events 'pick'` →
// `ui.selectedInstrumentId`, and watches `market.quotes` / `market.metric` →
// the buildings system (height/color retarget) + the labels system (dirty
// marks). Starts the data scheduler once (host/solo-only; M1 is solo-only —
// no networking here, the scheduler emits nothing over a wire).
//
// This is the SEAM: later phases add their own `bridges/*.ts` files; this file
// is never re-edited. Reads the M0/M0C frozen core + stores it depends on.

import { watch, type WatchStopHandle } from 'vue';
import { useMarketStore } from '../stores/market';
import { useUiStore } from '../stores/ui';
import { useSettingsStore } from '../stores/settings';
import { startScheduler } from '../data/scheduler';
import type { Quote } from '../net/protocol';
import type { HeightMetric } from '../config/metrics';
import type { BuildingsApi } from '../engine/systems/buildings';
import type { LabelsApi } from '../engine/systems/labels';

type EngineLike = import('../engine/core').Engine;

let stopWatches: WatchStopHandle[] = [];
let installed = false;

export default function marketBridge(engine: EngineLike): void {
  // Idempotent guard: the glob runner is one-shot in the app, but the bridge
  // module could be imported during HMR / tests; never double-wire.
  if (installed) return;

  const market = useMarketStore();
  const ui = useUiStore();
  const settings = useSettingsStore();

  // --- engine.api.market seam -------------------------------------------------
  engine.api.market = {
    snapshot: () => market.snapshot(),
    applyDelta: (qs: Quote[]) => market.applyDelta(qs),
    applyFull: (all: Quote[]) => market.applyFull(all),
    setMetric: (m: HeightMetric) => {
      market.setMetric(m);
    },
    pick: (id: string | null) => {
      ui.selectedInstrumentId = id;
    },
  };

  // --- pick events → ui store -------------------------------------------------
  const offPick = engine.events.on('pick', (p: { id: string | null }) => {
    ui.selectedInstrumentId = p.id;
  });

  // --- market.quotes → buildings refresh + labels dirty -----------------------
  const unsubQuotes = watch(
    () => market.quotes,
    (qs: Map<string, Quote>) => {
      const b = engine.api.buildings as BuildingsApi | undefined;
      if (b) b.refresh();
      (engine.api.labels as LabelsApi | undefined)?.markDirty(Array.from(qs.values()));
    },
  );

  // --- market.metric → buildings recompute heights ----------------------------
  const unsubMetric = watch(
    () => market.metric,
    (m: HeightMetric) => {
      (engine.api.buildings as BuildingsApi | undefined)?.applyMetric(m);
    },
  );

  stopWatches = [unsubQuotes, unsubMetric, () => offPick()];

  // --- start the local scheduler (solo at M1; no networking) ------------------
  startScheduler({
    onDelta: (qs: Quote[]) => {
      market.applyDelta(qs);
    },
    onFull: (all: Quote[]) => {
      // LOCAL resync hook (M5 wires the wire fan-out). At M1 this keeps the
      // store in sync with the scheduler's full snapshot every QUOTES_RESYNC_MS.
      market.applyFull(all);
    },
    finnhubKey: settings.finnhubKey,
    forceSimulated: settings.demoMode,
  });

  installed = true;
}