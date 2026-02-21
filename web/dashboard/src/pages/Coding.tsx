import { useEffect, useMemo, useState } from 'preact/hooks';
import { getCodeAgents } from '../api/client.js';
import type { CodeAgent } from '../types.js';
import { LuCode, LuFolderTree, LuTerminal } from 'react-icons/lu';

function elapsed(task: CodeAgent): string {
  if (typeof task.durationSeconds === 'number') {
    return `${task.durationSeconds}s`;
  }
  const secs = Math.max(0, Math.round((Date.now() - new Date(task.startedAt).getTime()) / 1000));
  return `${secs}s`;
}

export function Coding() {
  const [agents, setAgents] = useState<CodeAgent[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <div>
      <div class="page-header">
        <div class="page-title">Coding Agent</div>
        <button class="btn btn-sm" onClick={load}>Refresh</button>
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
        <div class="tree-container">
          {roots.map(task => {
            const children = childMap.get(task.id) ?? [];
            const output = task.liveOutput || task.outputPreview;
            return (
              <div key={task.id} class="ca-tree">
                <div class="audit-entry">
                  <div class="audit-header">
                    <div>
                      <div class="audit-id">{task.id}</div>
                      <div class="audit-summary">{task.task}</div>
                    </div>
                    <div class="audit-meta">
                      <span class={`ca-status-badge ${task.status}`}>{task.status}</span>
                      <span>{elapsed(task)}</span>
                      {task.model && <span>{task.model}</span>}
                    </div>
                  </div>

                  {output && (
                    <details style={{ marginTop: 8 }}>
                      <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-dim)' }}>
                        <LuTerminal size={14} /> Output
                      </summary>
                      <pre class="ca-output">{output}</pre>
                    </details>
                  )}
                </div>

                {children.length > 0 && (
                  <div class="ca-tree-children">
                    <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8, fontWeight: 600 }}>
                      <LuFolderTree size={14} /> Subagents ({children.length})
                    </div>
                    <div>
                      {children.map(child => (
                        <details key={child.id} class="ca-tree-child">
                          <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, listStyle: 'none' }}>
                            <span class="audit-id">{child.id}</span>
                            <span class={`ca-status-badge ${child.status}`}>{child.status}</span>
                            <span class="audit-summary">{child.subtask || child.task}</span>
                          </summary>
                          {(child.liveOutput || child.outputPreview || child.error) && (
                            <pre class={`ca-output${child.error ? ' ca-error' : ''}`}>{child.liveOutput || child.outputPreview || child.error}</pre>
                          )}
                        </details>
                      ))}
                    </div>
                  </div>
                )}

                {task.synthesisResult && (
                  <details class="audit-entry" style={{ marginTop: 10 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-dim)' }}>Synthesis</summary>
                    <pre class="ca-output">{task.synthesisResult}</pre>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
