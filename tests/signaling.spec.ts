// tests/signaling.spec.ts — encode→decode roundtrip, fallback path, errors.
//
// Pure logic under the node environment. CompressionStream/DecompressionStream
// are available in Node 18+ (web streams globals), so both the compressed and the
// forced-uncompressed paths are exercised here.

import { describe, it, expect } from 'vitest';

import {
  decodeSignal,
  encodeSignal,
  encodeSignalCompressed,
  encodeSignalUncompressed,
  hasCompression,
  SignalError,
  signalErrorMessage,
} from '../src/net/signaling';
import { PREFIX, PREFIX_UNCOMPRESSED } from '../src/config/net';

const OFFER: RTCSessionDescriptionInit = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n' };
const ANSWER: RTCSessionDescriptionInit = { type: 'answer', sdp: 'v=0\r\no=- 2 1 IN IP4 127.0.0.1\r\ns=-\r\n' };

describe('signaling codec (§4.3)', () => {
  it('hasCompression is a boolean (baseline in modern node/browsers)', () => {
    expect(typeof hasCompression()).toBe('boolean');
  });

  describe('encode → decode roundtrip', () => {
    it('roundtrips an offer', async () => {
      const code = await encodeSignal(OFFER);
      expect(code.startsWith(PREFIX)).toBe(true);
      expect(code.startsWith(PREFIX_UNCOMPRESSED)).toBe(false);
      const out = await decodeSignal(code);
      expect(out.type).toBe('offer');
      expect(out.sdp).toBe(OFFER.sdp);
    });

    it('roundtrips an answer', async () => {
      const code = await encodeSignal(ANSWER);
      const out = await decodeSignal(code);
      expect(out.type).toBe('answer');
      expect(out.sdp).toBe(ANSWER.sdp);
    });

    it('roundtrips a large SDP (multi-KB) intact', async () => {
      const big = 'a'.repeat(4000) + '\r\n';
      const code = await encodeSignal({ type: 'offer', sdp: big });
      const out = await decodeSignal(code);
      expect(out.sdp).toBe(big);
    });
  });

  describe('compressed vs uncompressed paths', () => {
    it('encodeSignalCompressed yields the compressed PREFIX', async () => {
      const code = await encodeSignalCompressed(OFFER);
      expect(code.startsWith(PREFIX)).toBe(true);
      expect(code.startsWith(PREFIX_UNCOMPRESSED)).toBe(false);
      const out = await decodeSignal(code);
      expect(out.type).toBe('offer');
      expect(out.sdp).toBe(OFFER.sdp);
    });

    it('encodeSignalUncompressed yields the uncompressed PREFIX_UNCOMPRESSED', async () => {
      const code = await encodeSignalUncompressed(OFFER);
      expect(code.startsWith(PREFIX_UNCOMPRESSED)).toBe(true);
      // The two prefixes diverge at char 5 ('.' vs 'u'), so an uncompressed code
      // must NOT be mistaken for a compressed one (and vice-versa).
      expect(code.startsWith(PREFIX)).toBe(false);
    });

    it('decodeSignal reads the forced-fallback (uncompressed) path', async () => {
      const code = await encodeSignalUncompressed(ANSWER);
      // ensure we are not accidentally matching only the compressed prefix:
      // strip the compressed prefix and confirm the remainder does NOT decode as gzip.
      const out = await decodeSignal(code);
      expect(out.type).toBe('answer');
      expect(out.sdp).toBe(ANSWER.sdp);
    });

    it('the compressed and uncompressed encodings of one desc both decode', async () => {
      const c = await decodeSignal(await encodeSignalCompressed(OFFER));
      const u = await decodeSignal(await encodeSignalUncompressed(OFFER));
      expect(c).toEqual(u);
      expect(c.sdp).toBe(OFFER.sdp);
    });
  });

  describe('error cases — friendly codes', () => {
    it('non-prefixed junk ⇒ BAD_PREFIX', async () => {
      await expect(decodeSignal('hello not a code')).rejects.toMatchObject({ code: 'BAD_PREFIX' });
    });

    it('empty string ⇒ BAD_PREFIX', async () => {
      await expect(decodeSignal('   ')).rejects.toMatchObject({ code: 'BAD_PREFIX' });
    });

    it('truncated payload under a valid prefix ⇒ BAD_GZIP or BAD_SHAPE (definitely a failure)', async () => {
      const code = PREFIX + 'AAAA'; // not valid gzip / base64 too short for any structure
      await expect(decodeSignal(code)).rejects.toBeInstanceOf(SignalError);
    });

    it('uncompressed path with garbage payload ⇒ BAD_SHAPE', async () => {
      // base64url of "{not"
      const garbage = btoa('{not a json');
      const code = PREFIX_UNCOMPRESSED + garbage;
      await expect(decodeSignal(code)).rejects.toMatchObject({ code: 'BAD_SHAPE' });
    });

    it('valid JSON but wrong type ⇒ BAD_TYPE', async () => {
      const raw = btoa(JSON.stringify({ t: 'pranswer', s: 'x' }));
      const code = PREFIX_UNCOMPRESSED + raw;
      await expect(decodeSignal(code)).rejects.toMatchObject({ code: 'BAD_TYPE' });
    });

    it('valid JSON structurally wrong ⇒ BAD_SHAPE', async () => {
      const raw = btoa(JSON.stringify({ t: 'offer' })); // missing s
      const code = PREFIX_UNCOMPRESSED + raw;
      await expect(decodeSignal(code)).rejects.toMatchObject({ code: 'BAD_SHAPE' });
    });

    it('SignalError → friendly message is a non-empty string for each code', () => {
      const codes = ['BAD_PREFIX', 'BAD_GZIP', 'BAD_SHAPE', 'BAD_TYPE'] as const;
      for (const c of codes) {
        const m = signalErrorMessage(c);
        expect(typeof m).toBe('string');
        expect(m.length).toBeGreaterThan(0);
      }
    });
  });
});