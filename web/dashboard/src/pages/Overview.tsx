import { useState, useEffect } from 'preact/hooks';
import { getStatus, getAudit, getApprovals, approveCommand, denyCommand, getUsageSummary } from '../api/client.js';
import type { StatusResponse, AuditTrace, Approval, UsageSummaryResponse } from '../types.js';
import type { PageId } from '../components/Sidebar.js';
import {
  LuArrowRight,
  LuCheck,
  LuClock3,
  LuClock4,
  LuCpu,
  LuDollarSign,
  LuHistory,
  LuMessageSquare,
  LuSend,
  LuServer,
  LuShieldAlert,
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

function formatMinSec(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, '0')}`;
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

function channelLabel(channel?: string | null): string {
  if (!channel) return '—';
  if (channel === 'telegram') return 'Telegram';
  if (channel === 'discord') return 'Discord';
  return channel;
}

function getTraceSummary(trace: AuditTrace): string {
  const toolUses = trace.events.filter(e => e.type === 'tool_use').length;
  if (toolUses > 0) return `${toolUses} tool call${toolUses > 1 ? 's' : ''}`;
  if (trace.events.length > 0) return trace.events[0].summary ?? '';
  return '';
}

interface OverviewProps {
  onNavigate: (page: PageId) => void;
  showToast?: (msg: string, type?: 'success' | 'error' | 'warning') => void;
}

export function Overview({ onNavigate, showToast }: OverviewProps) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [traces, setTraces] = useState<AuditTrace[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<Approval[]>([]);
  const [usageSummary, setUsageSummary] = useState<UsageSummaryResponse | null>(null);
  const [actingOn, setActingOn] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, []);

  async function loadData() {
    const [statusRes, auditRes, approvalsRes, usageRes] = await Promise.allSettled([
      getStatus(),
      getAudit({ limit: 8, offset: 0 }),
      getApprovals(),
      getUsageSummary(),
    ]);

    if (statusRes.status === 'fulfilled') {
      setStatus(statusRes.value);
    } else {
      console.error('[overview] status load failed', statusRes.reason);
    }

    if (auditRes.status === 'fulfilled') {
      setTraces(auditRes.value.traces ?? []);
    } else {
      console.error('[overview] audit load failed', auditRes.reason);
    }

    if (approvalsRes.status === 'fulfilled') {
      setPendingApprovals(approvalsRes.value.pending ?? []);
    } else {
      console.error('[overview] approvals load failed', approvalsRes.reason);
    }

    if (usageRes.status === 'fulfilled') {
      setUsageSummary(usageRes.value);
    }

    setLoading(false);
  }

  async function handleApproval(id: string, approve: boolean) {
    setActingOn(prev => new Set([...prev, id]));
    try {
      if (approve) {
        await approveCommand(id);
        showToast?.('Command approved', 'success');
      } else {
        await denyCommand(id);
        showToast?.('Command denied', 'warning');
      }
      await loadData();
    } catch {
      showToast?.('Action failed', 'error');
    } finally {
      setActingOn(prev => { const n = new Set(prev); n.delete(id); return n; });
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

      {/* Pending approvals banner */}
      {pendingApprovals.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {pendingApprovals.map(a => (
            <div class="approval-card" key={a.id}>
              <div class="approval-card-icon">
                <LuShieldAlert size={20} />
              </div>
              <div class="approval-card-content">
                <div class="approval-card-title">
                  {pendingApprovals.length} pending approval{pendingApprovals.length > 1 ? 's' : ''}
                </div>
                <div class="approval-card-detail">
                  Tier {a.tier} — <code class="approval-cmd">{a.command}</code>
                </div>
                {a.cwd && (
                  <div class="approval-card-cwd">{a.cwd}</div>
                )}
              </div>
              <div class="approval-card-time">{formatMinSec(a.createdAt)}</div>
              <div class="approval-card-actions">
                <button
                  class="approval-btn-deny"
                  disabled={actingOn.has(a.id)}
                  onClick={() => handleApproval(a.id, false)}
                >
                  Deny
                </button>
                <button
                  class="approval-btn-approve"
                  disabled={actingOn.has(a.id)}
                  onClick={() => handleApproval(a.id, true)}
                >
                  <LuCheck size={14} /> Approve
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Stat cards */}
      <div class="stats-grid stats-grid-5">
        <div class="stat-card">
          <div class="stat-icon sage"><LuClock3 size={16} /></div>
          <div class="stat-body">
            <div class="stat-value">{status ? formatUptime(status.uptime) : '—'}</div>
            <div class="stat-subtitle">Uptime</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon amber"><LuClock4 size={16} /></div>
          <div class="stat-body">
            <div class="stat-value stat-value-md">{formatNextCronRun(soonestCron?.nextRun)}</div>
            <div class="stat-subtitle">Next cron · {status?.cronJobs.length ?? 0} jobs</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon green"><LuCpu size={16} /></div>
          <div class="stat-body">
            <div class="stat-value stat-value-md">{status?.model ?? '—'}</div>
            <div class="stat-subtitle">Active model</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon blue"><LuMessageSquare size={16} /></div>
          <div class="stat-body">
            <div class="stat-value stat-value-md">{channelLabel(status?.activeChannel ?? null)}</div>
            <div class="stat-subtitle">Active channel</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon rose"><LuDollarSign size={16} /></div>
          <div class="stat-body">
            <div class="stat-value stat-value-md">{usageSummary ? `$${usageSummary.today.totalCost.toFixed(2)}` : '—'}</div>
            <div class="stat-subtitle">Cost today</div>
          </div>
        </div>
      </div>

      {/* Audit logs */}
      <div class="section">
        <div class="section-header">
          <div class="section-title">Audit Logs</div>
          <a
            class="section-link"
            href="#audit"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('audit');
            }}
          >
            <span class="section-link-content">
              View all <LuArrowRight size={14} />
            </span>
          </a>
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
              <span class="section-link-content">
                Manage <LuArrowRight size={14} />
              </span>
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
