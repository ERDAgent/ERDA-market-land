// src/utils/fnv1a.ts — FNV-1a 32-bit hash, hex output (§4.4 manifestHash).
//
// ~10 lines, no async, no deps. Used to hash the frozen manifest JSON so a guest
// can cheaply detect a manifest mismatch with the host and request `manifestFull`.

/** FNV-1a 32-bit of `input`, returned as 8-hex-digit lowercase string. */
export function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}