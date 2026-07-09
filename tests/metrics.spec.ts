// tests/metrics.spec.ts — hand-computed §7.3 height formulas + day-change color.
//
// Pure numeric checks (no THREE) against the §7.3 table, including the
// acceptance cases called out in the order (+3% → green at t=1.0; +5% height
// pins; ±9% clamp is the simulated-provider's job, see simulated.spec).

import { describe, it, expect } from 'vitest';
import {
  heightForMetric,
  dayChangeColor,
  H_MIN,
  H_MAX,
  COLOR_RED,
  COLOR_NEUTRAL,
  COLOR_GREEN,
} from '../src/config/metrics';

const approx = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

describe('§7.3 height metrics', () => {
  describe('mode 1 · day change % (default)', () => {
    it('0% → h = 4 (the +4 base)', () => {
      expect(heightForMetric(1, 0, undefined, 100)).toBeCloseTo(4, 6);
    });
    it('+3% → h = 4 + 46·0.6 = 31.6 (hand)', () => {
      expect(heightForMetric(1, 3, undefined, 100)).toBeCloseTo(31.6, 6);
    });
    it('+5% → h = 50 (pin: |change|/5 clamps at 1)', () => {
      expect(heightForMetric(1, 5, undefined, 100)).toBeCloseTo(50, 6);
    });
    it('+10% → pinned at 50 (no overshoot)', () => {
      expect(heightForMetric(1, 10, undefined, 100)).toBeCloseTo(50, 6);
      expect(heightForMetric(1, -10, undefined, 100)).toBeCloseTo(50, 6);
    });
    it('magnitude only — +3% and -3% give the SAME height', () => {
      expect(heightForMetric(1, 3, undefined, 100)).toBeCloseTo(
        heightForMetric(1, -3, undefined, 100),
        6,
      );
    });
  });

  describe('mode 2 · market cap', () => {
    it('no mcap → H_MIN (2)', () => {
      expect(heightForMetric(2, 1, undefined, 100)).toBe(H_MIN);
      expect(heightForMetric(2, 1, NaN, 100)).toBe(H_MIN);
    });
    it('log10(mcap)=8.5 → maps to 3 (range low)', () => {
      const mcap = 10 ** 8.5;
      expect(heightForMetric(2, 0, mcap, 100)).toBeCloseTo(3, 6);
    });
    it('log10(mcap)=13.3 → maps to 60 (range high)', () => {
      const mcap = 10 ** 13.3;
      expect(heightForMetric(2, 0, mcap, 100)).toBeCloseTo(60, 6);
    });
    it('300B (3e11) → mid-range hand value', () => {
      const mcap = 3e11;
      const logv = Math.log10(mcap);
      const t = (logv - 8.5) / (13.3 - 8.5);
      const expect_h = 3 + (60 - 3) * t;
      expect(heightForMetric(2, 0, mcap, 100)).toBeCloseTo(expect_h, 5);
    });
    it('> 13.3 clamps at 60', () => {
      expect(heightForMetric(2, 0, 1e14, 100)).toBeLessThanOrEqual(H_MAX);
      expect(heightForMetric(2, 0, 1e14, 100)).toBeCloseTo(60, 6);
    });
    it('< 8.5 clamps at 3', () => {
      expect(heightForMetric(2, 0, 1e6, 100)).toBeCloseTo(3, 6);
    });
  });

  describe('mode 3 · price', () => {
    it('price=0.01 (10^-2) → 2 (range low)', () => {
      expect(heightForMetric(3, 0, undefined, 0.01)).toBeCloseTo(2, 6);
    });
    it('price≈10^5.1 → 58 (range high)', () => {
      expect(heightForMetric(3, 0, undefined, 10 ** 5.1)).toBeCloseTo(58, 6);
    });
    it('price=1 → mid hand value (log10=0)', () => {
      const t = (0 - -2) / (5.1 - -2);
      const expect_h = 2 + (58 - 2) * t;
      expect(heightForMetric(3, 0, undefined, 1)).toBeCloseTo(expect_h, 5);
    });
    it('> 10^5.1 clamps at 58', () => {
      expect(heightForMetric(3, 0, undefined, 1e7)).toBeLessThanOrEqual(H_MAX);
      expect(heightForMetric(3, 0, undefined, 1e7)).toBeCloseTo(58, 6);
    });
  });

  it('every mode returns a value within [H_MIN, H_MAX]', () => {
    for (const cp of [-50, -9, -3, -1, 0, 1, 3, 9, 50]) {
      for (const m of [1, 2, 3] as const) {
        const h = heightForMetric(m, cp, 1e11, 530);
        expect(h).toBeGreaterThanOrEqual(H_MIN);
        expect(h).toBeLessThanOrEqual(H_MAX);
      }
    }
  });
});

describe('§7.3 day-change color', () => {
  const norm = (rgb: readonly number[]): [number, number, number] => [
    rgb[0] / 255,
    rgb[1] / 255,
    rgb[2] / 255,
  ];

  // Dual-color CRT palette lock: color stops are exactly the triples below
  // (down bright red / neutral dim dark / up bright green) — regression guard
  // so a future accidental revert fails fast.
  it('color stops are exactly the dual-color CRT triples', () => {
    expect([...COLOR_RED]).toEqual([0xff, 0x45, 0x40]);
    expect([...COLOR_NEUTRAL]).toEqual([0x18, 0x22, 0x18]);
    expect([...COLOR_GREEN]).toEqual([0x4d, 0xff, 0x66]);
  });

  it('+3% → exactly green (acceptance: t=1.0)', () => {
    expect(dayChangeColor(3)).toEqual(norm(COLOR_GREEN));
  });
  it('-3% → exactly red (t=-1.0)', () => {
    expect(dayChangeColor(-3)).toEqual(norm(COLOR_RED));
  });
  it('0% → exactly neutral', () => {
    expect(dayChangeColor(0)).toEqual(norm(COLOR_NEUTRAL));
  });
  it('|changePct|<0.05 → neutral even for tiny inputs', () => {
    expect(dayChangeColor(0.04)).toEqual(norm(COLOR_NEUTRAL));
    expect(dayChangeColor(-0.049)).toEqual(norm(COLOR_NEUTRAL));
  });
  it('0.05% is NOT neutral (boundary)', () => {
    // |0.05| < 0.05 is false, so it leaves neutral territory.
    const c = dayChangeColor(0.05);
    expect(c).not.toEqual(norm(COLOR_NEUTRAL));
  });
  it('+1.5% → halfway neutral→green (t=0.5)', () => {
    const [r, g, b] = dayChangeColor(1.5);
    const half = norm([
      COLOR_NEUTRAL[0] + (COLOR_GREEN[0] - COLOR_NEUTRAL[0]) * 0.5,
      COLOR_NEUTRAL[1] + (COLOR_GREEN[1] - COLOR_NEUTRAL[1]) * 0.5,
      COLOR_NEUTRAL[2] + (COLOR_GREEN[2] - COLOR_NEUTRAL[2]) * 0.5,
    ]);
    expect(approx(r, half[0], 1e-5)).toBe(true);
    expect(approx(g, half[1], 1e-5)).toBe(true);
    expect(approx(b, half[2], 1e-5)).toBe(true);
  });
  it('-1.5% → halfway red→neutral (s=0.5)', () => {
    const [r, g, b] = dayChangeColor(-1.5);
    const half = norm([
      COLOR_RED[0] + (COLOR_NEUTRAL[0] - COLOR_RED[0]) * 0.5,
      COLOR_RED[1] + (COLOR_NEUTRAL[1] - COLOR_RED[1]) * 0.5,
      COLOR_RED[2] + (COLOR_NEUTRAL[2] - COLOR_RED[2]) * 0.5,
    ]);
    expect(approx(r, half[0], 1e-5)).toBe(true);
    expect(approx(g, half[1], 1e-5)).toBe(true);
    expect(approx(b, half[2], 1e-5)).toBe(true);
  });
  it('+9% and -9% clamp to ±1 (saturate → green / red)', () => {
    expect(dayChangeColor(9)).toEqual(norm(COLOR_GREEN));
    expect(dayChangeColor(-9)).toEqual(norm(COLOR_RED));
    expect(dayChangeColor(900)).toEqual(norm(COLOR_GREEN));
  });
});