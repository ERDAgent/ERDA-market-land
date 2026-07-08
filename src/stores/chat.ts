// src/stores/chat.ts — §11 chat store.
//
// Holds the in-memory scrollback (capped at 500) + a collapsed-unread counter.
// Received `chat` Envs and join/leave `sys` notices are appended here by net/.
// Rendered as TEXT NODES ONLY downstream (never v-html) — §4.5.
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { ChatMsg } from '../net/protocol';

/** A system line in the scrollback (italicized in the UI, never a chat msg). */
export interface SysMsg {
  id: string;
  kind: 'join' | 'leave' | 'info';
  text: string;
  ts: number;
}

export type ChatEntry = ChatMsg | SysMsg;

/** Predicate narrowing a ChatEntry to a user ChatMsg. */
export function isChatMsg(e: ChatEntry): e is ChatMsg {
  return (e as ChatMsg).from !== undefined;
}

const CAP = 500;
let seq = 0;
function nextId(): string {
  seq += 1;
  return `c${seq}`;
}

export const useChatStore = defineStore('chat', () => {
  const messages = ref<ChatEntry[]>([]);
  const unread = ref<number>(0);
  const collapsedUnread = ref<number>(0);

  const count = computed(() => messages.value.length);

  function push(entry: ChatEntry): void {
    const list = messages.value;
    list.push(entry);
    if (list.length > CAP) list.splice(0, list.length - CAP);
    messages.value = list.slice(); // reactivity trigger
  }

  function addChat(from: string, name: string, text: string, ts: number = Date.now()): ChatMsg {
    const msg: ChatMsg = { id: nextId(), from, name, text, ts };
    push(msg);
    return msg;
  }

  function addSys(kind: SysMsg['kind'], text: string, ts: number = Date.now()): SysMsg {
    const m: SysMsg = { id: nextId(), kind, text, ts };
    push(m);
    return m;
  }

  /** Last `n` chat msgs (for the welcome `chatTail`); returns ChatMsg[] only. */
  function tail(n: number): ChatMsg[] {
    const out: ChatMsg[] = [];
    for (let i = messages.value.length - 1; i >= 0 && out.length < n; i--) {
      const e = messages.value[i];
      if (isChatMsg(e)) out.unshift(e);
    }
    return out;
  }

  function bumpUnread(): void {
    unread.value += 1;
    collapsedUnread.value += 1;
  }

  function markRead(): void {
    unread.value = 0;
    collapsedUnread.value = 0;
  }

  function clear(): void {
    messages.value = [];
    unread.value = 0;
    collapsedUnread.value = 0;
  }

  return {
    messages,
    unread,
    collapsedUnread,
    count,
    push,
    addChat,
    addSys,
    tail,
    bumpUnread,
    markRead,
    clear,
  };
});