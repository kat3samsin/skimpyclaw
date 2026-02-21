import { useState, useEffect } from 'preact/hooks';
import { getApprovals, approveCommand, denyCommand } from '../api/client.js';
import type { Approval } from '../types.js';
import { LuCircleCheck, LuTriangle } from 'react-icons/lu';

interface ApprovalsProps {
  showToast: (msg: string, type?: 'success' | 'error' | 'warning') => void;
  onCountChange?: (count: number) => void;
}

export function Approvals({ showToast, onCountChange }: ApprovalsProps) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<Set<string>>(new Set());

  useEffect(() => {
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  async function load() {
    try {
      const data = await getApprovals();
      const list = data.approvals ?? [];
      setApprovals(list);
      onCountChange?.(list.length);
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

  const tierLabel = (tier: number) => {
    if (tier === 2) return 'Medium risk';
    if (tier === 3) return 'High risk';
    return `Tier ${tier}`;
  };

  return (
    <div>
      <div class="page-header">
        <div class="page-title">Approvals</div>
        <button class="btn btn-sm" onClick={load}>Refresh</button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
          <div class="spinner" />
        </div>
      ) : approvals.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state-icon"><LuCircleCheck size={18} /></div>
          <div class="empty-state-text">No pending approvals</div>
        </div>
      ) : (
        <div>
          {approvals.map(a => (
            <div class="approval-banner" key={a.id} style={{ marginBottom: 12 }}>
              <div class="approval-banner-icon"><LuTriangle size={16} /></div>
              <div class="approval-banner-content">
                <div class="approval-banner-title">
                  {tierLabel(a.tier)} command requires approval
                </div>
                <div class="approval-banner-detail">{a.command}</div>
                {a.reason && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    {a.reason}
                  </div>
                )}
              </div>
              <div class="approval-banner-actions">
                <button
                  class="btn btn-sm btn-success"
                  disabled={acting.has(a.id)}
                  onClick={() => act(a.id, true)}
                >
                  Approve
                </button>
                <button
                  class="btn btn-sm btn-danger"
                  disabled={acting.has(a.id)}
                  onClick={() => act(a.id, false)}
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
