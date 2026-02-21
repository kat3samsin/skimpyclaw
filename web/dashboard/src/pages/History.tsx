import { useState, useEffect, useRef } from 'preact/hooks';
import { getConversation, getConversations, sendMessageToAgent } from '../api/client.js';
import type { ConversationMessage, ConversationSummary } from '../types.js';
import { LuMessageSquare } from 'react-icons/lu';
import { MarkdownView } from '../components/MarkdownView.js';

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
  const [messages, setMessages] = useState<Array<ConversationMessage & { conversationId: string; channel: 'telegram' | 'discord'; chatId: string }>>([]);
  const [channel, setChannel] = useState<'all' | 'telegram' | 'discord'>('all');
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void load();
  }, [channel]);

  useEffect(() => {
    const id = setInterval(() => {
      void load();
    }, 5000);
    return () => clearInterval(id);
  }, [channel]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, loading]);

  async function load() {
    setLoading(true);
    try {
      const data = await getConversations(channel === 'all' ? undefined : channel);
      const list = data.conversations ?? [];
      setConversations(list);
      if (list.length === 0) {
        setMessages([]);
        return;
      }

      // Load recent conversations and merge into one stream; channel filter already narrows scope.
      const recentConversations = list.slice(0, 12);
      const batches = await Promise.all(
        recentConversations.map(async (c) => {
          const detail = await getConversation(c.id);
          return (detail.messages ?? []).map((m) => ({
            ...m,
            conversationId: c.id,
            channel: c.channel,
            chatId: c.chatId,
          }));
        }),
      );

      const merged = batches.flat().sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
      setMessages(merged);
    } catch (e) {
      console.error('[messages] load failed', e);
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    const message = draft.trim();
    if (!message || sending) return;
    const msgChannel: 'telegram' | 'discord' =
      channel === 'telegram'
        ? 'telegram'
        : channel === 'discord'
          ? 'discord'
          : (conversations[0]?.channel ?? 'discord');
    setSending(true);
    try {
      setMessages((prev) => [
        ...prev,
        {
          role: 'user',
          content: message,
          ts: new Date().toISOString(),
          conversationId: 'dashboard',
          channel: msgChannel,
          chatId: 'dashboard',
        },
      ]);
      const result = await sendMessageToAgent(message);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: result.response,
          ts: result.timestamp || new Date().toISOString(),
          conversationId: 'dashboard',
          channel: msgChannel,
          chatId: 'dashboard',
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
    return trigger === 'discord' ? 'Discord' : 'Telegram';
  }

  return (
    <div>
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
          <button class="btn btn-sm" onClick={() => void load()}>Refresh</button>
        </div>
      </div>

      {loading && conversations.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
          <div class="spinner" />
        </div>
      ) : conversations.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state-icon"><LuMessageSquare size={18} /></div>
          <div class="empty-state-text">No messages yet</div>
        </div>
      ) : (
        <div class="card" style={{ marginBottom: 0 }}>
          {messages.length === 0 ? (
            <div class="empty-state">
              <div class="empty-state-text">No conversation messages</div>
            </div>
          ) : (
            <div ref={listRef} class="chat-list" style={{ maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 }}>
              {messages.map((m, idx) => (
                <div key={`${m.ts}-${idx}`} class={`chat-row ${m.role === 'user' ? 'user' : 'assistant'}`}>
                  <div class="chat-meta">{channelLabel(m.channel)} · {m.chatId} · {formatTimeAgo(m.ts)}</div>
                  <div class={`chat-bubble ${m.role === 'user' ? 'user' : 'assistant'}`}>
                    <MarkdownView content={m.content} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div class="card" style={{ marginTop: 16, marginBottom: 0, position: 'sticky', bottom: 16, zIndex: 2 }}>
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
  );
}
