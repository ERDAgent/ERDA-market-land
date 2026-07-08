// src/data/manifest/validate.ts — frozen-manifest load-time checker.
//
// Asserts the §6.2 roster's invariants the moment the module is imported:
// unique `id`s, every `district` is a real frozen DistrictId, `sizeTier ∈
// {1,2,3}`, and provider routing is internally consistent (crypto ⇒
// 'coingecko'; everything else ⇒ 'finnhub'). Throws on the first violation —
// so a broken manifest fails the build/tests loudly, never silently.
//
// Pure: imports only frozen config/city (constants) + the data JSON. No THREE,
// no runtime state. The schema lives in `protocol.ts` (`Instrument`); this file
// is data-bearing contract data (roster edits require zero code changes here).

import instrumentsData from './instruments.json';
import { DISTRICTS, type DistrictId } from '../../config/city';
import type { Instrument } from '../../net/protocol';

/** The frozen default roster, typed by the schema in protocol.ts. */
export const instruments: Instrument[] = instrumentsData as Instrument[];

const VALID_SIZE_TIERS = new Set<number>([1, 2, 3]);
const VALID_DISTRICTS = new Set<DistrictId>(
  Object.keys(DISTRICTS) as DistrictId[],
);

/**
 * Validate a roster against the §6.2 invariants. Returns a list of human-
 * readable error strings (empty when valid). Pure & side-effect free so it
 * can be reused by tests/CI tooling.
 */
export function validateManifest(list: Instrument[] = instruments): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const inst of list) {
    // empty or duplicate id across the roster
    if (typeof inst.id !== 'string' || inst.id.length === 0) {
      errors.push(`missing id at index ${list.indexOf(inst)}`);
    } else if (seenIds.has(inst.id)) {
      errors.push(`duplicate id: ${inst.id}`);
    } else {
      seenIds.add(inst.id);
    }

    // district alignment: must be a real frozen DistrictId
    if (!VALID_DISTRICTS.has(inst.district)) {
      errors.push(`unknown district "${inst.district}" for ${inst.id}`);
    }

    // sizeTier ∈ {1,2,3}
    if (!VALID_SIZE_TIERS.has(inst.sizeTier)) {
      errors.push(`bad sizeTier ${String(inst.sizeTier)} for ${inst.id}`);
    }

    // provider routing: crypto ⇒ 'coingecko'; everything else ⇒ 'finnhub'
    const expectedProvider: Instrument['provider'] =
      inst.category === 'crypto' ? 'coingecko' : 'finnhub';
    if (inst.provider !== expectedProvider) {
      errors.push(
        `bad provider "${inst.provider}" for ${inst.id} (expected "${expectedProvider}")`,
      );
    }

    // providerSymbol must be non-empty (last mile of routing consistency)
    if (typeof inst.providerSymbol !== 'string' || inst.providerSymbol.length === 0) {
      errors.push(`missing providerSymbol for ${inst.id}`);
    }
  }

  return errors;
}

/**
 * Errors found when this module was first imported — captured BEFORE the
 * throw below so tests can introspect them. Empty means the load-time check
 * passed green.
 */
export const manifestErrors: string[] = validateManifest();

// Load-time check: a broken manifest must fail the moment anyone imports
// the roster (build, tests, or app startup). Silence is not an option.
if (manifestErrors.length > 0) {
  throw new Error(
    `src/data/manifest/instruments.json is invalid:\n  - ` +
      manifestErrors.join('\n  - '),
  );
}