import { useState, useEffect } from 'preact/hooks';
import { getStatus, getAudit } from '../api/client.js';
import type { StatusResponse, AuditTrace } from '../types.js';
import type { PageId } from '../components/Sidebar.js';
import {
  LuClock3,
  LuClock4,
  LuCpu,
  LuHistory,
  LuMessageSquare,
  LuMoon,
  LuSend,
  LuServer,
  LuSun,
} from 'react-icons/lu';

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatTimeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const hh = Math.floor(m / 60);
  if (hh < 24) return `${hh}h ago`;
  return `${Math.floor(hh / 24)}d ago`;
}

function formatNextCronRun(dateStr?: string): string {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  const diff = d.getTime() - Date.now();
  if (diff < 0) return 'overdue';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `in ${m}m`;
  const hh = Math.floor(m / 60);
  return `in ${hh}h ${m % 60}m`;
}

function getTraceSummary(trace: AuditTrace): string {
  const toolUses = trace.events.filter(e => e.type === 'tool_use').length;
  if (toolUses > 0) return `${toolUses} tool call${toolUses > 1 ? 's' : ''}`;
  if (trace.events.length > 0) return trace.events[0].summary ?? '';
  return '';
}

interface OverviewProps {
  onNavigate: (page: PageId) => void;
  theme: 'light' | 'dark';
  onThemeToggle: () => void;
}

export function Overview({ onNavigate, theme, onThemeToggle }: OverviewProps) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [traces, setTraces] = useState<AuditTrace[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  async function loadData() {
    try {
      const [s, audit] = await Promise.all([
        getStatus(),
        getAudit({ limit: 8, offset: 0 }),
      ]);
      setStatus(s);
      setTraces(audit.traces ?? []);
    } catch (e) {
      console.error('[overview] load failed', e);
    } finally {
      setLoading(false);
    }
  }

  const triggerIcon = (trigger: string) => {
    if (trigger === 'telegram') return <LuSend size={14} />;
    if (trigger === 'cron') return <LuClock3 size={14} />;
    return <LuServer size={14} />;
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <div class="spinner" />
      </div>
    );
  }

  const soonestCron = status?.cronJobs.reduce<{ nextRun?: string } | null>((a, b) => {
    if (!a?.nextRun) return b;
    if (!b.nextRun) return a;
    return new Date(a.nextRun) < new Date(b.nextRun) ? a : b;
  }, null);

  return (
    <div>
      <div class="page-header">
        <div class="page-title">Overview</div>
        <div class="header-actions">
          <div class="header-meta">
            {(status?.model ?? '—')} &bull; up {status ? formatUptime(status.uptime) : '—'}
          </div>
          <button class="theme-toggle" onClick={onThemeToggle} aria-label="Toggle theme">
            {theme === 'light' ? <LuMoon size={16} /> : <LuSun size={16} />}
          </button>
        </div>
      </div>

      {/* Welcome banner */}
      <div class="welcome-banner">
        <div class="welcome-greeting">{getGreeting()}, Katrina</div>
        <div class="welcome-sub">
          {status
            ? `Running for ${formatUptime(status.uptime)} · ${status.model}`
            : 'Loading…'}
        </div>
      </div>

      {/* Stat cards */}
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon sage"><LuClock3 size={16} /></div>
          <div class="stat-label">Uptime</div>
          <div class="stat-value">{status ? formatUptime(status.uptime) : '—'}</div>
          <div class="stat-sub">since last restart</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon amber"><LuClock4 size={16} /></div>
          <div class="stat-label">Next Cron</div>
          <div class="stat-value" style={{ fontSize: '18px', paddingTop: '4px' }}>
            {formatNextCronRun(soonestCron?.nextRun)}
          </div>
          <div class="stat-sub">{status?.cronJobs.length ?? 0} jobs scheduled</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon green"><LuCpu size={16} /></div>
          <div class="stat-label">Model</div>
          <div class="stat-value" style={{ fontSize: '13px', paddingTop: '8px', fontFamily: 'var(--mono)' }}>
            {status?.model ?? '—'}
          </div>
          <div class="stat-sub">active agent: {status?.agent ?? '—'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon blue"><LuMessageSquare size={16} /></div>
          <div class="stat-label">Last Message</div>
          <div class="stat-value" style={{ fontSize: '18px', paddingTop: '4px' }}>
            {status?.lastMessage ? formatTimeAgo(status.lastMessage) : 'never'}
          </div>
          <div class="stat-sub">last activity</div>
        </div>
      </div>
      <div class="cards-link-row">
        <a
          class="section-link"
          href="#audit"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('audit');
          }}
        >
          View all -&gt;
        </a>
      </div>

      {/* Audit logs */}
      <div class="section">
        <div class="section-header">
          <div class="section-title">Audit Logs</div>
        </div>
        <div class="feed-card">
          <div class="feed">
            {traces.length === 0 ? (
              <div class="empty-state">
                <div class="empty-state-icon"><LuHistory size={18} /></div>
                <div class="empty-state-text">No recent audit logs</div>
              </div>
            ) : (
              traces.slice(0, 6).map(t => (
                <div class="feed-item" key={t.traceId}>
                  <div class={`feed-icon ${t.trigger === 'telegram' ? 'telegram' : t.trigger === 'cron' ? 'cron' : 'system'}`}>
                    {triggerIcon(t.trigger)}
                  </div>
                  <div>
                    <div class="feed-title">{t.trigger}</div>
                    <div class="feed-detail">{getTraceSummary(t)}</div>
                  </div>
                  <div class="feed-time">{formatTimeAgo(t.startedAt)}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Cron jobs */}
      {(status?.cronJobs?.length ?? 0) > 0 && (
        <div class="section">
          <div class="section-header">
            <div class="section-title">Scheduled Jobs</div>
            <a
              class="section-link"
              href="#cron"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('cron');
              }}
            >
              Manage -&gt;
            </a>
          </div>
          <div class="cron-grid">
            {(status?.cronJobs ?? []).slice(0, 4).map(j => (
              <div class="cron-card" key={j.id}>
                <div class="cron-info">
                  <div class="cron-name">{j.name}</div>
                  <div class="cron-schedule">{j.id}</div>
                </div>
                <div class="cron-next">{formatNextCronRun(j.nextRun)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
