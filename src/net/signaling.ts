// src/net/signaling.ts — manual copy-paste signaling codec (§4.3).
//
// Codes are (gzip-compressed, base64url-encoded) RTCSessionDescription payloads
// with a version prefix. `CompressionStream` is baseline in modern browsers but
// feature-detected anyway; when absent we fall back to an uncompressed
// base64url payload under `PREFIX_UNCOMPRESSED`. `decodeSignal` auto-detects
// the prefix and validates prefix / gzip integrity / JSON shape / `type`.

import { PREFIX, PREFIX_UNCOMPRESSED } from '../config/net';
import { base64url, base64urlDecode } from '../utils/base64url';

export type SignalErrorCode = 'BAD_PREFIX' | 'BAD_GZIP' | 'BAD_SHAPE' | 'BAD_TYPE';

/** A signaling decode/validation failure carrying a stable machine code. */
export class SignalError extends Error {
  readonly code: SignalErrorCode;
  constructor(code: SignalErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SignalError';
    this.code = code;
  }
}

/** Human-friendly one-liner per code — surfaced verbatim by the SignalingModal. */
export function signalErrorMessage(code: SignalErrorCode): string {
  switch (code) {
    case 'BAD_PREFIX': return "That doesn't look like a signaling code.";
    case 'BAD_GZIP':   return 'The code is corrupted or was truncated in transit.';
    case 'BAD_SHAPE':  return 'The code is malformed (bad structure).';
    case 'BAD_TYPE':   return 'That code is the wrong signaling step.';
    default:           return 'Could not read the signaling code.';
  }
}

/** True when the (de)compression streams the codec wants are available. */
export function hasCompression(): boolean {
  return (
    typeof CompressionStream !== 'undefined' &&
    typeof DecompressionStream !== 'undefined'
  );
}

async function gzip(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(gz: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([gz as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function wrap(desc: RTCSessionDescriptionInit): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ t: desc.type, s: desc.sdp }));
}

/** Compressed signaling code: `PREFIX` + base64url(gzip({t,s})). */
export async function encodeSignalCompressed(desc: RTCSessionDescriptionInit): Promise<string> {
  return PREFIX + base64url(await gzip(wrap(desc)));
}

/** Uncompressed fallback code: `PREFIX_UNCOMPRESSED` + base64url({t,s}). */
export async function encodeSignalUncompressed(desc: RTCSessionDescriptionInit): Promise<string> {
  return PREFIX_UNCOMPRESSED + base64url(wrap(desc));
}

/**
 * Encode a description to a signaling code. Picks the compressed path when
 * `CompressionStream` is available, otherwise the uncompressed fallback so the
 * flow still works in an older/polyfill-less context.
 */
export async function encodeSignal(desc: RTCSessionDescriptionInit): Promise<string> {
  return hasCompression() ? encodeSignalCompressed(desc) : encodeSignalUncompressed(desc);
}

/**
 * Decode a signaling code back into an `RTCSessionDescriptionInit`. Validates
 * prefix, gzip integrity, JSON shape, and `type ∈ {offer,answer}` — every
 * failure throws a `SignalError` with a stable code for friendly UI mapping.
 */
export async function decodeSignal(code: string): Promise<RTCSessionDescriptionInit> {
  const c = code.trim();
  let bytes: Uint8Array;
  let raw: string;

  if (c.startsWith(PREFIX)) {
    if (!hasCompression()) throw new SignalError('BAD_GZIP', 'Decompression unavailable');
    try {
      bytes = base64urlDecode(c.slice(PREFIX.length));
      raw = new TextDecoder().decode(await gunzip(bytes));
    } catch {
      throw new SignalError('BAD_GZIP');
    }
  } else if (c.startsWith(PREFIX_UNCOMPRESSED)) {
    try {
      bytes = base64urlDecode(c.slice(PREFIX_UNCOMPRESSED.length));
      raw = new TextDecoder().decode(bytes);
    } catch {
      throw new SignalError('BAD_GZIP');
    }
  } else {
    throw new SignalError('BAD_PREFIX');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SignalError('BAD_SHAPE');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) throw new SignalError('BAD_SHAPE');
  const obj = parsed as Record<string, unknown>;
  const t = obj.t;
  const s = obj.s;
  if (typeof t !== 'string' || typeof s !== 'string') {
    throw new SignalError('BAD_SHAPE');
  }
  if (t !== 'offer' && t !== 'answer') throw new SignalError('BAD_TYPE');
  return { type: t as RTCSessionDescriptionInit['type'], sdp: s };
}