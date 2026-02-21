import { useEffect, useMemo, useState } from 'preact/hooks';
import { getCodeAgents } from '../api/client.js';
import type { CodeAgent } from '../types.js';
import { LuCheck, LuChevronDown, LuClock3, LuCode, LuDollarSign, LuRefreshCw, LuRotateCw, LuX } from 'react-icons/lu';

const CODING_ACCENTS: Array<{ color: string; soft: string }> = [
  { color: '#b48b7f', soft: 'rgba(180, 139, 127, 0.12)' },
  { color: '#9d8792', soft: 'rgba(157, 135, 146, 0.12)' },
  { color: '#7f9a9a', soft: 'rgba(127, 154, 154, 0.12)' },
  { color: '#a9957a', soft: 'rgba(169, 149, 122, 0.12)' },
  { color: '#8a859d', soft: 'rgba(138, 133, 157, 0.12)' },
];

function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h) + input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function accentForTask(taskId: string): { color: string; soft: string } {
  return CODING_ACCENTS[hashString(taskId) % CODING_ACCENTS.length];
}

function elapsedSeconds(task: CodeAgent): number {
  if (typeof task.durationSeconds === 'number') return task.durationSeconds;
  const secs = Math.max(0, Math.round((Date.now() - new Date(task.startedAt).getTime()) / 1000));
  return secs;
}

function formatElapsed(task: CodeAgent): string {
  const secs = elapsedSeconds(task);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

function statusClass(status: CodeAgent['status']): 'running' | 'completed' | 'failed' | 'pending' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'timeout') return 'failed';
  if (status === 'pending') return 'pending';
  return 'running';
}

function formatShortTime(ts?: string): string {
  if (!ts) return '--:--';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function statusIcon(status: CodeAgent['status']) {
  if (status === 'completed') return <LuCheck size={20} />;
  if (status === 'failed' || status === 'timeout') return <LuX size={20} />;
  return <LuRefreshCw size={20} />;
}

export function Coding() {
  const [agents, setAgents] = useState<CodeAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [accent] = useState(() => CODING_ACCENTS[Math.floor(Math.random() * CODING_ACCENTS.length)]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, []);

  async function load() {
    try {
      const data = await getCodeAgents();
      setAgents(data.agents ?? []);
    } catch {
      // ignore polling errors
    } finally {
      setLoading(false);
    }
  }

  const childMap = useMemo(() => {
    const map = new Map<string, CodeAgent[]>();
    for (const a of agents) {
      if (!a.parentTaskId) continue;
      const arr = map.get(a.parentTaskId) ?? [];
      arr.push(a);
      map.set(a.parentTaskId, arr);
    }
    return map;
  }, [agents]);

  const roots = useMemo(() => agents.filter(a => !a.parentTaskId), [agents]);

  const stats = useMemo(() => {
    const running = roots.filter(t => statusClass(t.status) === 'running').length;
    const completed = roots.filter(t => statusClass(t.status) === 'completed').length;
    const failed = roots.filter(t => statusClass(t.status) === 'failed').length;
    return { running, completed, failed, cost: 0 };
  }, [roots]);

  return (
    <div
      class="coding-page"
      style={{
        '--coding-accent': accent.color,
        '--coding-accent-soft': accent.soft,
      } as any}
    >
      <div class="page-header">
        <div class="page-title">Coding Agent</div>
        <div class="header-actions">
          <div class="coding-refresh-pill">
            <span class="dot" /> Auto-refresh 3s
          </div>
          <button class="btn-refresh" onClick={load}><LuRefreshCw size={14} /> Refresh</button>
        </div>
      </div>

      {loading && agents.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
          <div class="spinner" />
        </div>
      ) : roots.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state-icon"><LuCode size={18} /></div>
          <div class="empty-state-text">No coding agent sessions</div>
        </div>
      ) : (
        <div class="coding-body">
          <div class="coding-stats-grid">
            <div class="coding-stat-card">
              <div class="coding-stat-icon running"><LuRefreshCw size={14} /></div>
              <div class="coding-stat-content">
                <div class="coding-stat-value">{stats.running}</div>
                <div class="coding-stat-label">Running</div>
              </div>
            </div>
            <div class="coding-stat-card">
              <div class="coding-stat-icon completed"><LuCheck size={14} /></div>
              <div class="coding-stat-content">
                <div class="coding-stat-value">{stats.completed}</div>
                <div class="coding-stat-label">Completed</div>
              </div>
            </div>
            <div class="coding-stat-card">
              <div class="coding-stat-icon failed"><LuX size={14} /></div>
              <div class="coding-stat-content">
                <div class="coding-stat-value">{stats.failed}</div>
                <div class="coding-stat-label">Failed</div>
              </div>
            </div>
            <div class="coding-stat-card">
              <div class="coding-stat-icon cost"><LuDollarSign size={14} /></div>
              <div class="coding-stat-content">
                <div class="coding-stat-value">${stats.cost.toFixed(2)}</div>
                <div class="coding-stat-label">Cost today</div>
              </div>
            </div>
          </div>

          {roots.map(task => {
            const children = childMap.get(task.id) ?? [];
            const output = task.liveOutput || task.outputPreview;
            const cls = statusClass(task.status);
            const actionLabel = cls === 'running' ? 'Cancel' : cls === 'failed' ? 'Retry' : '';
            const cardAccent = accentForTask(task.id);
            return (
              <div
                key={task.id}
                class={`coding-task-card ${cls}`}
                style={{
                  '--card-accent': cardAccent.color,
                  '--card-accent-soft': cardAccent.soft,
                } as any}
              >
                <div class="coding-task-main">
                  <div class={`coding-task-icon ${cls}`}>{statusIcon(task.status)}</div>
                  <div class="coding-task-content">
                    <div class="coding-task-pills">
                      <span class="coding-pill id">{task.id}</span>
                      <span class="coding-pill">TEAM ({children.length})</span>
                      <span class={`coding-pill status ${cls}`}>{task.status}</span>
                    </div>
                    <div class="coding-task-title">{task.task}</div>
                    <div class="coding-task-submeta">
                      {task.model && <span>{task.model}</span>}
                      <span>•</span>
                      <span><LuClock3 size={13} /> {formatElapsed(task)}</span>
                      <span>•</span>
                      <span class="coding-pill">$0.00 · -- tok</span>
                      <span>{formatShortTime(task.startedAt)}</span>
                    </div>
                  </div>
                  {actionLabel ? (
                    <button class={`coding-task-action ${cls}`} type="button">
                      {cls === 'failed' ? <LuRotateCw size={12} /> : null}
                      {actionLabel}
                    </button>
                  ) : null}
                </div>
                <div class={`coding-task-progress ${cls}`} />

                {children.length > 0 && (
                  <details class="coding-subagents" open>
                    <summary><LuChevronDown size={14} /> Subagents ({children.length})</summary>
                    <div class="coding-subagents-list">
                      {children.map(child => (
                        <div key={child.id} class="coding-subagent-row">
                          <span class={`coding-subagent-icon ${statusClass(child.status)}`}>{statusIcon(child.status)}</span>
                          <span class="audit-id">{child.id}</span>
                          <span class={`ca-status-badge ${child.status}`}>{child.status}</span>
                          <span class="coding-pill">$0.00</span>
                          <span class="coding-subagent-task">{child.subtask || child.task}</span>
                          <span class="coding-subagent-time">{formatElapsed(child)}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                <details class="coding-output">
                  <summary><LuChevronDown size={14} /> Live output</summary>
                  {output ? <pre class={`ca-output${task.error ? ' ca-error' : ''}`}>{output}</pre> : null}
                  {!output && task.error ? <pre class="ca-output ca-error">{task.error}</pre> : null}
                  {!output && !task.error && task.synthesisResult ? <pre class="ca-output">{task.synthesisResult}</pre> : null}
                </details>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
