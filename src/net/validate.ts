// src/net/validate.ts — HARD input validation on receive (§4.5).
//
// Pure, dependency-free helpers consumed by net/host.ts + net/guest.ts before
// any inbound Env touches state. Everything here is unit-testable (node env):
// shape guards, unknown-`t` ignore, chat clamp, chat rate-limit, pos rate-limit,
// name sanitize + dedupe. Strings are NEVER rendered as HTML downstream — we
// only normalize primitives here; the UI renders text nodes.

import type { Env, MsgType, MsgPayload } from './protocol';
import { CHAT_MAX_CHARS, CHAT_RATE, CHAT_RATE_WINDOW_MS, POS_RX_MAX_HZ } from '../config/net';

const KNOWN: ReadonlySet<MsgType> = new Set<MsgType>([
  'hello', 'welcome', 'manifestFull', 'roster', 'chat', 'sys',
  'quotesDelta', 'quotesFull', 'ping', 'pong', 'error', 'bye', 'pos',
]);

/** True iff `t` is one of the wire `MsgType` values. */
export function isKnownMsgType(t: unknown): t is MsgType {
  return typeof t === 'string' && KNOWN.has(t as MsgType);
}

/** Strip C0/DEL control chars, trim, clamp to length `max` (default 20 per §4.1). */
export function sanitizeName(raw: string, max = 20): string {
  const stripped = (raw ?? '')
    // remove C0 controls + DEL; keep everything else incl. tab? — no tabs either
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
  return stripped;
}

/**
 * Dedupe `desired` against `taken`. No collision ⇒ `desired`; first collision ⇒
 * `desired#2`, then `#3`, … (§4.1). A name that already carries a `#N` suffix
 * is treated as a base for the new arrival only when it collides.
 */
export function dedupeName(desired: string, taken: ReadonlySet<string>): string {
  const base = sanitizeName(desired);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}#${n}`)) n += 1;
  return `${base}#${n}`;
}

/** Clamp a chat message's text to `CHAT_MAX_CHARS` (§4.5). */
export function clampChatText(text: string): string {
  return (text ?? '').slice(0, CHAT_MAX_CHARS);
}

/** Parse + shape-check a raw inbound value into a typed `Env`, or null if it
 *  should be ignored (unknown `t` or bad envelope shape — §4.5 "unknown t ⇒ ignore"). */
export function parseEnv(raw: unknown): Env | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (!isKnownMsgType(o.t)) return null; // unknown t ⇒ ignore
  if (typeof o.from !== 'string') return null;
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return null;
  if (o.d === null || typeof o.d !== 'object' || Array.isArray(o.d)) return null;
  return { v: 1, t: o.t, from: o.from, ts: o.ts, d: o.d as MsgPayload[MsgType] };
}

/** True when `env.d` is structurally a valid `chat` payload. */
export function isChatPayload(d: unknown): d is MsgPayload['chat'] {
  return d !== null && typeof d === 'object' && typeof (d as { text?: unknown }).text === 'string';
}

/** True when `env.d` is structurally a valid `pos` payload. */
export function isPosPayload(d: unknown): d is MsgPayload['pos'] {
  if (d === null || typeof d !== 'object') return false;
  const p = d as { p?: unknown; q?: unknown };
  return (
    Array.isArray(p.p) && p.p.length === 3 && p.p.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) &&
    Array.isArray(p.q) && p.q.length === 4 && p.q.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))
  );
}

/** True when `env.d` is a valid `chat` payload with a `text` string (post-clamp handled by caller). */
export function isSysPayload(d: unknown): d is MsgPayload['sys'] {
  if (d === null || typeof d !== 'object') return false;
  const s = d as { kind?: unknown; text?: unknown };
  return (
    (s.kind === 'join' || s.kind === 'leave' || s.kind === 'info') &&
    typeof s.text === 'string'
  );
}

/**
 * Per-peer chat rate limiter (host-enforced, §4.5). `CHAT_RATE` messages per
 * `CHAT_RATE_WINDOW_MS`, sliding window. `allow(peerId)` returns false ⇒ drop +
 * emit a `sys` warn upstream.
 */
export class ChatRateLimiter {
  private buckets = new Map<string, number[]>();
  constructor(
    private readonly rate: number = CHAT_RATE,
    private readonly windowMs: number = CHAT_RATE_WINDOW_MS,
  ) {}
  allow(peerId: string, now: number): boolean {
    const arr = this.buckets.get(peerId) ?? [];
    const cutoff = now - this.windowMs;
    const fresh = arr.filter((t) => t > cutoff);
    if (fresh.length >= this.rate) {
      this.buckets.set(peerId, fresh);
      return false;
    }
    fresh.push(now);
    this.buckets.set(peerId, fresh);
    return true;
  }
  clear(peerId: string): void {
    this.buckets.delete(peerId);
  }
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Per-peer pos receive-rate limiter (§4.5). Accepts at most `POS_RX_MAX_HZ`
 * `pos` Envs per peer per second; extras are silently dropped (unreliable
 * channel anyway).
 */
export class PosRateLimiter {
  private last = new Map<string, number>();
  constructor(private readonly hz: number = POS_RX_MAX_HZ) {}
  allow(peerId: string, now: number): boolean {
    const minGap = 1000 / this.hz;
    const last = this.last.get(peerId);
    if (last !== undefined && now - last < minGap) return false;
    this.last.set(peerId, now);
    return true;
  }
  clear(peerId: string): void {
    this.last.delete(peerId);
  }
  reset(): void {
    this.last.clear();
  }
}