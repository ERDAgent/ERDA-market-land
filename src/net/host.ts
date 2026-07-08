// src/net/host.ts — host/solo session: signaling answerer, roster authority,
// chat relay, pos relay + remotePos hook, ping/pong, back pressure helpers.
//
// "Solo" is a host with zero guests (differs only in Invite UI per §4.1). This
// module owns the host's RTCPeerConnections, the authoritative roster, and the
// two explicit cross-phase hooks M5 consumes:
//   - `broadcastRel(env)`           — fan-out an Env to every guest `rel`
//   - `bufferedAmountLow(ch, th)`   — await backpressure drain
// On receiving a `pos` Env it emits `engine.events` `'remotePos'` (M4 hook) and
// relays to the other guests' `pos` channels. Imports `engine` from M0's
// engine/core READ-ONLY (never edits it).
import { engine } from '../engine/core';
import { instruments } from '../data/manifest/validate';
import { fnv1aHex } from '../utils/fnv1a';
import {
  BUFFER_HIGH, BUFFER_LOW_THRESHOLD, CHAT_TAIL, MAX_GUESTS,
  PING_MS, PING_MISSES_DROP, PROTOCOL_VERSION,
} from '../config/net';
import type { Env, MsgPayload, MsgType, PeerInfo, Quote } from './protocol';
import {
  channelOpen, createPeerConnection, encodeWire, isPos, isRel,
  localDescriptionInit, makeEnv, waitForIceGathering,
} from './rtc';
import { decodeSignal, encodeSignal, SignalError } from './signaling';
import {
  ChatRateLimiter, PosRateLimiter, clampChatText, dedupeName,
  isChatPayload, isKnownMsgType, isPosPayload, parseEnv, sanitizeName,
} from './validate';
import { useConnectionStore } from '../stores/connection';
import { useChatStore, type SysMsg } from '../stores/chat';
import { useSettingsStore } from '../stores/settings';
import { colorFromId } from '../stores/players';

interface GuestConn {
  id: string;
  pc: RTCPeerConnection;
  rel: RTCDataChannel;
  pos: RTCDataChannel;
  name: string;
  color: string;
  lastPong: number;
  pingSendAt: number;
  missed: number;
  rtt: number | undefined;
  chat: ChatRateLimiter;
  posLimiter: PosRateLimiter;
}

/** Local manifest hash (FNV-1a hex of the frozen M0C manifest JSON). */
export const manifestHash: string = fnv1aHex(JSON.stringify(instruments));

let guests = new Map<string, GuestConn>();
let pendingJoin: { pc: RTCPeerConnection; rel?: RTCDataChannel; pos?: RTCDataChannel } | null = null;
let hostName = '';
let selfName = '';
let pingTimer: number | undefined;
let posTimer: number | undefined;

// ---- the M4 cross-phase hook ------------------------------------------------

/** Emit a received `pos` Env on `engine.events` as `'remotePos'` {from,p,q}. */
export function emitRemotePos(from: string, p: [number, number, number], q: [number, number, number, number]): void {
  // Frozen `EngineEvents['remotePos']` is `{id,pos}`; we emit {id,pos,from,p,q}
  // (cast — the frozen type is a placeholder; M4 reads {from,p,q} per the M3
  // brief). Never edits emitter.ts.
  engine.events.emit('remotePos', { id: from, pos: p, from, p, q } as unknown as { id: string; pos: ArrayLike<number> });
}

// ---- the M5 cross-phase hooks -----------------------------------------------

/** Wait until a channel's buffered amount drains at/under `threshold`. */
export function bufferedAmountLow(channel: RTCDataChannel, threshold: number = BUFFER_LOW_THRESHOLD): Promise<void> {
  if (channel.bufferedAmount <= threshold) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onLow = (): void => {
      if (channel.bufferedAmount <= threshold) {
        channel.removeEventListener('bufferedamountlow', onLow);
        resolve();
      }
    };
    try { channel.bufferedAmountLowThreshold = threshold; } catch { /* ignore */ }
    channel.addEventListener('bufferedamountlow', onLow);
  });
}

/** Fan-out `env` to every open guest `rel` channel (buffer-aware). M5 calls this. */
export async function broadcastRel(env: Env): Promise<void> {
  const payload = encodeWire(env);
  for (const g of guests.values()) {
    if (!channelOpen(g.rel)) continue;
    if (g.rel.bufferedAmount >= BUFFER_HIGH) {
      await bufferedAmountLow(g.rel, BUFFER_LOW_THRESHOLD);
    }
    if (channelOpen(g.rel)) {
      try { g.rel.send(payload); } catch { /* drop */ }
    }
  }
}

// ---- small send helpers -----------------------------------------------------

function sendRel(g: GuestConn, env: Env): void {
  if (channelOpen(g.rel)) {
    if (g.rel.bufferedAmount >= BUFFER_HIGH) {
      void bufferedAmountLow(g.rel, BUFFER_LOW_THRESHOLD).then(() => {
        if (channelOpen(g.rel)) { try { g.rel.send(encodeWire(env)); } catch { /* drop */ } }
      });
    } else {
      try { g.rel.send(encodeWire(env)); } catch { /* drop */ }
    }
  }
}

function sendPos(g: GuestConn, env: Env): void {
  if (channelOpen(g.pos)) {
    try { g.pos.send(encodeWire(env)); } catch { /* unreliable — drop */ }
  }
}

function rosterSnapshot(): PeerInfo[] {
  const list: PeerInfo[] = [
    { id: 'H', name: hostName || selfName || 'Host', color: colorFromId('H'), isHost: true, rttMs: undefined },
  ];
  for (const g of guests.values()) {
    list.push({ id: g.id, name: g.name, color: g.color, isHost: false, rttMs: g.rtt });
  }
  return list;
}

function broadcastRoster(exclude?: string): void {
  const roster = rosterSnapshot();
  void broadcastRel(makeEnv('roster', 'H', { roster }));
  useConnectionStore().setRoster(roster);
  void exclude; // roster sent to all
}

function broadcastSys(kind: SysMsg['kind'], text: string): void {
  void broadcastRel(makeEnv('sys', 'H', { kind, text }));
  useChatStore().addSys(kind, text);
}

function takenNames(): Set<string> {
  const s = new Set<string>();
  for (const g of guests.values()) s.add(g.name);
  return s;
}

function genGuestId(): string {
  let n = 0;
  let id = '';
  do {
    n = Math.floor(Math.random() * Math.pow(36, 4));
    id = n.toString(36).padStart(4, '0');
  } while (guests.has(id) || id === 'H');
  return id;
}

// ---- hydration helpers ------------------------------------------------------

function quotesSnapshot(): Quote[] {
  const m = (engine.api as { market?: { snapshot?: () => Quote[] } }).market;
  return typeof m?.snapshot === 'function' ? (m.snapshot() ?? []) : [];
}

// ---- guest message dispatch ------------------------------------------------

function handleRelMessage(g: GuestConn, raw: unknown): void {
  const env = parseEnv(raw);
  if (!env) return; // unknown t / bad shape ⇒ ignore
  const now = Date.now();
  switch (env.t) {
    case 'hello': {
      const d = env.d as MsgPayload['hello'];
      // capacity gate: over MAX_GUESTS ⇒ room full (§4.1/§4.5)
      if (guests.size >= MAX_GUESTS) {
        sendRel(g, makeEnv('error', 'H', { code: 'ROOM_FULL', msg: 'The room is full.' }));
        setTimeout(() => closeGuest(g), 50);
        useConnectionStore().setError('A rejected join attempted past capacity.');
        return;
      }
      // version gate
      if (d.ver !== PROTOCOL_VERSION) {
        sendRel(g, makeEnv('error', 'H', { code: 'VERSION', msg: 'Host is running a different version.' }));
        setTimeout(() => closeGuest(g), 50);
        useConnectionStore().setError("Guest is running a different version.");
        return;
      }
      const cleaned = sanitizeName(d.name || '');
      const name = cleaned.length > 0 ? dedupeName(cleaned, takenNames()) : dedupeName('Peer', takenNames());
      g.name = name;
      g.color = colorFromId(g.id);
      guests.set(g.id, g);
      // welcome (buffer-aware)
      const welcome = makeEnv('welcome', 'H', {
        selfId: g.id,
        roster: rosterSnapshot(),
        quotes: quotesSnapshot(),
        manifestHash,
        chatTail: useChatStore().tail(CHAT_TAIL),
        hostName: hostName || selfName || 'Host',
      });
      sendRel(g, welcome);
      // manifest mismatch hook: proactively send manifestFull if guest might
      // differ — the frozen manifest makes this a no-op in practice.
      void sendManifestFull(g);
      broadcastRoster();
      broadcastSys('join', `${name} joined`);
      refreshStatus();
      break;
    }
    case 'chat': {
      if (!isChatPayload(env.d)) return;
      const text = clampChatText((env.d as MsgPayload['chat']).text);
      if (!g.chat.allow(g.id, now)) {
        sendRel(g, makeEnv('sys', 'H', { kind: 'info', text: 'Slow down — chat rate limited.' }));
        return;
      }
      const msg = useChatStore().addChat(g.id, g.name, text, now);
      // host stamps from/name via the store; echo to sender + relay to all guests
      const relay = makeEnv('chat', g.id, { text: msg.text });
      for (const og of guests.values()) sendRel(og, relay);
      break;
    }
    case 'pos': {
      if (!isPosPayload(env.d)) return;
      if (!g.posLimiter.allow(g.id, now)) return;
      const d = env.d as MsgPayload['pos'];
      emitRemotePos(g.id, d.p, d.q);
      // relay to other guests (host does NOT echo to sender)
      const relay = makeEnv('pos', g.id, { p: d.p, q: d.q });
      for (const og of guests.values()) {
        if (og.id !== g.id) sendPos(og, relay);
      }
      break;
    }
    case 'ping': {
      const d = env.d as MsgPayload['ping'];
      sendRel(g, makeEnv('pong', 'H', { n: d.n }));
      break;
    }
    case 'pong': {
      const d = env.d as MsgPayload['pong'];
      g.lastPong = now;
      g.missed = 0;
      g.rtt = now - g.pingSendAt;
      broadcastRoster();
      break;
    }
    case 'bye': {
      removeGuest(g, 'left');
      break;
    }
    default:
      // quotesDelta/quotesFull/welcome/etc. not expected from a guest ⇒ ignore
      break;
  }
}

/** Send the full manifest to a guest (used when a hash mismatch is suspected). */
export function sendManifestFull(g: GuestConn): Promise<void> {
  sendRel(g, makeEnv('manifestFull', 'H', { manifest: instruments.slice() }));
  return Promise.resolve();
}

function closeGuest(g: GuestConn): void {
  try { g.rel.close(); } catch { /* */ }
  try { g.pos.close(); } catch { /* */ }
  try { g.pc.close(); } catch { /* */ }
  guests.delete(g.id);
}

function removeGuest(g: GuestConn, reason: 'left' | 'dropped'): void {
  if (!guests.has(g.id)) return;
  const name = g.name;
  closeGuest(g);
  broadcastRoster();
  broadcastSys('leave', `${name} ${reason === 'dropped' ? 'dropped' : 'left'}`);
  refreshStatus();
}

function refreshStatus(): void {
  const conn = useConnectionStore();
  if (guests.size === 0) {
    if (conn.role === 'host') conn.setStatus('disconnected');
  } else {
    conn.setStatus('connected');
  }
}

function attachChannel(conn: GuestConn, channel: RTCDataChannel): void {
  if (isRel(channel)) {
    conn.rel = channel;
    channel.onmessage = (e: MessageEvent) => handleRelMessage(conn, parseJson(e.data));
    channel.onclose = () => removeGuest(conn, 'left');
    channel.onerror = () => { /* guest will drop via ping/close */ };
  } else if (isPos(channel)) {
    conn.pos = channel;
    channel.onmessage = (e: MessageEvent) => {
      const env = parseEnv(parseJson(e.data));
      if (env && env.t === 'pos') handleRelMessage(conn, env);
    };
  }
}

function parseJson(data: unknown): unknown {
  if (typeof data !== 'string') return null;
  try { return JSON.parse(data); } catch { return null; }
}

// ---- public session API -----------------------------------------------------

/** Initialize/refresh the host session with a display name. */
export function hostInit(name: string): void {
  selfName = name;
  hostName = name || 'Host';
  guests = new Map<string, GuestConn>();
  pendingJoin = null;
  const conn = useConnectionStore();
  conn.setRole('host');
  conn.setSelfId('H');
  conn.setRoster([
    { id: 'H', name: hostName, color: colorFromId('H'), isHost: true, rttMs: undefined },
  ]);
  conn.setStatus('idle');
  conn.setBanner(null);
  conn.clearError();
  startPings();
}

function startPings(): void {
  stopPings();
  pingTimer = window.setInterval(() => {
    const now = Date.now();
    for (const g of guests.values()) {
      if (now - g.lastPong > PING_MS * (PING_MISSES_DROP + 1)) {
        g.missed += 1;
        if (g.missed >= PING_MISSES_DROP) { removeGuest(g, 'dropped'); continue; }
      }
      g.pingSendAt = now;
      sendRel(g, makeEnv('ping', 'H', { n: now }));
    }
  }, PING_MS);
}

function stopPings(): void {
  if (pingTimer !== undefined) { window.clearInterval(pingTimer); pingTimer = undefined; }
  if (posTimer !== undefined) { window.clearInterval(posTimer); posTimer = undefined; }
}

/**
 * Host/Invite flow step 1: a guest's offer code is pasted in. Decode it,
 * create the answer, gather ICE non-trickle, and produce the reply code the
 * host copies back out of band. Returns the reply code, or throws a
 * `SignalError`-derived friendly message.
 */
export async function hostReceiveOfferCode(code: string): Promise<string> {
  const settings = useSettingsStore();
  const conn = useConnectionStore();
  conn.clearError();
  if (pendingJoin) {
    try { pendingJoin.pc.close(); } catch { /* */ }
    pendingJoin = null;
  }
  const offer = await decodeSignal(code);
  const pc = createPeerConnection(settings.lanOnly);
  const conn0: GuestConn = {
    id: 'pending', pc, rel: undefined as unknown as RTCDataChannel,
    pos: undefined as unknown as RTCDataChannel, name: '', color: '',
    lastPong: Date.now(), pingSendAt: 0, missed: 0, rtt: undefined,
    chat: new ChatRateLimiter(), posLimiter: new PosRateLimiter(),
  };
  pc.ondatachannel = (e: RTCDataChannelEvent) => {
    attachChannel(conn0, e.channel);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      if (conn0.id !== 'pending') removeGuest(conn0, 'dropped');
    }
  };
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGathering(pc);
  const ld = localDescriptionInit(pc);
  if (!ld) throw new SignalError('BAD_SHAPE', 'No local description');
  const reply = await encodeSignal(ld);
  pendingJoin = { pc, rel: conn0.rel, pos: conn0.pos };
  conn.setReplyCode(reply);
  conn.setPhase('copy-reply');
  // assign the provisional id now so ondatachannel/rel handlers can reference it
  const id = genGuestId();
  conn0.id = id;
  return reply;
}

/**
 * Promote the pending join (called once the `rel` channel opens after the
 * guest applies the reply). Wires the guest id; the `hello` message finalizes
 * roster + welcome.
 */
export function hostPromotePending(): void {
  if (!pendingJoin) return;
  pendingJoin = null;
}

/** Host-driven leave: tell guests, close everything, reset. */
export function hostLeave(): void {
  for (const g of guests.values()) {
    try { sendRel(g, makeEnv('bye', 'H', {})); } catch { /* */ }
  }
  stopPings();
  for (const g of guests.values()) closeGuest(g);
  guests = new Map();
  pendingJoin = null;
  const conn = useConnectionStore();
  conn.reset();
}

/** Host posts a chat line: stamp with 'H' + relay to all guests (§4.5 chat any→host→all). */
export function hostSendChat(text: string): void {
  const t = clampChatText(text);
  if (!t.trim()) return;
  const msg = useChatStore().addChat('H', hostName || selfName || 'Host', t, Date.now());
  void broadcastRel(makeEnv('chat', 'H', { text: msg.text }));
}

/** Stand down the host session (e.g. back to menu) without signaling guests. */
export function hostCleanup(): void {
  stopPings();
  for (const g of guests.values()) closeGuest(g);
  guests = new Map();
  pendingJoin = null;
}

// re-export for tests / M4 to confirm msgtype surface without extra import site
export type { MsgType };
export { isKnownMsgType };