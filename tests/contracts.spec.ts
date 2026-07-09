// tests/contracts.spec.ts — freezes the M0C contract surface.
//
// Asserts the constants, plot math, and manifest shape so a silent regression
// of any frozen contract fails CI. Pure logic only ( Vitest node environment) —
// no Three, no DOM, no network.

import { describe, it, expect } from 'vitest';

import {
  type Env,
  type MsgType,
  type MsgPayload,
  type PeerInfo,
  type ChatMsg,
  type Quote,
  type QuoteProvider,
  type Instrument,
  PROTOCOL_VERSION,
} from '../src/net/protocol';

import {
  MAX_GUESTS,
  PREFIX,
  PREFIX_UNCOMPRESSED,
  CH_REL,
  CH_POS,
  STUN_URL,
  POS_HZ,
  PING_MS,
  PING_MISSES_DROP,
  CHAT_RATE,
  CHAT_RATE_WINDOW_MS,
  POS_RX_MAX_HZ,
  CHAT_TAIL,
  CHAT_MAX_CHARS,
  COINGECKO_INTERVAL_MS,
  FINNHUB_BURST_SPACING_MS,
  FINNHUB_CYCLE_MS,
  FINNHUB_MAX_PER_MIN,
  SIM_TICK_MS,
  QUOTES_RESYNC_MS,
  STALE_MULT,
  BUFFER_HIGH,
  BUFFER_LOW_THRESHOLD,
  SIM_SIGMA,
  SIM_CHANGE_CLAMP_PCT,
  PROV_COINGECKO,
  PROV_FINNHUB,
  PROV_SIMULATED,
} from '../src/config/net';
// Re-export lives in config/net.ts; both paths must resolve to the same value.
import { PROTOCOL_VERSION as PROTOCOL_VERSION_FROM_NET } from '../src/config/net';

import {
  type DistrictId,
  DISTRICTS,
  PLOT,
  STREET,
  PITCH,
  plotCenter,
  districtAt,
} from '../src/config/city';

import instrumentsData from '../src/data/manifest/instruments.json';
import { instruments, manifestErrors, validateManifest } from '../src/data/manifest/validate';

// touch the type-only imports so they participate in the compile graph
// (no assertion needed; their mere presence is the contract)
type _ContractTypes =
  | Env | MsgType | MsgPayload | PeerInfo | ChatMsg
  | Quote | QuoteProvider | Instrument | DistrictId;

function expectType<T>(_x: T): void { /* type-only helper */ }
expectType<Env>({ v: 1, t: 'ping', from: '', ts: 0, d: { n: 0 } });

describe('M0C frozen contracts', () => {
  describe('protocol version + envelope (§4.5)', () => {
    it('PROTOCOL_VERSION === 1 (and config/net re-exports the same home)', () => {
      expect(PROTOCOL_VERSION).toBe(1);
      expect(PROTOCOL_VERSION_FROM_NET).toBe(1);
    });

    it('MsgType covers every wire + data type', () => {
      // compile-time: a value of each MsgType satisfies the union
      const types: MsgType[] = [
        'hello', 'welcome', 'manifestFull', 'roster', 'chat', 'sys', 'metric',
        'quotesDelta', 'quotesFull', 'ping', 'pong', 'error', 'bye', 'pos',
      ];
      expect(types).toHaveLength(14);
      expect(new Set(types).size).toBe(14);
    });

    it('Env<T> narrows d to the typed payload (compile-time + runtime sanity)', () => {
      const ping: Env<'ping'> = { v: 1, t: 'ping', from: 'p1', ts: 7, d: { n: 1 } };
      const bye: Env<'bye'> = { v: 1, t: 'bye', from: 'p1', ts: 7, d: {} };
      expect(ping.d.n).toBe(1);
      expect(bye.d).toEqual({});
    });
  });

  describe('config/net constants (§4.2/§4.3/§4.5/§5)', () => {
    it('peer caps + signaling', () => {
      expect(MAX_GUESTS).toBe(8);
      expect(PREFIX).toBe('EML1.');
      expect(PREFIX_UNCOMPRESSED).toBe('EML1u.');
    });
    it('channels + ICE', () => {
      expect(CH_REL).toBe('rel');
      expect(CH_POS).toBe('pos');
      expect(STUN_URL).toBe('stun:stun.l.google.com:19302');
    });
    it('cadences', () => {
      expect(POS_HZ).toBe(12);
      expect(PING_MS).toBe(10000);
      expect(PING_MISSES_DROP).toBe(3);
      expect(CHAT_RATE).toBe(5);
      expect(CHAT_RATE_WINDOW_MS).toBe(2000);
      expect(POS_RX_MAX_HZ).toBe(20);
      expect(CHAT_TAIL).toBe(50);
      expect(CHAT_MAX_CHARS).toBe(500);
    });
    it('data budgets', () => {
      expect(COINGECKO_INTERVAL_MS).toBe(60000);
      expect(FINNHUB_BURST_SPACING_MS).toBe(250);
      expect(FINNHUB_CYCLE_MS).toBe(60000);
      expect(FINNHUB_MAX_PER_MIN).toBe(50);
      expect(SIM_TICK_MS).toBe(5000);
      expect(QUOTES_RESYNC_MS).toBe(300000);
      expect(STALE_MULT).toBe(3);
    });
    it('backpressure', () => {
      expect(BUFFER_HIGH).toBe(1_000_000);
      expect(BUFFER_LOW_THRESHOLD).toBe(256 * 1024);
    });
    it('sim sigmas + clamp', () => {
      expect(SIM_SIGMA).toEqual({
        crypto: 0.0015, stock: 0.0005, index: 0.0003,
        commodity: 0.0004, fx: 0.0001,
      });
      expect(SIM_CHANGE_CLAMP_PCT).toBe(9);
    });
    it('provider id constants equal Quote.source literals', () => {
      const sources: Quote['source'][] = ['coingecko', 'finnhub', 'simulated'];
      expect(sources).toContain(PROV_COINGECKO);
      expect(sources).toContain(PROV_FINNHUB);
      expect(sources).toContain(PROV_SIMULATED);
      expect([PROV_COINGECKO, PROV_FINNHUB, PROV_SIMULATED].sort())
        .toEqual(['coingecko', 'finnhub', 'simulated'].sort());
    });
  });

  describe('config/city plot math (§7.1)', () => {
    it('plot dimensions', () => {
      expect(PLOT).toBe(150);
      expect(STREET).toBe(30);
      expect(PITCH).toBe(180);
    });
    it('plotCenter returns (col·PITCH, 0, row·PITCH)', () => {
      expect(plotCenter(0, 0)).toEqual([0, 0, 0]);
      expect(plotCenter(1, 0)).toEqual([180, 0, 0]);
      expect(plotCenter(0, 1)).toEqual([0, 0, 180]);
      expect(plotCenter(-1, -1)).toEqual([-180, 0, -180]);
    });
    it('grid → district mapping matches the frozen layout', () => {
      //        col −1            col 0              col +1
      // row −1 CRYPTO            TECH               FINANCE
      // row  0 COMMODITIES       INDEXES            HEALTHCARE
      // row +1 FX                CONSUMER           ENERGY & INDUSTRIALS
      expect(districtAt(-1, -1)).toBe('crypto');
      expect(districtAt( 0, -1)).toBe('tech');
      expect(districtAt( 1, -1)).toBe('finance');
      expect(districtAt(-1,  0)).toBe('commodities');
      expect(districtAt( 0,  0)).toBe('indexes');
      expect(districtAt( 1,  0)).toBe('healthcare');
      expect(districtAt(-1,  1)).toBe('fx');
      expect(districtAt( 0,  1)).toBe('consumer');
      expect(districtAt( 1,  1)).toBe('energy_industrial');
    });
    it('every DistrictId has a unique grid cell + palette color', () => {
      const cells = Object.values(DISTRICTS).map((d) => `${d.col},${d.row}`);
      expect(new Set(cells).size).toBe(9);
      for (const d of Object.values(DISTRICTS)) {
        expect(d.color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    });
    it('plotCenter grid alignment: (-1,-1)→CRYPTO, (0,0)→INDEXES, (1,-1)→FINANCE', () => {
      const cryptoCenter = plotCenter(DISTRICTS.crypto.col, DISTRICTS.crypto.row);
      const indexCenter = plotCenter(DISTRICTS.indexes.col, DISTRICTS.indexes.row);
      const financeCenter = plotCenter(DISTRICTS.finance.col, DISTRICTS.finance.row);
      expect(plotCenter(-1, -1)).toEqual(cryptoCenter);
      expect(plotCenter( 0,  0)).toEqual(indexCenter);
      expect(plotCenter( 1, -1)).toEqual(financeCenter);
    });
  });

  describe('manifest roster (§6.2)', () => {
    it('loads to exactly 117 entries with unique ids', () => {
      const arr = instrumentsData as Array<{ id: string }>;
      expect(arr).toHaveLength(117);
      const ids = arr.map((x) => x.id);
      expect(new Set(ids).size).toBe(117);
      expect(instruments).toHaveLength(117);
    });
    it('district counts match §6.2 table', () => {
      const countBy: Record<string, number> = {};
      for (const inst of instruments) countBy[inst.district] = (countBy[inst.district] || 0) + 1;
      expect(countBy).toEqual({
        indexes: 9, tech: 16, finance: 12, healthcare: 10,
        consumer: 14, energy_industrial: 12, crypto: 24,
        commodities: 12, fx: 8,
      });
    });
    it('stablecoins excluded (USDT/USDC/BUSD/DAI absent)', () => {
      const ids = new Set(instruments.map((x) => x.id));
      for (const s of ['usdt', 'usdc', 'busd', 'dai', 'tusd', 'frax']) {
        expect(ids.has(s)).toBe(false);
      }
    });
    it('load-time validator ran green', () => {
      expect(manifestErrors).toEqual([]);
    });
    it('validator flags an injected duplicate id', () => {
      const bad: Instrument[] = [
        { id: 'dup', ticker: 'DUP', name: 'D', category: 'stock',
          district: 'tech', provider: 'finnhub', providerSymbol: 'DUP',
          refPrice: 1, sizeTier: 1 },
        { id: 'dup', ticker: 'DUP', name: 'D', category: 'stock',
          district: 'tech', provider: 'finnhub', providerSymbol: 'DUP',
          refPrice: 1, sizeTier: 1 },
      ];
      expect(validateManifest(bad).length).toBeGreaterThan(0);
    });
    it('validator flags a crypto→finnhub routing violation', () => {
      const bad: Instrument[] = [
        { id: 'bog', ticker: 'BOG', name: 'B', category: 'crypto',
          district: 'crypto', provider: 'finnhub', providerSymbol: 'bog',
          refPrice: 1, sizeTier: 1 },
      ];
      expect(validateManifest(bad).some((e) => /bad provider/.test(e))).toBe(true);
    });
  });
});