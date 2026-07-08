// src/utils/mapClamp.ts — linear remap with clamping (§7.3 helper).
//
// `mapClamp(v, [a,b], [c,d])` maps `v` from the source range `[a,b]` to the
// target range `[c,d]`, clamping `v` to `[a,b]` first. Used by the height
// formulas (mode 2/3) so out-of-range inputs pin at the range ends.

/** Clamp `v` to `[lo, hi]`. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Linear remap of `v` from source range `[a,b]` to target range `[c,d]`,
 * clamping `v` to `[a,b]` before mapping (so the result always lies in `[c,d]`,
 * assuming `c<=d`).
 */
export function mapClamp(v: number, a: number, b: number, c: number, d: number): number {
  const t = clamp((v - a) / (b - a), 0, 1);
  return c + (d - c) * t;
}