// src/config/metrics.ts — height-formula + day-change color math (§7.3).
//
// Pure numeric functions (NO THREE import) so the unit tests can hand-check
// the §7.3 formulas. The buildings system converts the returned `[r,g,b]`
// floats (0..1) and `h` number into instance matrices/colors.
//
//   H_MIN = 2, H_MAX = 60 (guardrails — formulas may pin before these).
//   Mode 1 · Day change % (default): h = 4 + 46·clamp(|changePct|/5, 0, 1)
//   Mode 2 · Market cap: h = mapClamp(log10(mcap), [8.5,13.3], [3,60]); no mcap → H_MIN
//   Mode 3 · Price: h = mapClamp(log10(price), [-2,5.1], [2,58])
//
// Color is ALWAYS day-change, regardless of height mode. CRT green-phosphor:
// up = bright phosphor green, down = dim forest green, neutral = mid green —
// the up/down semantic is carried by GREEN BRIGHTNESS, not red↔green hue.
//   red #1a4a20 ← neutral #2e8a44 → green #6aff66, t = clamp(changePct/3, -1, 1);
//   |changePct| < 0.05 ⇒ exactly neutral.

import { clamp, mapClamp } from '../utils/mapClamp';

export type HeightMetric = 1 | 2 | 3;

export const H_MIN = 2;
export const H_MAX = 60;

/** Color-stop RGB triples (0..255) for the three-stop day-change lerp — phosphor green by brightness (down dim / neutral mid / up bright). */
export const COLOR_RED = [0x1a, 0x4a, 0x20] as const;
export const COLOR_NEUTRAL = [0x2e, 0x8a, 0x44] as const;
export const COLOR_GREEN = [0x6a, 0xff, 0x66] as const;

/** Small band around 0 % treated as exactly neutral (spec: |changePct|<0.05). */
export const NEUTRAL_BAND = 0.05;

/**
 * Compute the target building height for the given metric + quote/instrument.
 * Pure; no Three dependency. Returns a finite number in `[H_MIN, H_MAX]`.
 */
export function heightForMetric(
  metric: HeightMetric,
  changePct: number,
  mcapUSD: number | undefined,
  price: number,
): number {
  switch (metric) {
    case 1: {
      // ±5% pegs the scale; clamp magnitude so huge moves don't overshoot.
      const h = 4 + 46 * clamp(Math.abs(changePct) / 5, 0, 1);
      return clamp(h, H_MIN, H_MAX);
    }
    case 2: {
      if (mcapUSD == null || !Number.isFinite(mcapUSD) || mcapUSD <= 0) return H_MIN;
      const h = mapClamp(Math.log10(mcapUSD), 8.5, 13.3, 3, 60);
      return clamp(h, H_MIN, H_MAX);
    }
    case 3: {
      const p = price > 0 ? price : 1;
      const h = mapClamp(Math.log10(p), -2, 5.1, 2, 58);
      return clamp(h, H_MIN, H_MAX);
    }
    default:
      return H_MIN;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Day-change color as normalized `[r,g,b]` floats in [0,1] — the contract the
 * buildings system feeds to `InstancedMesh.setColorAt`. Pure; no THREE import.
 */
export function dayChangeColor(changePct: number): [number, number, number] {
  if (Math.abs(changePct) < NEUTRAL_BAND) {
    return [COLOR_NEUTRAL[0] / 255, COLOR_NEUTRAL[1] / 255, COLOR_NEUTRAL[2] / 255];
  }
  const t = clamp(changePct / 3, -1, 1);
  if (t >= 0) {
    const s = t; // 0..1 neutral→green (t=1 ⇒ green)
    return [
      lerp(COLOR_NEUTRAL[0], COLOR_GREEN[0], s) / 255,
      lerp(COLOR_NEUTRAL[1], COLOR_GREEN[1], s) / 255,
      lerp(COLOR_NEUTRAL[2], COLOR_GREEN[2], s) / 255,
    ];
  }
  // t in [-1,0): red→neutral, with s = t+1 so t=-1 ⇒ red, t=0 ⇒ neutral.
  const s = t + 1;
  return [
    lerp(COLOR_RED[0], COLOR_NEUTRAL[0], s) / 255,
    lerp(COLOR_RED[1], COLOR_NEUTRAL[1], s) / 255,
    lerp(COLOR_RED[2], COLOR_NEUTRAL[2], s) / 255,
  ];
}