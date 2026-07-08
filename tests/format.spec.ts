// tests/format.spec.ts — price / change % / market-cap formatters (§8.3).

import { describe, it, expect } from 'vitest';
import {
  formatPrice,
  formatChangePct,
  formatMarketCap,
  districtLabel,
} from '../src/utils/format';

describe('formatPrice', () => {
  it('>=1000 → grouped, up to 2 decimals', () => {
    expect(formatPrice(1234.5)).toBe('1,234.5');
    expect(formatPrice(1234)).toBe('1,234');
    expect(formatPrice(60000)).toBe('60,000');
  });
  it('1..1000 → 2 decimals', () => {
    expect(formatPrice(530)).toBe('530.00');
    expect(formatPrice(375.5)).toBe('375.50');
    expect(formatPrice(1)).toBe('1.00');
  });
  it('boundary: <1 falls to the 4-decimal branch', () => {
    expect(formatPrice(0.52)).toBe('0.5200');
  });
  it('0.01..1 → 4 decimals', () => {
    expect(formatPrice(0.5234)).toBe('0.5234');
    expect(formatPrice(0.1)).toBe('0.1000');
  });
  it('<0.01 → 6 significant digits', () => {
    expect(formatPrice(0.000123456)).toMatch(/^0\.0001234/);
  });
  it('0 → "0", NaN/Infinity → "—"', () => {
    expect(formatPrice(0)).toBe('0');
    expect(formatPrice(NaN)).toBe('—');
    expect(formatPrice(Infinity)).toBe('—');
  });
});

describe('formatChangePct', () => {
  it('signed, 2 decimals', () => {
    expect(formatChangePct(3.456)).toBe('+3.46%');
    expect(formatChangePct(-1.2)).toBe('-1.20%');
    expect(formatChangePct(0)).toBe('+0.00%');
    expect(formatChangePct(-0.04)).toBe('-0.04%');
  });
  it('NaN → "—"', () => {
    expect(formatChangePct(NaN)).toBe('—');
  });
});

describe('formatMarketCap', () => {
  it('T / B / M suffixes', () => {
    expect(formatMarketCap(3e12)).toBe('$3.00 T');
    expect(formatMarketCap(300e9)).toBe('$300.0 B');
    expect(formatMarketCap(12.5e6)).toBe('$12.5 M');
  });
  it('undefined/NaN → "—"', () => {
    expect(formatMarketCap(undefined)).toBe('—');
    expect(formatMarketCap(NaN)).toBe('—');
  });
});

describe('districtLabel', () => {
  it('maps every frozen DistrictId to a readable name', () => {
    expect(districtLabel('indexes')).toBe('Indexes');
    expect(districtLabel('tech')).toBe('Tech');
    expect(districtLabel('energy_industrial')).toBe('Energy & Industrials');
    expect(districtLabel('crypto')).toBe('Crypto');
    expect(districtLabel('fx')).toBe('FX');
  });
});