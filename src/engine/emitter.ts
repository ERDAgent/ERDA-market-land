/**
 * Hand-rolled typed event emitter (~15 lines). No dependency.
 *
 * The emitter is open/extensible: `EngineEvents` declares the events M0 owns
 * plus an index signature, so later phases may add keys via TS module
 * augmentation in their *own* files without re-editing this one — but they may
 * also simply emit on any string key (index signature permits it).
 */

export interface EngineEvents {
  /** Picking result: an instrument id, or null when the pick cleared. */
  pick: { id: string | null };
  /** Pointer lock was requested but rejected by the user/UA. */
  requestPointerLockFailed: undefined;
  /** A remote peer position arrived (M3 emits; M4 consumes). */
  remotePos: { id: string; pos: ArrayLike<number> };
  /** Open-ended: future phases append keys via declaration merging. */
  [key: string]: unknown;
}

export type EventHandler<T> = (payload: T) => void;

export class Emitter<E extends Record<string, unknown> = EngineEvents> {
  private handlers = new Map<keyof E, Set<EventHandler<unknown>>>();

  on<K extends keyof E>(type: K, fn: EventHandler<E[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn as EventHandler<unknown>);
    return () => set!.delete(fn as EventHandler<unknown>);
  }

  once<K extends keyof E>(type: K, fn: EventHandler<E[K]>): () => void {
    const off = this.on(type, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of Array.from(set)) (fn as EventHandler<E[K]>)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}

export const createEmitter = <E extends Record<string, unknown> = EngineEvents>(): Emitter<E> =>
  new Emitter<E>();