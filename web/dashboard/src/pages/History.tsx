import { useState, useEffect, useRef } from 'preact/hooks';
import { getConversation, getConversations, sendMessageToAgent } from '../api/client.js';
import type { ConversationMessage, ConversationSummary } from '../types.js';
import { LuMessageSquare, LuRefreshCw } from 'react-icons/lu';
import { MarkdownView } from '../components/MarkdownView.js';

const AGENT_MESSAGES_STORAGE_KEY = 'dashboard_agent_messages_v1';

type AgentChatMessage = ConversationMessage & {
  conversationId: string;
  channel: 'dashboard' | 'telegram' | 'discord';
  chatId: string;
};

function isAgentChatMessage(value: unknown): value is AgentChatMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (v.role === 'user' || v.role === 'assistant') &&
    typeof v.content === 'string' &&
    typeof v.ts === 'string' &&
    v.conversationId === 'dashboard-agent' &&
    (v.channel === 'dashboard' || v.channel === 'telegram' || v.channel === 'discord') &&
    typeof v.chatId === 'string'
  );
}

function loadPersistedAgentMessages(): AgentChatMessage[] {
  try {
    const raw = localStorage.getItem(AGENT_MESSAGES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAgentChatMessage).slice(-300);
  } catch {
    return [];
  }
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function History() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [remoteMessages, setRemoteMessages] = useState<Array<ConversationMessage & { conversationId: string; channel: 'telegram' | 'discord'; chatId: string }>>([]);
  const [agentMessages, setAgentMessages] = useState<AgentChatMessage[]>(() => loadPersistedAgentMessages());
  const [channel, setChannel] = useState<'all' | 'telegram' | 'discord'>('all');
  const [historyPages, setHistoryPages] = useState(1);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const restoringOlderRef = useRef(false);
  const prevScrollHeightRef = useRef(0);
  const prevScrollTopRef = useRef(0);
  const messages = (channel === 'all'
    ? [...remoteMessages, ...agentMessages]
    : remoteMessages
  ).sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const scrollToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    setHistoryPages(1);
    setHasMoreOlder(false);
    setLoadingOlder(false);
    autoScrollRef.current = true;
  }, [channel]);

  useEffect(() => {
    void load();
  }, [channel, historyPages]);

  useEffect(() => {
    const id = setInterval(() => {
      void load();
    }, 5000);
    return () => clearInterval(id);
  }, [channel, historyPages]);

  useEffect(() => {
    try {
      localStorage.setItem(
        AGENT_MESSAGES_STORAGE_KEY,
        JSON.stringify(agentMessages.slice(-300)),
      );
    } catch {
      // Ignore storage write failures.
    }
  }, [agentMessages]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (restoringOlderRef.current) {
      const newHeight = el.scrollHeight;
      el.scrollTop = Math.max(0, newHeight - prevScrollHeightRef.current + prevScrollTopRef.current);
      restoringOlderRef.current = false;
      setLoadingOlder(false);
      return;
    }
    if (autoScrollRef.current) {
      requestAnimationFrame(scrollToBottom);
      const t = setTimeout(scrollToBottom, 80);
      return () => clearTimeout(t);
    }
  }, [messages.length, loading]);

  async function load() {
    setLoading(true);
    try {
      const data = await getConversations(channel === 'all' ? undefined : channel);
      const list = data.conversations ?? [];
      setConversations(list);
      if (list.length === 0) {
        setRemoteMessages([]);
        return;
      }

      // Load recent conversations and merge into one stream; channel filter already narrows scope.
      const recentConversations = list.slice(0, 12);
      const perConversationLimit = Math.max(20, historyPages * 30);
      const batches = await Promise.all(
        recentConversations.map(async (c) => {
          const detail = await getConversation(c.id, { limit: perConversationLimit });
          return {
            hasMore: Boolean(detail.hasMore),
            messages: (detail.messages ?? []).map((m) => ({
              ...m,
              conversationId: c.id,
              channel: c.channel,
              chatId: c.chatId,
            })),
          };
        }),
      );

      const hasOlder = batches.some((b) => b.hasMore);
      setHasMoreOlder(hasOlder);
      const mergedRemote = batches
        .flatMap((b) => b.messages)
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
      setRemoteMessages(mergedRemote);
    } catch (e) {
      console.error('[messages] load failed', e);
    } finally {
      setLoading(false);
    }
  }

  function onScrollMessages(e: Event) {
    const el = e.currentTarget as HTMLDivElement;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    autoScrollRef.current = distanceFromBottom < 24;

    if (el.scrollTop <= 40 && hasMoreOlder && !loadingOlder && !loading) {
      restoringOlderRef.current = true;
      prevScrollHeightRef.current = el.scrollHeight;
      prevScrollTopRef.current = el.scrollTop;
      setLoadingOlder(true);
      setHistoryPages((p) => p + 1);
    }
  }

  async function send() {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    autoScrollRef.current = true;
    try {
      setAgentMessages((prev) => [
        ...prev,
        {
          role: 'user',
          content: message,
          ts: new Date().toISOString(),
          conversationId: 'dashboard-agent',
          channel: 'dashboard',
          chatId: 'active',
        },
      ]);
      const result = await sendMessageToAgent(message);
      setAgentMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: result.response,
          ts: result.timestamp || new Date().toISOString(),
          conversationId: 'dashboard-agent',
          channel: 'dashboard',
          chatId: 'agent',
        },
      ]);
      setDraft('');
    } catch (e) {
      console.error('[messages] send failed', e);
    } finally {
      setSending(false);
    }
  }

  function channelLabel(trigger: string): string {
    if (trigger === 'dashboard') return 'Dashboard';
    return trigger === 'discord' ? 'Discord' : 'Telegram';
  }

  return (
    <div class="messages-page">
      <div class="page-header">
        <div class="page-title">Messages</div>
        <div class="header-actions">
          <select
            class="btn btn-sm"
            value={channel}
            onChange={(e) => setChannel((e.target as HTMLSelectElement).value as 'all' | 'telegram' | 'discord')}
          >
            <option value="all">All channels</option>
            <option value="telegram">Telegram</option>
            <option value="discord">Discord</option>
          </select>
          <button class="btn-refresh" onClick={() => void load()}>
            <LuRefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading && conversations.length === 0 ? (
        <div class="messages-filler">
          <div class="spinner" />
        </div>
      ) : conversations.length === 0 ? (
        <div class="card messages-chat-card">
          <div class="empty-state">
            <div class="empty-state-icon"><LuMessageSquare size={18} /></div>
            <div class="empty-state-text">No messages yet</div>
          </div>
        </div>
      ) : (
        <div class="card messages-chat-card">
          {messages.length === 0 ? (
            <div class="empty-state">
              <div class="empty-state-text">No conversation messages</div>
            </div>
          ) : (
            <div ref={listRef} class="chat-list messages-chat-list" onScroll={onScrollMessages}>
              {loadingOlder && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0' }}>
                  <div class="spinner" style={{ width: 14, height: 14 }} />
                </div>
              )}
              {messages.map((m, idx) => (
                <div key={`${m.ts}-${idx}`} class={`chat-row ${m.role === 'user' ? 'user' : 'assistant'}`}>
                  <div class="chat-meta">
                    {m.role === 'user' ? 'You' : 'SkimpyClaw'} · {channelLabel(m.channel)} · {formatTimeAgo(m.ts)}
                  </div>
                  <div class={`chat-bubble ${m.role === 'user' ? 'user' : 'assistant'}`}>
                    <MarkdownView content={m.content} />
                  </div>
                </div>
              ))}
            </div>
          )}
          <div class="messages-composer-inline">
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={draft}
                onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="Send a message to the agent"
                style={{ flex: 1, padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface-alt)', color: 'var(--text)' }}
              />
              <button class="btn btn-sm btn-primary" onClick={send} disabled={sending || !draft.trim()}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
