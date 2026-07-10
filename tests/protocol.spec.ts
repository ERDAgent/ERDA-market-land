// tests/protocol.spec.ts — validation surface in net/validate.ts + the M3
// cross-phase hooks asserted to exist on net/host.ts (§4.5, §15, order hooks).
//
// Pure logic / node environment. The host.ts hook-exports (broadcastRel,
// bufferedAmountLow) are imported and asserted to be functions so M4/M5 can
// rely on the explicit seam promised by this order.

import { describe, it, expect } from 'vitest';

import {
  isKnownMsgType,
  parseEnv,
  sanitizeName,
  dedupeName,
  clampChatText,
  isChatPayload,
  isPosPayload,
  isSysPayload,
  ChatRateLimiter,
  PosRateLimiter,
} from '../src/net/validate';
import {
  broadcastRel, bufferedAmountLow, emitRemoteShoot, hostSendShoot,
  isShootPayload, parseShootEnv,
} from '../src/net/host';
import { guestSendShoot } from '../src/net/guest';
import { CHAT_MAX_CHARS, CHAT_RATE, POS_RX_MAX_HZ } from '../src/config/net';

describe('net/validate — shape, clamp, rate-limit, unknown-t (§4.5)', () => {
  describe('unknown t ⇒ ignore', () => {
    it('isKnownMsgType accepts every wire type', () => {
      for (const t of ['hello', 'welcome', 'manifestFull', 'roster', 'chat', 'sys', 'metric', 'quotesDelta', 'quotesFull', 'ping', 'pong', 'error', 'bye', 'pos']) {
        expect(isKnownMsgType(t)).toBe(true);
      }
    });
    it('isKnownMsgType rejects unknown / non-string', () => {
      expect(isKnownMsgType('bogus')).toBe(false);
      expect(isKnownMsgType(7)).toBe(false);
      expect(isKnownMsgType(undefined)).toBe(false);
    });
    it('parseEnv returns null for unknown t (must NOT throw)', () => {
      const env = { v: 1, t: 'nope', from: 'p', ts: 0, d: {} };
      expect(parseEnv(env)).toBeNull();
    });
    it('parseEnv returns null for bad envelope shape (v, from, ts, d)', () => {
      expect(parseEnv(null)).toBeNull();
      expect(parseEnv('x')).toBeNull();
      expect(parseEnv({ t: 'chat', from: 'p', ts: 0, d: { text: 'hi' } })).toBeNull(); // no v
      expect(parseEnv({ v: 2, t: 'chat', from: 'p', ts: 0, d: { text: 'hi' } })).toBeNull(); // wrong v
      expect(parseEnv({ v: 1, t: 'chat', ts: 0, d: { text: 'hi' } })).toBeNull(); // no from
      expect(parseEnv({ v: 1, t: 'chat', from: 'p', ts: 'x', d: { text: 'hi' } })).toBeNull();
      expect(parseEnv({ v: 1, t: 'chat', from: 'p', ts: 0, d: null })).toBeNull();
    });
    it('parseEnv returns the typed Env for a well-formed chat', () => {
      const e = parseEnv({ v: 1, t: 'chat', from: 'p', ts: 5, d: { text: 'hi' } });
      expect(e).not.toBeNull();
      expect(e!.t).toBe('chat');
      expect((e!.d as { text: string }).text).toBe('hi');
    });
  });

  describe('chat clamp', () => {
    it('clampChatText truncates to CHAT_MAX_CHARS', () => {
      expect(clampChatText('x'.repeat(CHAT_MAX_CHARS)).length).toBe(CHAT_MAX_CHARS);
      expect(clampChatText('x'.repeat(CHAT_MAX_CHARS + 50)).length).toBe(CHAT_MAX_CHARS);
    });
    it('clampChatText leaves short text alone', () => {
      expect(clampChatText('hello')).toBe('hello');
    });
    it('nullish input becomes empty string (no throw)', () => {
      // @ts-expect-error — exercising runtime defence
      expect(clampChatText(undefined)).toBe('');
    });
  });

  describe('payload shape guards', () => {
    it('isChatPayload', () => {
      expect(isChatPayload({ text: 'hi' })).toBe(true);
      expect(isChatPayload({ text: 5 })).toBe(false);
      expect(isChatPayload({})).toBe(false);
    });
    it('isPosPayload requires p[3] + q[4] finite numbers', () => {
      expect(isPosPayload({ p: [1, 2, 3], q: [0, 0, 0, 1] })).toBe(true);
      expect(isPosPayload({ p: [1, 2], q: [0, 0, 0, 1] })).toBe(false);
      expect(isPosPayload({ p: [1, 2, 3], q: [0, 0, 0] })).toBe(false);
      expect(isPosPayload({ p: [1, 2, NaN], q: [0, 0, 0, 1] })).toBe(false);
      expect(isPosPayload({})).toBe(false);
    });
    it('isSysPayload accepts join/leave/info with text', () => {
      expect(isSysPayload({ kind: 'join', text: 'X joined' })).toBe(true);
      expect(isSysPayload({ kind: 'leave', text: 'X left' })).toBe(true);
      expect(isSysPayload({ kind: 'info', text: 'hi' })).toBe(true);
      expect(isSysPayload({ kind: 'bogus', text: 'x' })).toBe(false);
      expect(isSysPayload({ kind: 'join', text: 5 })).toBe(false);
    });
  });

  describe('chat rate-limit (CHAT_RATE / window)', () => {
    it('allows up to CHAT_RATE in one window then drops', () => {
      const rl = new ChatRateLimiter();
      const peer = 'p1';
      const t0 = 1000;
      for (let i = 0; i < CHAT_RATE; i++) {
        expect(rl.allow(peer, t0 + i)).toBe(true);
      }
      // CHAT_RATE+1 inside the same window → drop
      expect(rl.allow(peer, t0 + 999)).toBe(false);
    });
    it('recovers after the window slides', () => {
      const rl = new ChatRateLimiter();
      const peer = 'p2';
      const t0 = 5000;
      for (let i = 0; i < CHAT_RATE; i++) rl.allow(peer, t0 + i);
      expect(rl.allow(peer, t0 + 100)).toBe(false);
      // past the window boundary, fresh budget
      expect(rl.allow(peer, t0 + 10000 + 1)).toBe(true);
    });
    it('is per-peer independent', () => {
      const rl = new ChatRateLimiter();
      for (let i = 0; i < CHAT_RATE; i++) rl.allow('a', i);
      expect(rl.allow('a', 100)).toBe(false);
      expect(rl.allow('b', 100)).toBe(true);
      rl.clear('a');
      expect(rl.allow('a', 9999)).toBe(true);
    });
  });

  describe('pos receive rate-limit (POS_RX_MAX_HZ)', () => {
    it('drops pos messages faster than POS_RX_MAX_HZ per peer', () => {
      const rl = new PosRateLimiter();
      const minGap = 1000 / POS_RX_MAX_HZ;
      expect(rl.allow('p', 0)).toBe(true);
      // just under the gap → dropped
      expect(rl.allow('p', minGap - 1)).toBe(false);
      // at/over the gap → accepted
      expect(rl.allow('p', minGap)).toBe(true);
    });
    it('per-peer independence + clear', () => {
      const rl = new PosRateLimiter();
      expect(rl.allow('a', 0)).toBe(true);
      expect(rl.allow('b', 0)).toBe(true); // different peer, same instant ok
      rl.clear('a');
      expect(rl.allow('a', 1)).toBe(true);
    });
  });

  describe('name sanitize + dedupe (§4.1)', () => {
    it('sanitizeName trims, strips control chars, clamps to 20', () => {
      expect(sanitizeName('  Alice  ')).toBe('Alice');
      expect(sanitizeName('A\u0000b\u0007c\u007fd')).toBe('Abcd');
      expect(sanitizeName('x'.repeat(40))).toHaveLength(20);
      expect(sanitizeName('   ')).toBe('');
    });
    it('dedupeName: no collision returns base', () => {
      expect(dedupeName('Alice', new Set())).toBe('Alice');
    });
    it('dedupeName: first collision ⇒ #2, then #3', () => {
      const taken = new Set<string>(['Alice', 'Alice#3']);
      expect(dedupeName('Alice', taken)).toBe('Alice#2');
      const taken2 = new Set<string>(['Alice', 'Alice#2', 'Alice#3']);
      expect(dedupeName('Alice', taken2)).toBe('Alice#4');
    });
  });
});

describe('M3 cross-phase hooks on net/host.ts (order §cross-phase hooks)', () => {
  it('broadcastRel is a function (M5 quotes-broadcast bridge consumes it)', () => {
    expect(typeof broadcastRel).toBe('function');
  });
  it('bufferedAmountLow is a function (M5 quotes-broadcast bridge consumes it)', () => {
    expect(typeof bufferedAmountLow).toBe('function');
  });
});

describe('BULLET1 shoot wire shape (additive, pre-authorized MsgType)', () => {
  it('hostSendShoot / guestSendShoot / emitRemoteShoot are exported functions', () => {
    expect(typeof hostSendShoot).toBe('function');
    expect(typeof guestSendShoot).toBe('function');
    expect(typeof emitRemoteShoot).toBe('function');
  });

  describe('isShootPayload', () => {
    it('accepts origin/dir triples with an optional hitId', () => {
      expect(isShootPayload({ origin: [0, 0, 0], dir: [0, 0, -1] })).toBe(true);
      expect(isShootPayload({ origin: [0, 0, 0], dir: [0, 0, -1], hitId: 'a' })).toBe(true);
    });
    it('rejects a wrong-length vector, non-finite numbers, or a non-string hitId', () => {
      expect(isShootPayload({ origin: [0, 0], dir: [0, 0, -1] })).toBe(false);
      expect(isShootPayload({ origin: [0, 0, NaN], dir: [0, 0, -1] })).toBe(false);
      expect(isShootPayload({ origin: [0, 0, 0], dir: [0, 0, -1], hitId: 5 })).toBe(false);
      expect(isShootPayload({})).toBe(false);
      expect(isShootPayload(null)).toBe(false);
    });
  });

  describe('parseShootEnv', () => {
    it('parses a well-formed shoot envelope', () => {
      const env = parseShootEnv({ v: 1, t: 'shoot', from: 'p', ts: 5, d: { origin: [1, 2, 3], dir: [0, 0, -1] } });
      expect(env).not.toBeNull();
      expect(env!.d.origin).toEqual([1, 2, 3]);
    });
    it('rejects a non-shoot t, bad envelope shape, or bad payload', () => {
      expect(parseShootEnv({ v: 1, t: 'chat', from: 'p', ts: 5, d: { text: 'hi' } })).toBeNull();
      expect(parseShootEnv({ v: 2, t: 'shoot', from: 'p', ts: 5, d: { origin: [0, 0, 0], dir: [0, 0, -1] } })).toBeNull();
      expect(parseShootEnv({ v: 1, t: 'shoot', from: 'p', ts: 5, d: { origin: [0, 0], dir: [0, 0, -1] } })).toBeNull();
      expect(parseShootEnv(null)).toBeNull();
    });
  });
});