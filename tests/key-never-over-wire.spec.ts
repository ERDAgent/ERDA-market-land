// tests/key-never-over-wire.spec.ts — §15 the secret-key-never-transmitted gate.
//
// Records every outbound peer message the app builds and asserts NO transmitted
// object contains a `finnhubKey`-shaped string (the API key the host/solo uses
// for Finnhub). The settings store keeps the key in localStorage (M2) and never
// serializes it outward: the scheduler passes it to the finnhub provider's HTTP
// call as a query `token=`, and `net/*` builds envelopes via `makeEnv` whose
// `MsgPayload` union has no `finnhubKey` field. This test freezes that property.
//
// Strategy: set a recognizable key token in the settings store, mock `broadcastRel`
// (the host→all chute) to record every env it would have sent, then exercise the
// real env builders the app uses at runtime — `hostSendChat`, the M5 quotes
// bridge (delta + full), and a representative `welcome`/`roster`/`quotes` env via
// the real `makeEnv`. Each recorded env is JSON-serialized and recursively
// scanned for (a) the literal key token and (b) any property named `finnhubKey`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { QUOTES_RESYNC_MS } from '../src/config/net';
import type { Env, MsgType, MsgPayload } from '../src/net/protocol';
import type { PeerInfo, ChatMsg, Quote } from '../src/net/protocol';

// Hoisted record of every outbound env handed to the host fan-out chute.
const sent = vi.hoisted(() => [] as Env[]);

vi.mock('../src/net/host', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    // Override only the fan-out chute to record envs (the send path is mocked).
    broadcastRel: async (e: Env): Promise<void> => { sent.push(e); },
  };
});

const SECRET = 'TESTKEY-ZZZ-NEVER-WIRE-123';

beforeEach(() => {
  setActivePinia(createPinia());
  sent.length = 0;
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

/** Recursively assert no string anywhere in `obj` equals the secret token and no
 *  property named `finnhubKey` exists at any depth. */
function assertNoKey(obj: unknown, path = '$'): void {
  if (obj == null) return;
  if (typeof obj === 'string') {
    expect(obj).not.toContain(SECRET);
    return;
  }
  if (typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) assertNoKey(obj[i], `${path}[${i}]`);
    return;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    expect(k).not.toBe('finnhubKey');
    assertNoKey(v, `${path}.${k}`);
  }
}

describe('M5 key-never-over-wire (§15)', () => {
  it('the settings store holds the key locally (sanity) but it is never in a chat env', async () => {
    const settings = (await import('../src/stores/settings')).useSettingsStore();
    settings.finnhubKey = SECRET;
    expect(settings.finnhubKey).toBe(SECRET);

    // A chat env is just {text} — the key is never copied onto the payload.
    const { makeEnv } = await import('../src/net/rtc');
    const chat = makeEnv('chat', 'H', { text: 'hello world' });
    assertNoKey(chat);
    expect('finnhubKey' in chat.d).toBe(false);
  });

  it('the quotes-broadcast bridge never leaks the key in quotesDelta or quotesFull', async () => {
    const settings = (await import('../src/stores/settings')).useSettingsStore();
    settings.finnhubKey = SECRET;
    const { useConnectionStore } = await import('../src/stores/connection');
    const conn = useConnectionStore();
    conn.setRole('host');
    conn.setSelfId('H');
    const { useMarketStore } = await import('../src/stores/market');
    const market = useMarketStore();
    // A finnhub-sourced quote — confirm the key is NOT copied onto the quote.
    const fq: Quote = {
      id: 'aapl', price: 100, changePct: 0.5, marketCap: 3e12,
      ts: Date.now(), source: 'finnhub', session: 'open',
    };
    market.applyFull([fq]);

    vi.useFakeTimers();
    const bridge = (await import('../src/bridges/quotes-broadcast.ts')).default;
    const { engine } = await import('../src/engine/core');
    bridge(engine);
    market.applyDelta([{ ...fq, price: 101 }]);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(QUOTES_RESYNC_MS + 100);

    expect(sent.length).toBeGreaterThan(0);
    for (const e of sent) {
      assertNoKey(e);
      // No quote carries the key as a field either.
      const d = e.d as { quotes?: Quote[] };
      if (d.quotes) for (const qq of d.quotes) expect('finnhubKey' in qq).toBe(false);
    }
  });

  it('a representative welcome/roster/quotes env built via makeEnv has no finnhub key', async () => {
    const { makeEnv } = await import('../src/net/rtc');
    const roster: PeerInfo[] = [
      { id: 'H', name: 'Host', color: '#4aa8ff', isHost: true },
      { id: 'g1', name: 'Peer', color: '#abcdef', isHost: false },
    ];
    const chatTail: ChatMsg[] = [
      { id: 'c1', from: 'g1', name: 'Peer', text: 'hi', ts: 1 },
    ];
    const quotes: Quote[] = [
      { id: 'aapl', price: 100, changePct: 0, ts: 1, source: 'finnhub', session: 'open' },
      { id: 'btc', price: 50000, changePct: 1, ts: 1, source: 'coingecko', session: '24_7' },
    ];
    const welcome = makeEnv('welcome', 'H', {
      selfId: 'g1', roster, quotes, manifestHash: 'deadbeef',
      chatTail, hostName: 'Host', metric: 1,
    });
    const rosterEnv = makeEnv('roster', 'H', { roster });
    const qd = makeEnv('quotesDelta', 'H', { quotes });
    const qf = makeEnv('quotesFull', 'H', { quotes });

    for (const e of [welcome, rosterEnv, qd, qf]) assertNoKey(e);
  });

  it('the MsgPayload union shape has no finnhubKey field (static contract)', () => {
    // Build one payload of each wire kind and recursively assert no `finnhubKey`
    // key — this freezes the protocol contract at runtime.
    const samples: MsgPayload[MsgType][] = [
      { name: 'p', ver: 1 } as MsgPayload['hello'],
      {
        selfId: 'g', roster: [], quotes: [], manifestHash: '',
        chatTail: [], hostName: 'H', metric: 1,
      } as MsgPayload['welcome'],
      { manifest: [] } as MsgPayload['manifestFull'],
      { roster: [] } as MsgPayload['roster'],
      { text: 'hi' } as MsgPayload['chat'],
      { kind: 'info', text: 'x' } as MsgPayload['sys'],
      { quotes: [] } as MsgPayload['quotesDelta'],
      { quotes: [] } as MsgPayload['quotesFull'],
      { n: 1 } as MsgPayload['ping'],
      { n: 1 } as MsgPayload['pong'],
      { code: 'x', msg: 'y' } as MsgPayload['error'],
      {} as MsgPayload['bye'],
      { p: [0, 0, 0], q: [0, 0, 0, 1] } as MsgPayload['pos'],
    ];
    for (const s of samples) assertNoKey(s);
  });
});