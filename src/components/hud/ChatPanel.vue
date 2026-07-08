<script setup lang="ts">
/**
 * ChatPanel (§10) — right, collapsible. Scrollback (auto-stick to bottom unless
 * the user scrolled up), CHAT_MAX_CHARS-char input, system messages italicized,
 * unread badge when collapsed. Sends on Enter (and §9: keydown handlers no-op
 * while inputs focused — this input owns Enter; the world hotkeys no-op here).
 * Text nodes only — never v-html. Strings rendered as text.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { useChatStore, isChatMsg } from '../../stores/chat';
import { useConnectionStore } from '../../stores/connection';
import { CHAT_MAX_CHARS } from '../../config/net';
import { hostSendChat } from '../../net/host';
import { guestSendChat } from '../../net/guest';
import { colorFromId } from '../../stores/players';

const chat = useChatStore();
const conn = useConnectionStore();

function nameColor(id: string): string { return colorFromId(id); }

const collapsed = ref<boolean>(false);
const draft = ref<string>('');
const scrollRef = ref<HTMLDivElement | null>(null);
const stick = ref<boolean>(true);

const remaining = computed(() => CHAT_MAX_CHARS - draft.value.length);
const unreadBadge = computed(() => (collapsed.value ? chat.collapsedUnread : 0));

function onScroll(): void {
  const el = scrollRef.value;
  if (!el) return;
  stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  if (stick.value && !collapsed.value) chat.markRead();
}

watch(
  () => chat.messages.length,
  async () => {
    if (collapsed.value) { /* badge counts */ return; }
    if (stick.value) {
      await nextTick();
      const el = scrollRef.value;
      if (el) el.scrollTop = el.scrollHeight;
      chat.markRead();
    }
  },
);

watch(collapsed, (c) => {
  if (!c) { chat.markRead(); nextTick(() => { const el = scrollRef.value; if (el) el.scrollTop = el.scrollHeight; }); }
});

function toggle(): void {
  collapsed.value = !collapsed.value;
}

function send(): void {
  const text = draft.value.trim();
  if (!text) return;
  if (conn.role === 'guest') guestSendChat(text);
  else hostSendChat(text);
  draft.value = '';
  stick.value = true;
  nextTick(() => { const el = scrollRef.value; if (el) el.scrollTop = el.scrollHeight; });
}

function onInput(e: KeyboardEvent): void {
  // Enter sends; Shift+Enter newline. Other world hotkeys no-op while focused
  // (handled by useHotkeys' isInputFocused check).
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="chat" :class="{ collapsed }">
    <button class="header" @click="toggle">
      <span class="title">Chat</span>
      <span v-if="unreadBadge > 0" class="badge">{{ unreadBadge > 99 ? '99+' : unreadBadge }}</span>
      <span class="chev">{{ collapsed ? '◂' : '▸' }}</span>
    </button>

    <div v-if="!collapsed" class="body">
      <div ref="scrollRef" class="scroll" @scroll="onScroll">
        <p
          v-for="m in chat.messages"
          :key="m.id"
          class="msg"
          :class="{ sys: !isChatMsg(m) }"
        >
          <template v-if="isChatMsg(m)">
            <span class="who" :style="{ color: nameColor(m.from) }">{{ m.name }}:</span>
            <span class="text">{{ m.text }}</span>
          </template>
          <template v-else>
            <span class="sys-text">{{ m.text }}</span>
          </template>
        </p>
      </div>
      <div class="composer">
        <input
          v-model="draft"
          class="input"
          type="text"
          :maxlength="CHAT_MAX_CHARS"
          placeholder="Message… (Enter to send)"
          @keydown="onInput"
        />
        <button class="send" :disabled="!draft.trim()" @click="send">Send</button>
      </div>
      <div class="remaining">{{ remaining }}</div>
    </div>
  </div>
</template>

<style scoped>
.chat {
  position: absolute;
  top: 48px;
  right: 8px;
  width: 18rem;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: rgba(8, 12, 18, 0.72);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  pointer-events: auto;
  z-index: 30;
}
.chat.collapsed { width: auto; }
.header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: transparent;
  border: none;
  color: var(--text);
  padding: 0.45rem 0.6rem;
  font-size: 0.8rem;
}
.title { flex: 1 1 auto; text-align: left; }
.badge {
  background: var(--accent);
  color: #06121c;
  border-radius: 999px;
  padding: 0 0.4rem;
  font-size: 0.7rem;
  font-weight: 600;
}
.chev { color: var(--text-dim); }
.body { display: flex; flex-direction: column; max-height: 56vh; }
.scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 0 0.6rem 0.4rem;
  font-size: 0.82rem;
}
.msg { margin: 0.18rem 0; line-height: 1.35; }
.msg.sys { font-style: italic; color: var(--text-dim); }
.who { font-weight: 600; }
.text { color: var(--text); }
.composer {
  display: flex;
  gap: 0.35rem;
  padding: 0.4rem;
  border-top: 1px solid var(--panel-border);
}
.input {
  flex: 1 1 auto;
  background: #0a1119;
  color: var(--text);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 0.4rem 0.5rem;
  font-size: 0.84rem;
  outline: none;
}
.input:focus { border-color: var(--accent); }
.send {
  background: var(--accent);
  color: #06121c;
  border: none;
  border-radius: 6px;
  padding: 0.4rem 0.7rem;
  font-weight: 600;
}
.send:disabled { opacity: 0.5; }
.remaining { padding: 0 0.5rem 0.4rem; font-size: 0.68rem; color: var(--text-dim); text-align: right; }
</style>