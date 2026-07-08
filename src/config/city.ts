// src/config/city.ts — frozen city/district constants (§7.1).
//
// Pure constants + a pure plot-math helper. NO Three.js import, NO runtime
// state, NO side effects — change-controlled contract data both parallel
// tracks build against.
//
// Plot = 150×150 u; streets = 30 u; grid pitch = 180 u.
// `plotCenter(col,row) = (col·180, 0, row·180)` with col,row ∈ {−1,0,1}.
//
//         col −1          col 0            col +1
// row −1  CRYPTO          TECH             FINANCE
// row  0  COMMODITIES     INDEXES          HEALTHCARE
// row +1  FX              CONSUMER         ENERGY & INDUSTRIALS

export const PLOT = 150;
export const STREET = 30;
export const PITCH = 180;

export type DistrictId =
  | 'indexes'
  | 'tech'
  | 'finance'
  | 'healthcare'
  | 'consumer'
  | 'energy_industrial'
  | 'crypto'
  | 'commodities'
  | 'fx';

/** Grid coordinate component: one of the three district columns/rows. */
export type GridCoord = -1 | 0 | 1;

export interface DistrictDef {
  /** Grid column: −1 (west), 0 (center), +1 (east). */
  col: GridCoord;
  /** Grid row: −1 (north), 0 (center), +1 (south). */
  row: GridCoord;
  /** Dark-tint ground-slab color for this district (hex). */
  color: string;
}

/**
 * Each DistrictId → its {col,row} grid cell + a per-district dark-tint
 * ground-slab palette color. The col/row pair is the frozen layout contract;
 * downstream code derives world coordinates via `plotCenter(col,row)`.
 */
export const DISTRICTS: Record<DistrictId, DistrictDef> = {
  crypto:            { col: -1, row: -1, color: '#16241c' },
  tech:              { col:  0, row: -1, color: '#16213a' },
  finance:           { col:  1, row: -1, color: '#162830' },
  commodities:       { col: -1, row:  0, color: '#2a2316' },
  indexes:           { col:  0, row:  0, color: '#23221f' },
  healthcare:        { col:  1, row:  0, color: '#211a30' },
  fx:                { col: -1, row:  1, color: '#162530' },
  consumer:          { col:  0, row:  1, color: '#241c30' },
  energy_industrial: { col:  1, row:  1, color: '#2e2316' },
};

/**
 * World-space center of the plot occupying grid cell (col,row).
 * `plotCenter(col,row) = (col·PITCH, 0, row·PITCH)`.
 */
export function plotCenter(
  col: GridCoord,
  row: GridCoord,
): [number, number, number] {
  return [col * PITCH, 0, row * PITCH];
}

/** Look up the DistrictId whose grid cell matches (col,row), or undefined. */
export function districtAt(
  col: GridCoord,
  row: GridCoord,
): DistrictId | undefined {
  for (const key of Object.keys(DISTRICTS) as DistrictId[]) {
    const d = DISTRICTS[key];
    if (d.col === col && d.row === row) return key;
  }
  return undefined;
}