import { useState, useEffect } from 'preact/hooks';
import { getAudit } from '../api/client.js';
import type { AuditTrace, AuditEvent } from '../types.js';
import { LuRefreshCw, LuSearch, LuChevronDown, LuChevronRight } from 'react-icons/lu';

/** Pretty-print a value as JSON. Accepts objects/arrays or JSON strings. Falls back to raw string. */
export function prettyJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

/** Parse a detail value: JSON strings → parsed object, objects pass through, plain strings stay as-is. */
export function parseDetail(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/** Format an event's middle content for display in the timeline row. */
export function formatEventContent(ev: AuditEvent): string {
  if (ev.type === 'tool_use' && ev.detail != null) {
    const parsed = parseDetail(ev.detail);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      // Extract tool name from common fields
      const toolName = (obj.tool as string) || (obj.name as string) || (obj.toolName as string) || '';
      // Build compact args string from remaining keys (skip the tool name key)
      const nameKey = obj.tool != null ? 'tool' : obj.name != null ? 'name' : obj.toolName != null ? 'toolName' : '';
      const argEntries = Object.entries(obj)
        .filter(([k]) => k !== nameKey)
        .map(([k, v]) => {
          const valStr = typeof v === 'string'
            ? `"${v.length > 60 ? v.slice(0, 57) + '...' : v}"`
            : typeof v === 'object' && v !== null
              ? JSON.stringify(v).slice(0, 60)
              : String(v);
          return `${k}: ${valStr}`;
        });
      const argsStr = argEntries.join(', ');
      if (toolName) return `${toolName}({${argsStr}})`;
      // No tool name — show compact kv
      return `{${argsStr}}`;
    }
  }
  // For all other events: prefer summary, append compact detail fragments if useful
  if (ev.summary) {
    if (ev.detail != null && typeof ev.detail === 'object') {
      const entries = Object.entries(ev.detail as Record<string, unknown>)
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
      if (entries.length > 0) return `${ev.summary} — ${entries.join(', ')}`;
    }
    return ev.summary;
  }
  if (ev.detail != null) {
    const parsed = parseDetail(ev.detail);
    if (typeof parsed === 'string') return parsed;
    return JSON.stringify(parsed).slice(0, 80);
  }
  return '';
}

/** Format a duration in ms to a human-readable string. */
export function formatEventDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

// Re-export History with "Audit" name — same data, different page label
export function Audit() {
  const [traces, setTraces] = useState<AuditTrace[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [trigger, setTrigger] = useState('');
  const [status, setStatus] = useState<'all' | 'success' | 'error' | 'running'>('all');
  const [loading, setLoading] = useState(true);
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(new Set());
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

  function formatDuration(trace: AuditTrace): string {
    if (trace.endedAt) {
      const ms = new Date(trace.endedAt).getTime() - new Date(trace.startedAt).getTime();
      if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
      return `${Math.max(0, Math.round(ms))}ms`;
    }
    return 'running';
  }


  function formatTime(value: string): string {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = traces.filter((t) => {
    if (status !== 'all' && t.status !== status) return false;
    if (!normalizedQuery) return true;
    const inTrace =
      t.trigger.toLowerCase().includes(normalizedQuery) ||
      t.traceId.toLowerCase().includes(normalizedQuery) ||
      t.events.some((ev) =>
        `${ev.type} ${ev.summary}`.toLowerCase().includes(normalizedQuery),
      );
    return inTrace;
  });

  const todayCount = traces.filter((t) => {
    const d = new Date(t.startedAt);
    const now = new Date();
    return d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
  }).length;

  function traceHeadline(t: AuditTrace): string {
    return t.events.find((ev) => ev.summary.trim())?.summary ?? `${t.events.length} events`;
  }

  function toggleTrace(traceId: string) {
    setExpandedTraces((prev) => {
      const next = new Set(prev);
      if (next.has(traceId)) next.delete(traceId);
      else next.add(traceId);
      return next;
    });
  }

  function hasDetail(t: AuditTrace): boolean {
    return t.events.length > 0;
  }

  return (
    <div class="audit-page">
      <div class="page-header">
        <div class="page-title">Audit Log</div>
        <div class="header-actions">
          <div class="audit-header-meta">{todayCount} traces today</div>
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
          <div class="audit-filters-row">
            <label class="audit-search">
              <LuSearch size={14} />
              <input
                value={query}
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                placeholder="Search traces, events, tools…"
              />
            </label>
            <div class="audit-filter-controls">
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
                <option value="dashboard">Dashboard</option>
                <option value="system">System</option>
              </select>
              <select
                class="btn btn-sm"
                value={status}
                onChange={(e) => setStatus((e.target as HTMLSelectElement).value as 'all' | 'success' | 'error' | 'running')}
              >
                <option value="all">All status</option>
                <option value="success">OK</option>
                <option value="error">Error</option>
                <option value="running">Running</option>
              </select>
            </div>
          </div>

          <div class="audit-timeline">
            {filtered.length === 0 ? (
              <div class="empty-state">
                <div class="empty-state-icon"><LuSearch size={18} /></div>
                <div class="empty-state-text">No audit traces</div>
              </div>
            ) : (
              filtered.map((t, i) => (
                <div key={t.traceId} class="audit-row">
                  <div class="audit-time-col">
                    <div class="audit-time">{formatTime(t.startedAt)}</div>
                    {i < filtered.length - 1 && <div class="audit-time-line" />}
                  </div>
                  <div class={`audit-card${hasDetail(t) ? ' audit-card-expandable' : ''}`}>
                    <div
                      class="audit-card-head"
                      {...(hasDetail(t)
                        ? {
                            role: 'button',
                            tabIndex: 0,
                            'aria-expanded': expandedTraces.has(t.traceId),
                            'aria-label': `Toggle details for trace ${t.traceId.slice(0, 8)}`,
                            onClick: () => toggleTrace(t.traceId),
                            onKeyDown: (e: KeyboardEvent) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleTrace(t.traceId);
                              }
                            },
                            style: { cursor: 'pointer' },
                          }
                        : {})}
                    >
                      <div class="audit-chip-row">
                        <span class={`audit-chip trigger ${t.trigger}`}>{t.trigger.toUpperCase()}</span>
                        <span class="audit-chip id">{t.traceId.slice(0, 8)}</span>
                        <span class={`audit-chip status ${t.status}`}>{t.status === 'success' ? 'OK' : t.status === 'error' ? 'Error' : 'Running'}</span>
                      </div>
                      <div class="audit-card-head-right">
                        <div class="audit-duration">{formatDuration(t)}</div>
                        {hasDetail(t) && (
                          <span class="audit-expand-icon">
                            {expandedTraces.has(t.traceId) ? <LuChevronDown size={12} /> : <LuChevronRight size={12} />}
                          </span>
                        )}
                      </div>
                    </div>
                    <div class="audit-title-line">{traceHeadline(t)}</div>
                    {t.events.length > 0 && (
                      <div class="audit-event-pills">
                        {t.events.slice(0, 4).map((ev, idx) => (
                          <span key={`${t.traceId}-${idx}`} class="audit-chip soft">
                            {ev.type}
                            {ev.durationMs !== undefined ? ` ${ev.durationMs}ms` : ''}
                          </span>
                        ))}
                      </div>
                    )}
                    {expandedTraces.has(t.traceId) && hasDetail(t) && (
                      <div class="audit-detail-section">
                        {t.events.map((ev, idx) => (
                          <div key={`${t.traceId}-detail-${idx}`} class="audit-event-row">
                            <span class={`audit-event-type-label${ev.type === 'tool_use' ? ' tool' : ''}`}>{ev.type}</span>
                            <span class={`audit-event-content${ev.type === 'tool_use' ? ' mono' : ''}`}>
                              {formatEventContent(ev)}
                            </span>
                            <span class="audit-event-dur">
                              {formatEventDuration(ev.durationMs)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {traces.length < total && (
            <div class="audit-load-more-wrap">
              <button class="btn btn-sm" onClick={() => load(offset + limit)} disabled={loading}>
                {loading ? 'Loading…' : 'Load More'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
