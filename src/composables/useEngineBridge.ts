/**
 * The ONE place Vue meets the engine. A one-time registry runner: it discovers
 * store↔engine wiring modules under `src/bridges/*.ts` (eager glob) and calls
 * each default export `function(engine)` exactly once with the engine singleton.
 *
 * Later phases DROP a `bridges/*.ts` file (M1 market, M3 connection, M4 avatars,
 * M5 quotes-broadcast) — they are NOT stubbed here and this file is NEVER
 * re-edited. At M0 `src/bridges/` is empty → the glob returns `{}` → fine, the
 * runner is a no-op. `engine.api` stays `{}` (plus the built-in `fly` sliver).
 *
 * The runner is idempotent across the app lifetime: it fires the first time it
 * is called (from WorldCanvas onMounted, after `engine.init`). The engine is a
 * singleton, so bridges attached once keep working across join→menu→rejoin.
 */
import { engine } from '../engine/core';

type BridgeInstaller = (engine: typeof import('../engine/core').engine) => void;

const modules = import.meta.glob('../../bridges/*.ts', { eager: true }) as Record<
  string,
  { default?: BridgeInstaller } | undefined
>;

let ranOnce = false;

export function useEngineBridge(): void {
  if (ranOnce) return;
  ranOnce = true;
  for (const mod of Object.values(modules)) {
    const installer = mod?.default;
    if (typeof installer === 'function') {
      try {
        installer(engine);
      } catch {
        // A bridge wiring error must never take down the world at start.
        // The owning phase should make its own failures observable.
      }
    }
  }
}

/** Test-only escape hatch (not used by app code) to allow re-running in unit tests. */
export function _resetEngineBridge(): void {
  ranOnce = false;
}