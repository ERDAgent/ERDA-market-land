// src/net/rtc.ts — RTCPeerConnection plumbing shared by host + guest (§4.2).
//
// Non-trickle ICE MANDATORY: after `setLocalDescription` we wait for
// `iceGatheringState === 'complete'` (or a timeout fallback) before
// serializing `localDescription`. The guest is the offerer and MUST create both
// data channels BEFORE `createOffer` (§4.2). The host receives them via
// `pc.ondatachannel`, distinguished by `channel.label`.
//
// Pure WebRTC plumbing only: no engine import, no Pinia, no DOM beyond RTC types.

import { CH_POS, CH_REL, ICE_SERVERS } from '../config/net';
import type { Env, MsgType, MsgPayload } from './protocol';

/** Build a wire `Env` (`v` pinned to 1, `ts` = now). */
export function makeEnv<T extends MsgType>(
  t: T,
  from: string,
  d: MsgPayload[T],
  ts: number = Date.now(),
): Env<T> {
  return { v: 1, t, from, ts, d };
}

export type Role = 'solo' | 'host' | 'guest';

/** Build the `RTCConfiguration` per §4.2 (LAN-only ⇒ no ICE servers). */
export function makeRtcConfig(lanOnly: boolean): RTCConfiguration {
  return lanOnly
    ? { iceServers: [] }
    : { iceServers: ICE_SERVERS };
}

/** Create a configured `RTCPeerConnection`. */
export function createPeerConnection(lanOnly: boolean): RTCPeerConnection {
  return new RTCPeerConnection(makeRtcConfig(lanOnly));
}

/** Ordered reliable channel name (`CH_REL`) check. */
export function isRel(channel: RTCDataChannel): boolean {
  return channel.label === CH_REL;
}
/** Unordered unreliable channel name (`CH_POS`) check. */
export function isPos(channel: RTCDataChannel): boolean {
  return channel.label === CH_POS;
}

/**
 * Wait for non-trickle ICE gathering to complete, with a timeout fallback:
 * resolve when `iceGatheringState === 'complete'`, OR after `timeoutMs`,
 * exporting whatever was gathered so far (§4.2 / §15).
 */
export function waitForIceGathering(
  pc: RTCPeerConnection,
  // TURN allocation is a relay round-trip on top of host/srflx gathering, so
  // non-trickle gathering with a TURN server configured takes longer than
  // STUN-only gathering did; 4000ms cut it off before TURN candidates arrived.
  timeoutMs = 7000,
): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', onState);
      clearTimeout(handle);
      resolve();
    };
    const onState = (): void => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.addEventListener('icegatheringstatechange', onState);
    const handle = setTimeout(finish, timeoutMs);
  });
}

/** Local description as a plain init for the signaling codec. */
export function localDescriptionInit(pc: RTCPeerConnection): RTCSessionDescriptionInit | null {
  const ld = pc.localDescription;
  return ld ? { type: ld.type, sdp: ld.sdp } : null;
}

/**
 * Guest/offerer: create BOTH data channels BEFORE `createOffer` (§4.2). The
 * reliable channel is ordered; the position channel is unordered + unreliable
 * (`maxRetransmits: 0`), matching the frozen `CH_REL`/`CH_POS` names.
 */
export function createOffererChannels(pc: RTCPeerConnection): {
  rel: RTCDataChannel;
  pos: RTCDataChannel;
} {
  const rel = pc.createDataChannel(CH_REL, { ordered: true });
  const pos = pc.createDataChannel(CH_POS, { ordered: false, maxRetransmits: 0 });
  return { rel, pos };
}

/** Serialize an Env to a wire string for `RTCDataChannel.send` (both sides). */
export function encodeWire(env: unknown): string {
  return JSON.stringify(env);
}

/** Convenience: is a data channel open and sendable? */
export function channelOpen(ch: RTCDataChannel | undefined | null): ch is RTCDataChannel {
  return !!ch && ch.readyState === 'open';
}