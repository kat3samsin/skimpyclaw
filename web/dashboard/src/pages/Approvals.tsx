import { useState, useEffect, useRef } from 'preact/hooks';
import { getApprovals, approveCommand, denyCommand } from '../api/client.js';
import type { Approval } from '../types.js';
import {
  LuCheck,
  LuCircleCheck,
  LuClock,
  LuCode,
  LuMessageSquare,
  LuRefreshCw,
  LuShieldAlert,
  LuX,
} from 'react-icons/lu';

interface ApprovalsProps {
  showToast: (msg: string, type?: 'success' | 'error' | 'warning') => void;
  onCountChange?: (count: number) => void;
}

function formatElapsed(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs.toString().padStart(2, '0')}s`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatResolution(a: Approval): string {
  if (a.status === 'expired') return 'Expired after 5m (no response)';
  const by = a.approvedBy || a.deniedBy || 'unknown';
  const verb = a.status === 'approved' ? 'Approved' : 'Denied';
  if (a.resolvedAt && a.createdAt) {
    const elapsed = new Date(a.resolvedAt).getTime() - new Date(a.createdAt).getTime();
    const s = Math.floor(elapsed / 1000);
    const dur = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${verb} by ${by} \u00b7 ${dur} after request`;
  }
  return `${verb} by ${by}`;
}

function channelLabel(a: Approval): string {
  const ch = a.channelMeta?.channel;
  if (ch === 'telegram') return 'Telegram';
  if (ch === 'discord') return 'Discord';
  if (ch === 'dashboard') return 'Dashboard';
  if (ch) return ch;
  return 'System';
}

function channelIcon(a: Approval) {
  const ch = a.channelMeta?.channel;
  if (ch === 'telegram' || ch === 'discord') return <LuMessageSquare size={12} />;
  if (ch === 'dashboard') return <LuMessageSquare size={12} />;
  return <LuCode size={12} />;
}

function shortenCwd(cwd?: string): string {
  if (!cwd) return '';
  return cwd.replace(/^\/Users\/[^/]+/, '~');
}

export function Approvals({ showToast, onCountChange }: ApprovalsProps) {
  const [pending, setPending] = useState<Approval[]>([]);
  const [recent, setRecent] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<Set<string>>(new Set());
  const tickRef = useRef(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    load();
    const pollInterval = setInterval(load, 5000);
    // Tick every second to update elapsed timers
    const tickInterval = setInterval(() => {
      tickRef.current++;
      setTick(tickRef.current);
    }, 1000);
    return () => { clearInterval(pollInterval); clearInterval(tickInterval); };
  }, []);

  async function load() {
    try {
      const data = await getApprovals();
      setPending(data.pending ?? []);
      setRecent((data.recent ?? []).filter(a => a.status !== 'pending'));
      onCountChange?.(data.pending?.length ?? 0);
    } catch {
      // silently fail on poll
    } finally {
      setLoading(false);
    }
  }

  async function act(id: string, approve: boolean) {
    setActing(prev => new Set([...prev, id]));
    try {
      if (approve) {
        await approveCommand(id);
        showToast('Command approved', 'success');
      } else {
        await denyCommand(id);
        showToast('Command denied', 'warning');
      }
      await load();
    } catch {
      showToast('Action failed', 'error');
    } finally {
      setActing(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  }

  function statusIconEl(status: string) {
    if (status === 'approved') return <LuCheck size={18} />;
    if (status === 'denied') return <LuX size={18} />;
    if (status === 'expired') return <LuClock size={18} />;
    return <LuShieldAlert size={18} />;
  }

  return (
    <div class="approvals-page">
      <div class="page-header">
        <div class="page-title">Approvals</div>
        <div class="header-actions">
          <span class="appr-auto-refresh">
            <span class="appr-auto-dot" /> Auto-refresh 5s
          </span>
          <button class="btn-refresh" onClick={load}>
            <LuRefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
          <div class="spinner" />
        </div>
      ) : (
        <>
          {/* PENDING */}
          <div class="appr-section-label">PENDING ({pending.length})</div>

          {pending.length === 0 ? (
            <div class="empty-state" style={{ marginBottom: 32 }}>
              <div class="empty-state-icon"><LuCircleCheck size={18} /></div>
              <div class="empty-state-text">No pending approvals</div>
            </div>
          ) : (
            <div class="appr-list">
              {pending.map(a => (
                <div class="appr-item pending" key={a.id}>
                  <div class="appr-item-border pending" />
                  <div class="appr-item-body">
                    {/* Header row */}
                    <div class="appr-item-head">
                      <div class="appr-item-icon pending">
                        <LuShieldAlert size={18} />
                      </div>
                      <span class="appr-item-id">req-{a.id}</span>
                      <span class="appr-chip tier">TIER {a.tier}</span>
                      <span class="appr-chip pending">PENDING</span>
                      <span class="appr-elapsed">
                        <LuClock size={12} /> {formatElapsed(a.createdAt)}
                      </span>
                      <div style={{ flex: 1 }} />
                      <div class="appr-actions">
                        <button
                          class="approval-btn-deny"
                          disabled={acting.has(a.id)}
                          onClick={() => act(a.id, false)}
                        >
                          Deny
                        </button>
                        <button
                          class="approval-btn-approve"
                          disabled={acting.has(a.id)}
                          onClick={() => act(a.id, true)}
                        >
                          <LuCheck size={14} /> Approve
                        </button>
                      </div>
                    </div>

                    {/* Reason */}
                    <div class="appr-reason">{a.reason}</div>

                    {/* Command block */}
                    <div class="appr-cmd-block">{a.command}</div>

                    {/* Footer */}
                    <div class="appr-footer">
                      <span class="appr-footer-item">{channelIcon(a)} via {channelLabel(a)}</span>
                      {a.cwd && <span class="appr-footer-sep">&middot;</span>}
                      {a.cwd && <span class="appr-footer-item">{shortenCwd(a.cwd)}</span>}
                      <span class="appr-footer-sep">&middot;</span>
                      <span class="appr-footer-item">{formatDate(a.createdAt)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* RECENT HISTORY */}
          {recent.length > 0 && (
            <>
              <div class="appr-section-label" style={{ marginTop: 32 }}>RECENT HISTORY</div>
              <div class="appr-list">
                {recent.slice(0, 30).map(a => (
                  <div class={`appr-item ${a.status}`} key={a.id}>
                    <div class={`appr-item-border ${a.status}`} />
                    <div class="appr-item-body">
                      {/* Header row */}
                      <div class="appr-item-head">
                        <div class={`appr-item-icon ${a.status}`}>
                          {statusIconEl(a.status)}
                        </div>
                        <span class="appr-item-id">req-{a.id}</span>
                        <span class="appr-chip tier">TIER {a.tier}</span>
                        <span class={`appr-chip ${a.status}`}>{a.status.toUpperCase()}</span>
                      </div>

                      {/* Reason */}
                      <div class="appr-reason">{a.reason}</div>

                      {/* Command block */}
                      <div class="appr-cmd-block">{a.command}</div>

                      {/* Footer */}
                      <div class="appr-footer">
                        <span class="appr-footer-item">{channelIcon(a)} via {channelLabel(a)}</span>
                        {a.cwd && <span class="appr-footer-sep">&middot;</span>}
                        {a.cwd && <span class="appr-footer-item">{shortenCwd(a.cwd)}</span>}
                        <span class="appr-footer-sep">&middot;</span>
                        <span class="appr-footer-item">{formatDate(a.createdAt)}</span>
                        <span class="appr-footer-sep">&middot;</span>
                        <span class="appr-footer-resolution">{formatResolution(a)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
