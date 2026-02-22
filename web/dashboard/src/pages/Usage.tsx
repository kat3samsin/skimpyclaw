import { useState, useEffect } from 'preact/hooks';
import { getUsageSummary, getUsageRecords } from '../api/client.js';
import type { UsageSummaryResponse, UsageRecord } from '../types.js';
import { LuDollarSign, LuHash, LuMessageSquare, LuRefreshCw } from 'react-icons/lu';

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatTimeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function Usage() {
  const [summary, setSummary] = useState<UsageSummaryResponse | null>(null);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const PAGE_SIZE = 25;

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [page]);

  async function loadData() {
    try {
      const [s, r] = await Promise.all([
        getUsageSummary(),
        getUsageRecords({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
      ]);
      setSummary(s);
      setRecords(r.records ?? []);
      setTotal(r.total ?? 0);
    } catch (e) {
      console.error('[usage] load failed', e);
    } finally {
      setLoading(false);
    }
  }

  if (loading && !summary) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <div class="spinner" />
      </div>
    );
  }

  const today = summary?.today;
  const week = summary?.week;
  const month = summary?.month;

  // Build model breakdown table from month data (most complete view)
  const modelEntries = month?.byModel
    ? Object.entries(month.byModel).sort((a, b) => b[1].cost - a[1].cost)
    : [];

  return (
    <div>
      <div class="page-header">
        <div class="page-title">Usage</div>
        <div class="header-actions">
          <div class="coding-refresh-pill">
            <span class="dot" /> Auto-refresh 30s
          </div>
          <button class="btn-refresh" onClick={loadData}><LuRefreshCw size={14} /> Refresh</button>
        </div>
      </div>

      {/* Stat cards */}
      <div class="usage-stats-grid">
        <div class="stat-card">
          <div class="stat-icon rose"><LuDollarSign size={16} /></div>
          <div class="stat-body">
            <div class="stat-value">{formatCost(today?.totalCost ?? 0)}</div>
            <div class="stat-subtitle">Cost today</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon amber"><LuDollarSign size={16} /></div>
          <div class="stat-body">
            <div class="stat-value">{formatCost(week?.totalCost ?? 0)}</div>
            <div class="stat-subtitle">Last 7 days</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon sage"><LuDollarSign size={16} /></div>
          <div class="stat-body">
            <div class="stat-value">{formatCost(month?.totalCost ?? 0)}</div>
            <div class="stat-subtitle">Last 30 days</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon blue"><LuMessageSquare size={16} /></div>
          <div class="stat-body">
            <div class="stat-value">{today?.totalCalls ?? 0}</div>
            <div class="stat-subtitle">Calls today · {formatTokens((today?.totalInputTokens ?? 0) + (today?.totalOutputTokens ?? 0))} tok</div>
          </div>
        </div>
      </div>

      {/* Model breakdown */}
      {modelEntries.length > 0 && (
        <div class="section">
          <div class="section-header">
            <div class="section-title">Model Breakdown (30d)</div>
          </div>
          <div class="feed-card">
            <table class="usage-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Calls</th>
                  <th>Input Tokens</th>
                  <th>Output Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {modelEntries.map(([model, data]) => (
                  <tr key={model}>
                    <td><code class="usage-model-pill">{model}</code></td>
                    <td>{data.calls}</td>
                    <td>{formatTokens(data.inputTokens)}</td>
                    <td>{formatTokens(data.outputTokens)}</td>
                    <td class="usage-cost-cell">{formatCost(data.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent records */}
      <div class="section">
        <div class="section-header">
          <div class="section-title">Recent Calls</div>
          <div class="audit-header-meta">{total} total</div>
        </div>
        {records.length === 0 ? (
          <div class="empty-state">
            <div class="empty-state-icon"><LuHash size={18} /></div>
            <div class="empty-state-text">No usage records yet</div>
          </div>
        ) : (
          <div class="feed-card">
            <div class="feed">
              {records.map(r => (
                <div class="feed-item" key={r.id}>
                  <div class={`feed-icon ${r.trigger === 'telegram' ? 'telegram' : r.trigger === 'cron' ? 'cron' : 'system'}`}>
                    <LuDollarSign size={14} />
                  </div>
                  <div>
                    <div class="feed-title">
                      <code class="usage-model-pill">{r.model}</code>
                      {' '}
                      <span class="audit-chip trigger muted">{r.trigger}</span>
                    </div>
                    <div class="feed-detail">
                      {formatTokens(r.inputTokens)} in · {formatTokens(r.outputTokens)} out · {formatCost(r.totalCost)}
                    </div>
                  </div>
                  <div class="feed-time">{formatTimeAgo(r.timestamp)}</div>
                </div>
              ))}
            </div>
            {total > PAGE_SIZE && (
              <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', padding: '12px' }}>
                <button
                  class="btn btn-sm"
                  disabled={page === 0}
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                >
                  Previous
                </button>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)', alignSelf: 'center' }}>
                  {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
                </span>
                <button
                  class="btn btn-sm"
                  disabled={(page + 1) * PAGE_SIZE >= total}
                  onClick={() => setPage(p => p + 1)}
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
