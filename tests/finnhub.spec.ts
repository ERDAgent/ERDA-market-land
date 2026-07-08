// tests/finnhub.spec.ts — §5.3 Finnhub pure helpers (no network).
//
// Drives the exported pure helpers: `computeChangePct` (the dp null/0 after-hours
// fallback math) and `usMarketSession`. No fetch, no pinia, no DOM — the
// provider module imports are bounded to the pure functions.

import { describe, it, expect } from 'vitest';
import { computeChangePct, usMarketSession } from '../src/data/providers/finnhub';

describe('§5.3 computeChangePct — dp fallback math', () => {
  it('uses dp when it is a valid nonzero number', () => {
    expect(computeChangePct(225, 1.25, 222.22, 0)).toBe(1.25);
  });

  it('dp null → falls back to (c/pc − 1) × 100', () => {
    // c=222, pc=220 → (222/220 − 1)*100 ≈ 0.9090909
    expect(computeChangePct(222, null, 220, null)).toBeCloseTo(0.909090909, 6);
  });

  it('dp 0 with c===pc → computes 0 (after-hours degenerate)', () => {
    expect(computeChangePct(220.5, 0, 220.5, 99)).toBeCloseTo(0, 6);
  });

  it('dp 0 with c!==pc → computes the real change from pc', () => {
    // c=210, pc=200, dp=0 → (210/200 − 1)*100 = 5
    expect(computeChangePct(210, 0, 200, 0)).toBeCloseTo(5, 10);
  });

  it('all degenerate (dp null, pc null) → keeps last known', () => {
    expect(computeChangePct(50, null, null, -2.5)).toBe(-2.5);
  });

  it('all degenerate with no last known → 0 (never NaN)', () => {
    expect(computeChangePct(50, null, null, null)).toBe(0);
    expect(computeChangePct(null, null, null, null)).toBe(0);
  });

  it('NaN/Infinity payloads are rejected → last known', () => {
    expect(computeChangePct(NaN, NaN, NaN, 3.3)).toBe(3.3);
    // dp null, c non-finite → formula skipped → last known 1
    expect(computeChangePct(Infinity, null, 100, 1)).toBe(1);
  });
});

describe('§5.3 usMarketSession — US hours check (America/New_York)', () => {
  // NOTE:these use the literal wall-clock insertion via Intl; we pick instants
  // whose America/New_York local time is deterministic.
  it('a Monday 12:00 ET is open', () => {
    // 2024-06-03T16:00:00Z == 12:00 EDT (Mon)
    const d = new Date(Date.UTC(2024, 5, 3, 16, 0, 0));
    expect(usMarketSession(d)).toBe('open');
  });

  it('a Sunday is closed', () => {
    // 2024-06-02T16:00:00Z == Sunday 12:00 EDT
    const d = new Date(Date.UTC(2024, 5, 2, 16, 0, 0));
    expect(usMarketSession(d)).toBe('closed');
  });

  it('before 09:30 ET is closed', () => {
    // 2024-06-03T13:00:00Z == 09:00 EDT (Mon) — before open
    const d = new Date(Date.UTC(2024, 5, 3, 13, 0, 0));
    expect(usMarketSession(d)).toBe('closed');
  });

  it('after 16:00 ET is closed', () => {
    // 2024-06-03T21:00:00Z == 17:00 EDT (Mon) — after close
    const d = new Date(Date.UTC(2024, 5, 3, 21, 0, 0));
    expect(usMarketSession(d)).toBe('closed');
  });

  it('Saturday is closed', () => {
    const d = new Date(Date.UTC(2024, 5, 8, 16, 0, 0)); // Sat 12:00 EDT
    expect(usMarketSession(d)).toBe('closed');
  });
});