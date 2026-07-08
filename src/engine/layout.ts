// src/engine/layout.ts — pure §7 city-layout helper (no THREE import).
//
// `layoutCity(manifest)` returns a Map<instrumentId, {x,z,footprint,districtId}>
// deriving all building positions deterministically from manifest fields only
// (so geometry is identical + stable across peers; only heights/colors animate).
//
// Per §7.2:
//   1. Sort district instruments by sizeTier desc, mcapUSD desc (undef last),
//      ticker asc.
//   2. cols = ceil(sqrt(n)), row-major, pitch 16 u both axes.
//   3. Center: x0 = plotX − (cols−1)·16/2 (same for z with rows).
//   4. Footprint by sizeTier: 1 → 6 u, 2 → 8 u, 3 → 10 u (square).
//
// Plot centers come from frozen `config/city.ts` (`plotCenter(col,row)`).

import type { Instrument } from '../net/protocol';
import {
  DISTRICTS,
  PITCH as GRID_PITCH,
  type DistrictId,
} from '../config/city';

/** World pitch between buildings within a plot (§7.2). */
export const BUILDING_PITCH = 16;

/** Footprint (square side, world u) by frozen Instrument.sizeTier. */
export function footprintForTier(tier: 1 | 2 | 3): number {
  switch (tier) {
    case 3:
      return 10;
    case 2:
      return 8;
    default:
      return 6;
  }
}

export interface BuildingLayout {
  x: number;
  z: number;
  footprint: number;
  districtId: DistrictId;
}

/**
 * Deterministically lay out every instrument in `manifest` across its district
 * plot. Returns a Map keyed by `Instrument.id`. Pure + side-effect free.
 */
export function layoutCity(manifest: Instrument[]): Map<string, BuildingLayout> {
  const byDistrict = new Map<DistrictId, Instrument[]>();
  for (const inst of manifest) {
    const def = DISTRICTS[inst.district];
    if (!def) continue; // unknown district — skip (manifest validator would flag)
    let list = byDistrict.get(inst.district);
    if (!list) {
      list = [];
      byDistrict.set(inst.district, list);
    }
    list.push(inst);
  }

  const out = new Map<string, BuildingLayout>();

  for (const [districtId, list] of byDistrict) {
    // §7.2 step 1: sort by sizeTier desc, then mcapUSD desc (undef last), then ticker asc.
    const sorted = list.slice().sort((a, b) => {
      if (a.sizeTier !== b.sizeTier) return b.sizeTier - a.sizeTier;
      const am = a.mcapUSD;
      const bm = b.mcapUSD;
      if (am !== bm) {
        // undefined last; defined compared desc numerically.
        if (am == null) return 1;
        if (bm == null) return -1;
        return bm - am;
      }
      return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
    });

    // §7.2 step 2: cols = ceil(sqrt(n)), row-major. rows = ceil(n/cols).
    const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
    const rows = Math.max(1, Math.ceil(sorted.length / cols));

    const def = DISTRICTS[districtId];
    const [plotX, _py, plotZ] = [
      def.col * GRID_PITCH,
      0,
      def.row * GRID_PITCH,
    ];

    // §7.2 step 3: center the block on the plot.
    const x0 = plotX - ((cols - 1) * BUILDING_PITCH) / 2;
    const z0 = plotZ - ((rows - 1) * BUILDING_PITCH) / 2;

    sorted.forEach((inst, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = x0 + col * BUILDING_PITCH;
      const z = z0 + row * BUILDING_PITCH;
      out.set(inst.id, {
        x,
        z,
        footprint: footprintForTier(inst.sizeTier),
        districtId,
      });
    });
  }

  return out;
}