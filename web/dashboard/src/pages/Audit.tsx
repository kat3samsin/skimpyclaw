import { useState, useEffect } from 'preact/hooks';
import { getAudit } from '../api/client.js';
import type { AuditTrace } from '../types.js';
import { LuClock3, LuRefreshCw, LuSearch, LuSend, LuServer } from 'react-icons/lu';

// Re-export History with "Audit" name — same data, different page label
export function Audit() {
  const [traces, setTraces] = useState<AuditTrace[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [trigger, setTrigger] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const limit = 20;

  useEffect(() => { load(0); }, [trigger]);

  async function load(off: number) {
    setLoading(true);
    try {
      const data = await getAudit({ limit, offset: off, trigger: trigger || undefined });
      if (off === 0) setTraces(data.traces ?? []);
      else setTraces(prev => [...prev, ...(data.traces ?? [])]);
      setTotal(data.total ?? 0);
      setOffset(off);
    } catch (e) {
      console.error('[audit] load failed', e);
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: string) {
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  function statusColor(status: AuditTrace['status']) {
    if (status === 'success') return 'var(--success)';
    if (status === 'error') return 'var(--error)';
    return 'var(--warning)';
  }

  function triggerIcon(trigger: string) {
    if (trigger === 'telegram') return <LuSend size={14} />;
    if (trigger === 'cron') return <LuClock3 size={14} />;
    return <LuServer size={14} />;
  }

  return (
    <div>
      <div class="page-header">
        <div class="page-title">Audit Log</div>
        <div class="header-actions">
          <select
            class="btn btn-sm"
            value={trigger}
            onChange={(e) => setTrigger((e.target as HTMLSelectElement).value)}
          >
            <option value="">All triggers</option>
            <option value="telegram">Telegram</option>
            <option value="discord">Discord</option>
            <option value="cron">Cron</option>
            <option value="gateway">Gateway</option>
          </select>
          <button class="btn-refresh" onClick={() => load(0)}>
            <LuRefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading && traces.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
          <div class="spinner" />
        </div>
      ) : (
        <>
          <div class="feed-card">
            {traces.length === 0 ? (
              <div class="empty-state">
                <div class="empty-state-icon"><LuSearch size={18} /></div>
                <div class="empty-state-text">No audit traces</div>
              </div>
            ) : (
              <div class="feed">
                {traces.map(t => (
                  <div key={t.traceId} style={{ borderBottom: '1px solid var(--border-light)' }}>
                    <div class="feed-item" style={{ cursor: 'pointer' }} onClick={() => toggle(t.traceId)}>
                      <div class={`feed-icon ${t.trigger === 'telegram' ? 'telegram' : t.trigger === 'cron' ? 'cron' : 'system'}`}>
                        {triggerIcon(t.trigger)}
                      </div>
                      <div>
                        <div class="feed-title">
                          <span style={{
                            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                            background: statusColor(t.status), marginRight: 8,
                          }} />
                          {t.trigger}
                          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
                            {t.traceId.slice(0, 8)}
                          </span>
                        </div>
                        <div class="feed-detail">{t.events.length} events · {t.status}</div>
                      </div>
                      <div class="feed-time">
                        {new Date(t.startedAt).toLocaleTimeString()}
                      </div>
                    </div>
                    {expanded.has(t.traceId) && (
                      <div style={{ padding: '0 20px 16px', background: 'var(--surface-alt)' }}>
                        {t.events.map((ev, i) => (
                          <div key={i} style={{
                            display: 'flex', gap: 12, padding: '8px 0', fontSize: 13,
                            borderBottom: i < t.events.length - 1 ? '1px solid var(--border-light)' : 'none',
                          }}>
                            <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', minWidth: 80 }}>{ev.type}</span>
                            <span>{ev.summary}</span>
                            {ev.durationMs !== undefined && (
                              <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
                                {ev.durationMs}ms
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          {traces.length < total && (
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button class="btn btn-sm" onClick={() => load(offset + limit)} disabled={loading}>
                {loading ? 'Loading…' : `Load more (${traces.length}/${total})`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
