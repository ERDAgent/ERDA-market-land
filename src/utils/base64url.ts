// src/utils/base64url.ts — base64url encode/decode for Uint8Array (§4.3).
//
// Pure, dependency-free. Works in modern browsers and Node 18+ (btoa/atob are
// global in both). Uses chunked binary-string conversion so arbitrary-length
// inputs (signaling SDPs, compressed payloads) never hit a call-stack limit.

/** Encode bytes → base64url (no padding; `+`→`-`, `/`→`_`). */
export function base64url(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a base64url string → bytes (tolerates missing padding). */
export function base64urlDecode(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}