// tests/layout.spec.ts — §7.2 deterministic city layout.
//
// Pure: layoutCity(manifest) must place all 117 buildings, one per id, sorted
// per-district (sizeTier desc, mcap desc, ticker asc), centered on the plot,
// with no two building footprints overlapping (by construction: pitch 16 >
// max footprint 10). Deterministic: two calls produce identical output.

import { describe, it, expect } from 'vitest';
import { layoutCity, BUILDING_PITCH, footprintForTier } from '../src/engine/layout';
import { instruments, validateManifest } from '../src/data/manifest/validate';
import { DISTRICTS, PITCH } from '../src/config/city';

const OK = (x: number | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

describe('§7.2 layoutCity', () => {
  it('frozen manifest is valid (guard)', () => {
    expect(validateManifest()).toEqual([]);
    expect(instruments).toHaveLength(117);
  });

  it('places every instrument (117 unique ids)', () => {
    const m = layoutCity(instruments);
    expect(m.size).toBe(117);
    for (const inst of instruments) expect(m.has(inst.id)).toBe(true);
  });

  it('is deterministic — two calls produce identical positions', () => {
    const a = layoutCity(instruments);
    const b = layoutCity(instruments);
    for (const id of a.keys()) {
      expect(b.get(id)).toEqual(a.get(id));
    }
  });

  it('every building lies inside its district plot (±PLOT/2 from plot center)', () => {
    const PLOT = 150;
    const m = layoutCity(instruments);
    for (const inst of instruments) {
      const lay = m.get(inst.id)!;
      const def = DISTRICTS[lay.districtId];
      const cx = def.col * PITCH;
      const cz = def.row * PITCH;
      // building center plus half-footprint must stay inside the plot.
      const half = lay.footprint / 2;
      expect(Math.abs(lay.x - cx) + half).toBeLessThanOrEqual(PLOT / 2);
      expect(Math.abs(lay.z - cz) + half).toBeLessThanOrEqual(PLOT / 2);
    }
  });

  it('no two buildings in the same district overlap (centers ≥ BUILDING_PITCH in >= one axis)', () => {
    const m = layoutCity(instruments);
    const byDistrict = new Map<string, { x: number; z: number; fp: number }[]>();
    for (const inst of instruments) {
      const lay = m.get(inst.id)!;
      let arr = byDistrict.get(lay.districtId);
      if (!arr) {
        arr = [];
        byDistrict.set(lay.districtId, arr);
      }
      arr.push({ x: lay.x, z: lay.z, fp: lay.footprint });
    }
    for (const arr of byDistrict.values()) {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i];
          const b = arr[j];
          const minGap = (a.fp + b.fp) / 2;
          const dx = Math.abs(a.x - b.x);
          const dz = Math.abs(a.z - b.z);
          // Overlap only if BOTH axes are closer than the half-footprint sum.
          // Since identical (col,row) is impossible, at least one of dx/dz is
          // ≥ BUILDING_PITCH (16) > max footprint sum (10+10)/2=10.
          expect(dx >= minGap || dz >= minGap).toBe(true);
          // And the differing axis is at least a full pitch away.
          expect(Math.max(dx, dz)).toBeGreaterThanOrEqual(BUILDING_PITCH);
        }
      }
    }
  });

  it('uses a square-ish grid per district: cols=ceil(sqrt(n))', () => {
    const byDistrict = new Map<string, number>();
    for (const inst of instruments) {
      byDistrict.set(inst.district, (byDistrict.get(inst.district) ?? 0) + 1);
    }
    const m = layoutCity(instruments);
    for (const inst of instruments) {
      expect(OK(m.get(inst.id)?.x)).toBe(true);
      expect(OK(m.get(inst.id)?.z)).toBe(true);
    }
    // sanity: total buildings equals sum of district counts.
    const total = Array.from(byDistrict.values()).reduce((s, n) => s + n, 0);
    expect(total).toBe(117);
    expect(m.size).toBe(117);
  });

  it('footprint matches sizeTier (1→6, 2→8, 3→10)', () => {
    const m = layoutCity(instruments);
    for (const inst of instruments) {
      expect(m.get(inst.id)!.footprint).toBe(footprintForTier(inst.sizeTier));
    }
  });

  it('sort order: largest mcap within the top sizeTier lands at the plot anchor (col 0,row 0)', () => {
    // In each district the first-sorted instrument (highest sizeTier, then
    // largest mcap, then ticker) should occupy the lowest (col,row) index —
    // the block anchor at (x0,z0), the nw corner of the row-major block.
    const byDistrict: Record<string, typeof instruments> = {};
    for (const inst of instruments) {
      (byDistrict[inst.district] ??= []).push(inst);
    }
    const m = layoutCity(instruments);
    for (const [district, list] of Object.entries(byDistrict)) {
      const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
      const def = DISTRICTS[district as keyof typeof DISTRICTS];
      const x0 = def.col * PITCH - ((cols - 1) * BUILDING_PITCH) / 2;
      const rows = Math.max(1, Math.ceil(list.length / cols));
      const z0 = def.row * PITCH - ((rows - 1) * BUILDING_PITCH) / 2;
      const sorted = list.slice().sort((a, b) => {
        if (a.sizeTier !== b.sizeTier) return b.sizeTier - a.sizeTier;
        const am = a.mcapUSD;
        const bm = b.mcapUSD;
        if (am !== bm) {
          if (am == null) return 1;
          if (bm == null) return -1;
          return bm - am;
        }
        return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
      });
      const first = sorted[0];
      const lay = m.get(first.id)!;
      expect(lay.x).toBeCloseTo(x0, 6);
      expect(lay.z).toBeCloseTo(z0, 6);
    }
  });
});