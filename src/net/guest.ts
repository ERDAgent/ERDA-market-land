// src/net/guest.ts — guest session: offerer side of the manual handshake,
// welcome hydration, chat/pos receive, and the host-disconnect → [Continue
// solo] banner.
//
// Local pos broadcast is driven by M4's avatars bridge, which owns the 12 Hz
// move-gate and calls the shared `sendLocalPos(p,q)` hook (defined in
// net/host.ts, role-routed). The guest-side dispatch this module exports is
// `_dispatchGuestPos(env)` — it pushes a built `pos` env onto this guest's own
// `CH_POS` so the host receives + relays to the other guests. There is no
// guest-side setInterval reading engine.camera anymore (that gate is M4's).
//
// Guest is the offerer; it creates BOTH data channels before `createOffer`
// (§4.2). `hello.ver = PROTOCOL_VERSION`; a host mismatch is signalled back as
// `error {code:'VERSION'}` and the guest shows a friendly message. On `welcome`
// it hydrates roster + chat tail + hostName. Received `pos` Envs emit
// `engine.events` `'remotePos'` (M4 hook).
import { instruments } from '../data/manifest/validate';
import { fnv1aHex } from '../utils/fnv1a';
import {
  CHAT_TAIL, PING_MS, PROTOCOL_VERSION,
} from '../config/net';
import type { Env, MsgPayload, PeerInfo } from './protocol';
import {
  channelOpen, createOffererChannels, createPeerConnection,
  encodeWire, localDescriptionInit, makeEnv, waitForIceGathering,
} from './rtc';
import { decodeSignal, encodeSignal, SignalError } from './signaling';
import { clampChatText, isChatPayload, isPosPayload, isSysPayload, parseEnv } from './validate';
import { emitRemotePos, hostInit } from './host';
import { useConnectionStore } from '../stores/connection';
import { useChatStore } from '../stores/chat';
import { useSettingsStore } from '../stores/settings';
import { colorFromId } from '../stores/players';

let pc: RTCPeerConnection | null = null;
let rel: RTCDataChannel | null = null;
let pos: RTCDataChannel | null = null;
let selfId = '';
let pingTimer: number | undefined;
let posTimer: number | undefined; // unused now (M4 drives cadence); kept for teardown idiom

function parseJson(data: unknown): unknown {
  if (typeof data !== 'string') return null;
  try { return JSON.parse(data); } catch { return null; }
}

function setStatus(s: 'connecting' | 'connected' | 'disconnected' | 'failed'): void {
  useConnectionStore().setStatus(s);
}

/** Begin the Join flow: create pc + channels (before offer), build the offer code. */
export async function guestBeginJoin(): Promise<string> {
  const settings = useSettingsStore();
  const conn = useConnectionStore();
  conn.clearError();
  teardown();
  conn.setRole('guest');
  pc = createPeerConnection(settings.lanOnly);
  const ch = createOffererChannels(pc);
  rel = ch.rel;
  pos = ch.pos;
  wireChannels();
  pc.onconnectionstatechange = () => {
    const st = pc?.connectionState;
    if (st === 'connected') setStatus('connected');
    else if (st === 'disconnected') setStatus('disconnected');
    else if (st === 'failed') {
      setStatus('failed');
      onHostGone();
    }
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc);
  const ld = localDescriptionInit(pc);
  if (!ld) throw new SignalError('BAD_SHAPE', 'No local description');
  const code = await encodeSignal(ld);
  conn.setOfferCode(code);
  conn.setReplyCode(null);
  conn.setPhase('copy-offer');
  return code;
}

function wireChannels(): void {
  if (!rel || !pos) return;
  rel.onopen = () => {
    // send hello with display name + protocol version
    const name = useSettingsStore().displayName.trim() || 'Peer';
    sendRel(makeEnv('hello', '', { name, ver: PROTOCOL_VERSION }));
    setStatus('connected');
  };
  rel.onmessage = (e: MessageEvent) => handleRel(parseJson(e.data));
  rel.onclose = () => onHostGone();
  rel.onerror = () => { /* surfaced via connectionstate */ };
  pos.onmessage = (e: MessageEvent) => {
    const env = parseEnv(parseJson(e.data));
    if (env && env.t === 'pos' && isPosPayload(env.d)) {
      handlePos(env);
    }
  };
}

function sendRel(env: Env): void {
  if (channelOpen(rel)) { try { rel!.send(encodeWire(env)); } catch { /* */ } }
}

function handleRel(raw: unknown): void {
  const env = parseEnv(raw);
  if (!env) return;
  const conn = useConnectionStore();
  switch (env.t) {
    case 'welcome': {
      const d = env.d as MsgPayload['welcome'];
      selfId = d.selfId;
      conn.setSelfId(selfId);
      conn.setHostName(d.hostName);
      conn.setRole('guest');
      // roster (add self metadata)
      const roster = (d.roster ?? []).map((p: PeerInfo) => ({
        ...p, color: p.color || colorFromId(p.id),
      }));
      conn.setRoster(roster);
      // hydrate chat tail (last CHAT_TAIL) — set guest's chat store baseline
      const chat = useChatStore();
      chat.clear();
      for (const m of (d.chatTail ?? []).slice(-CHAT_TAIL)) chat.addChat(m.from, m.name, m.text, m.ts);
      // manifest hash mismatch warning (frozen manifest ⇒ match in practice)
      const local = fnv1aHex(JSON.stringify(instruments));
      if (local !== d.manifestHash) {
        // Not fatal; M5/M1 owns manifest updates. Surface a console note.
        console.warn(`[net] manifest hash mismatch: host=${d.manifestHash} local=${local}`);
      }
      conn.setPhase('connected');
      conn.setStatus('connected');
      // Local pos broadcast is now driven by M4's avatars bridge via
      // `sendLocalPos(p,q)` (host.ts); no guest-side camera-reading timer.
      startPing();
      break;
    }
    case 'roster': {
      const d = env.d as MsgPayload['roster'];
      conn.setRoster(d.roster ?? []);
      break;
    }
    case 'chat': {
      if (!isChatPayload(env.d)) return;
      const d = env.d as MsgPayload['chat'];
      const roster = conn.roster;
      const peer = roster.find((p) => p.id === env.from);
      const name = peer?.name ?? 'Peer';
      useChatStore().addChat(env.from, name, clampChatText(d.text), env.ts);
      break;
    }
    case 'sys': {
      if (!isSysPayload(env.d)) return;
      const d = env.d as MsgPayload['sys'];
      useChatStore().addSys(d.kind, d.text, env.ts);
      break;
    }
    case 'manifestFull': {
      // M1/M5 consume the full roster downstream; M3 only notes its arrival.
      break;
    }
    case 'quotesDelta':
    case 'quotesFull': {
      // M5 owns quotes; M3 ignores here (no market store import).
      break;
    }
    case 'ping': {
      const d = env.d as MsgPayload['ping'];
      sendRel(makeEnv('pong', selfId, { n: d.n }));
      break;
    }
    case 'pong': {
      // guest-initiated ping → pong measures rtt (used for host rtt and ours)
      const d = env.d as MsgPayload['pong'];
      const rtt = Math.max(0, Date.now() - d.n);
      conn.setPing(rtt);
      break;
    }
    case 'bye': {
      onHostGone();
      break;
    }
    case 'error': {
      const d = env.d as MsgPayload['error'];
      if (d.code === 'VERSION') conn.setError("Host is running a different version.");
      else if (d.code === 'ROOM_FULL') conn.setError("The room is full. Try again later.");
      else conn.setError(d.msg || 'Host reported an error.');
      teardown();
      break;
    }
    default:
      break; // unknown t ⇒ ignore
  }
}

function handlePos(env: Env): void {
  const d = env.d as MsgPayload['pos'];
  emitRemotePos(env.from, d.p, d.q);
}

/** Push an already-built `pos` env onto this guest's own `CH_POS` so the host
 *  receives + relays it to the other guests. Called by the role-routed
 *  `sendLocalPos(p,q)` (host.ts) on the guest path. M4 owns the move-gate; this
 *  sends every call it receives (no second gate, no camera read). */
export function _dispatchGuestPos(env: Env<'pos'>): void {
  if (channelOpen(pos)) { try { pos!.send(encodeWire(env)); } catch { /* unreliable */ } }
}

/** Test-only seam: install a fake `pos` channel into the guest module state. */
export function _testInstallGuestPos(ch: RTCDataChannel | null): void { pos = ch; }

function stopPosStream(): void {
  if (posTimer !== undefined) { window.clearInterval(posTimer); posTimer = undefined; }
}

function startPing(): void {
  stopPing();
  pingTimer = window.setInterval(() => {
    if (!channelOpen(rel)) return;
    const n = Date.now();
    sendRel(makeEnv('ping', selfId, { n }));
  }, PING_MS);
}

function stopPing(): void {
  if (pingTimer !== undefined) { window.clearInterval(pingTimer); pingTimer = undefined; }
}

/** Host disappeared (rel closed / bye / failed) ⇒ show the [Continue solo] banner. */
function onHostGone(): void {
  stopPosStream();
  stopPing();
  const conn = useConnectionStore();
  conn.setStatus('disconnected');
  conn.setBanner('host-left');
}

/** Guest posts a chat line to the host (host will stamp + echo to all). */
export function guestSendChat(text: string): void {
  const t = clampChatText(text);
  if (!t.trim()) return;
  if (!channelOpen(rel)) return; // host will echo; nothing to send yet
  sendRel(makeEnv('chat', selfId, { text: t }));
}

/** Apply the host's reply code (Join flow step 2): set the remote answer. */
export async function guestApplyReply(code: string): Promise<void> {
  if (!pc) throw new SignalError('BAD_SHAPE', 'No pending offer');
  const conn = useConnectionStore();
  conn.clearError();
  const answer = await decodeSignal(code);
  await pc.setRemoteDescription(answer);
  conn.setPhase('awaiting-reply');
  conn.setStatus('connecting');
}

/** Guest-driven leave: send bye, close, reset to solo. */
export function guestLeave(): void {
  if (channelOpen(rel)) { try { sendRel(makeEnv('bye', selfId, {})); } catch { /* */ } }
  teardown();
  useConnectionStore().reset();
  useChatStore().clear();
}

/** Continue solo after the host left: become host of a fresh room (§4.1). */
export function guestContinueSolo(): void {
  teardown();
  const conn = useConnectionStore();
  conn.setBanner(null);
  conn.setRole('solo');
  conn.setSelfId('H');
  conn.setRoster([{ id: 'H', name: useSettingsStore().displayName || 'Host', color: colorFromId('H'), isHost: true }]);
  conn.setStatus('idle');
  conn.setPhase('idle');
  // become host authority: initialize host session in place
  hostInit(useSettingsStore().displayName || 'Host');
}

/** Back to the menu from any guest/host state. */
export function guestBackToMenu(): void {
  teardown();
  useConnectionStore().reset();
  useChatStore().clear();
}

function teardown(): void {
  stopPosStream();
  stopPing();
  if (rel) { try { rel.close(); } catch { /* */ } rel = null; }
  if (pos) { try { pos.close(); } catch { /* */ } pos = null; }
  if (pc) { try { pc.close(); } catch { /* */ } pc = null; }
  selfId = '';
}