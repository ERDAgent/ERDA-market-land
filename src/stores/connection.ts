// src/stores/connection.ts — §11 connection store.
//
// UI-visible connection state + thin actions that delegate to net/host.ts and
// net/guest.ts. The heavy WebRTC/datalchannel logic lives there; this store is
// the reactive mirror the HUD components render.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { PeerInfo } from '../net/protocol';
import type { Role } from '../net/rtc';

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed';
export type SignalPhase =
  | 'idle'
  | 'copy-offer'   // guest: offer ready to copy
  | 'awaiting-reply' // guest: waiting for host reply paste
  | 'paste-join'   // host: waiting for a join code paste
  | 'copy-reply'   // host: reply ready to copy
  | 'connected'
  | 'error';

export const useConnectionStore = defineStore('connection', () => {
  const role = ref<Role>('solo');
  const selfId = ref<string>('H');
  const roster = ref<PeerInfo[]>([]);
  const status = ref<ConnStatus>('idle');
  const pendingInvite = ref<string | null>(null);

  // Signaling flow state (SignalingModal reads & writes these).
  const phase = ref<SignalPhase>('idle');
  const offerCode = ref<string | null>(null); // guest's generated offer (to copy)
  const replyCode = ref<string | null>(null); // host's generated reply (to copy)
  const netError = ref<string | null>(null); // friendly error text, null when clean

  const hostName = ref<string>('');
  const pingMs = ref<number | null>(null); // guest's rtt to host; host shows peer count
  const banner = ref<'host-left' | null>(null); // guest-only host-disconnect banner

  function reset(): void {
    role.value = 'solo';
    selfId.value = 'H';
    roster.value = [];
    status.value = 'idle';
    pendingInvite.value = null;
    phase.value = 'idle';
    offerCode.value = null;
    replyCode.value = null;
    netError.value = null;
    hostName.value = '';
    pingMs.value = null;
    banner.value = null;
  }

  function setRole(r: Role): void { role.value = r; }
  function setSelfId(id: string): void { selfId.value = id; }
  function setStatus(s: ConnStatus): void { status.value = s; }
  function setRoster(r: PeerInfo[]): void { roster.value = r; }
  function setHostName(n: string): void { hostName.value = n; }
  function setPing(ms: number | null): void { pingMs.value = ms; }
  function setBanner(b: 'host-left' | null): void { banner.value = b; }
  function setPhase(p: SignalPhase): void { phase.value = p; }
  function setOfferCode(c: string | null): void { offerCode.value = c; }
  function setReplyCode(c: string | null): void { replyCode.value = c; }
  function setError(msg: string | null): void {
    netError.value = msg;
    if (msg) phase.value = 'error';
  }
  function clearError(): void { netError.value = null; }

  return {
    role, selfId, roster, status, pendingInvite,
    phase, offerCode, replyCode, netError,
    hostName, pingMs, banner,
    reset, setRole, setSelfId, setStatus, setRoster, setHostName,
    setPing, setBanner, setPhase, setOfferCode, setReplyCode,
    setError, clearError,
  };
});