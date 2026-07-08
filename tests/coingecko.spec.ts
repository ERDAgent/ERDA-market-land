// tests/coingecko.spec.ts — §5.2 CoinGecko pure mapping helper (no network).
import { describe, it, expect } from 'vitest';
import { mapCoinGeckoRow } from '../src/data/providers/coingecko';
import type { Instrument } from '../src/net/protocol';

function inst(over: Partial<Instrument>): Instrument {
  return {
    id: 'btc',
    ticker: 'BTC',
    name: 'Bitcoin',
    category: 'crypto',
    district: 'crypto',
    provider: 'coingecko',
    providerSymbol: 'bitcoin',
    refPrice: 70000,
    mcapUSD: 1400000000000,
    sizeTier: 3,
    ...over,
  };
}

describe('§5.2 mapCoinGeckoRow — field contract', () => {
  it('maps current_price → price, price_change_percentage_24h → changePct, market_cap → marketCap', () => {
    const q = mapCoinGeckoRow(
      { id: 'bitcoin', current_price: 68000.5, price_change_percentage_24h: 2.34, market_cap: 1.4e12 },
      inst({}),
      false,
      1_000,
    );
    expect(q.id).toBe('btc');
    expect(q.source).toBe('coingecko');
    expect(q.session).toBe('24_7');
    expect(q.stale).toBe(false);
    expect(q.price).toBe(68000.5);
    expect(q.changePct).toBeCloseTo(2.34, 6);
    expect(q.marketCap).toBe(1.4e12);
    expect(q.ts).toBe(1_000);
  });

  it('falls back to refPrice when current_price missing, and changePct to 0 when null', () => {
    const q = mapCoinGeckoRow({ id: 'bitcoin', price_change_percentage_24h: null }, inst({ refPrice: 70000 }), true, 5);
    expect(q.price).toBe(70000);
    expect(q.changePct).toBe(0);
    expect(q.marketCap).toBe(1400000000000);
    expect(q.stale).toBe(true);
  });

  it('market_cap missing → manifest mcapUSD fallback', () => {
    const q = mapCoinGeckoRow(
      { id: 'sol', current_price: 170, price_change_percentage_24h: -1.2 },
      inst({ id: 'sol', providerSymbol: 'solana', mcapUSD: 8e10 }),
      false,
      9,
    );
    expect(q.marketCap).toBe(8e10);
    expect(q.changePct).toBeCloseTo(-1.2, 6);
  });
});
