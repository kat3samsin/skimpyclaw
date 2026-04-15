import { useEffect, useMemo, useState } from 'preact/hooks';
import { LuPlus } from 'react-icons/lu';
import {
  getWorkItems, createWork,
} from '../api/client.js';
import type { WorkItemState, WorkStatus, CreateWorkInput } from '../types.js';

const ACTIVE: WorkStatus[] = ['planning', 'awaiting_approval', 'implementing', 'reviewing', 'revising', 'paused'];
const DONE: WorkStatus[] = ['done', 'blocked', 'stopped'];

type Filter = 'all' | 'active' | 'done';

function statusColor(status: WorkStatus): string {
  switch (status) {
    case 'planning': case 'reviewing': case 'revising': return '#4a90b8';
    case 'awaiting_approval': case 'implementing': return '#c49a3a';
    case 'paused': return '#888';
    case 'done': return '#4a9b5a';
    case 'blocked': return '#c15c4f';
    case 'stopped': return '#888';
  }
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function readSelectedFromHash(): string | null {
  const m = /^#work\/(RL-\d+)/.exec(window.location.hash);
  return m ? m[1]! : null;
}

interface CreateFormState {
  prompt: string;
  workdir: string;
  advanced: boolean;
  plannerModel: string;
  devModel: string;
  reviewerModel: string;
  baseRef: string;
  maxIterations: number;
}

function defaultFormState(): CreateFormState {
  return {
    prompt: '',
    workdir: '',
    advanced: false,
    plannerModel: 'claude-opus',
    devModel: 'skimpyclaw',
    reviewerModel: 'claude-sonnet',
    baseRef: 'HEAD',
    maxIterations: 5,
  };
}

export function Work() {
  const [items, setItems] = useState<WorkItemState[]>([]);
  const [filter, setFilter] = useState<Filter>('active');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CreateFormState>(defaultFormState);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => readSelectedFromHash());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await getWorkItems(filter === 'all' ? 'all' : filter);
        if (!alive) return;
        setItems(r.items);
      } catch (err: any) {
        if (!alive) return;
        setError(err?.message ?? 'failed to load work items');
      }
    }
    load();
    const interval = setInterval(load, 3000);
    return () => { alive = false; clearInterval(interval); };
  }, [filter]);

  useEffect(() => {
    function onHash() { setSelectedId(readSelectedFromHash()); }
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function selectItem(id: string) {
    window.location.hash = `#work/${id}`;
  }

  async function onSubmit(e: Event) {
    e.preventDefault();
    if (!form.prompt.trim() || !form.workdir.trim()) {
      setError('prompt and workdir are required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload: CreateWorkInput = {
        prompt: form.prompt,
        workdir: form.workdir,
      };
      if (form.advanced) {
        payload.plannerModel = form.plannerModel;
        payload.devModel = form.devModel;
        payload.reviewerModel = form.reviewerModel;
        payload.baseRef = form.baseRef;
        payload.maxIterations = form.maxIterations;
      }
      const created = await createWork(payload);
      setCreating(false);
      setForm(defaultFormState());
      setItems(prev => [created, ...prev]);
      selectItem(created.id);
    } catch (err: any) {
      setError(err?.message ?? 'failed to create work item');
    } finally {
      setSubmitting(false);
    }
  }

  const visible = useMemo(() => {
    if (filter === 'all') return items;
    const allowed = filter === 'active' ? ACTIVE : DONE;
    return items.filter(i => (allowed as string[]).includes(i.status));
  }, [items, filter]);

  return (
    <div class="work-page" style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 420px) 1fr', gap: 16, height: '100%' }}>
      <div class="work-list" style={{ borderRight: '1px solid var(--border)', overflow: 'auto' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Work</h2>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{visible.length}</span>
          <div style={{ flex: 1 }} />
          <button class="btn btn-primary" onClick={() => setCreating(v => !v)} style={{ fontSize: 12, padding: '4px 10px' }}>
            <LuPlus size={12} /> New
          </button>
        </div>
        <div style={{ display: 'flex', gap: 4, padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
          {(['all', 'active', 'done'] as Filter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              class={`btn${filter === f ? ' btn-primary' : ''}`}
              style={{ fontSize: 11, padding: '2px 8px', textTransform: 'capitalize' }}
            >
              {f}
            </button>
          ))}
        </div>
        {creating && (
          <form onSubmit={onSubmit} style={{ padding: 12, borderBottom: '1px solid var(--border)', background: 'var(--surface-alt)' }}>
            <textarea
              placeholder="Describe what the work should accomplish"
              value={form.prompt}
              onInput={e => setForm(s => ({ ...s, prompt: (e.target as HTMLTextAreaElement).value }))}
              required
              rows={3}
              style={{ width: '100%', fontSize: 12, padding: 6, marginBottom: 8, boxSizing: 'border-box' }}
            />
            <input
              placeholder="Workdir (absolute path or project alias)"
              value={form.workdir}
              onInput={e => setForm(s => ({ ...s, workdir: (e.target as HTMLInputElement).value }))}
              required
              style={{ width: '100%', fontSize: 12, padding: 6, marginBottom: 8, boxSizing: 'border-box' }}
            />
            <div style={{ marginBottom: 8 }}>
              <button type="button" onClick={() => setForm(s => ({ ...s, advanced: !s.advanced }))} class="btn" style={{ fontSize: 11, padding: '2px 6px' }}>
                {form.advanced ? 'Hide advanced' : 'Show advanced'}
              </button>
            </div>
            {form.advanced && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
                <label style={{ fontSize: 11 }}>Planner <input value={form.plannerModel} onInput={e => setForm(s => ({ ...s, plannerModel: (e.target as HTMLInputElement).value }))} style={{ width: '100%' }} /></label>
                <label style={{ fontSize: 11 }}>Dev <input value={form.devModel} onInput={e => setForm(s => ({ ...s, devModel: (e.target as HTMLInputElement).value }))} style={{ width: '100%' }} /></label>
                <label style={{ fontSize: 11 }}>Reviewer <input value={form.reviewerModel} onInput={e => setForm(s => ({ ...s, reviewerModel: (e.target as HTMLInputElement).value }))} style={{ width: '100%' }} /></label>
                <label style={{ fontSize: 11 }}>Base ref <input value={form.baseRef} onInput={e => setForm(s => ({ ...s, baseRef: (e.target as HTMLInputElement).value }))} style={{ width: '100%' }} /></label>
                <label style={{ fontSize: 11 }}>Max iter <input type="number" min={1} max={20} value={form.maxIterations} onInput={e => setForm(s => ({ ...s, maxIterations: parseInt((e.target as HTMLInputElement).value, 10) || 5 }))} style={{ width: '100%' }} /></label>
              </div>
            )}
            {error && <div style={{ color: 'var(--error)', fontSize: 12, marginBottom: 8 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" class="btn btn-primary" disabled={submitting} style={{ fontSize: 12 }}>
                {submitting ? 'Creating…' : 'Create'}
              </button>
              <button type="button" class="btn" onClick={() => { setCreating(false); setError(null); }} style={{ fontSize: 12 }}>Cancel</button>
            </div>
          </form>
        )}
        {error && !creating && <div style={{ color: 'var(--error)', fontSize: 12, padding: 12 }}>{error}</div>}
        {visible.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No work items yet.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {visible.map(item => (
              <li
                key={item.id}
                onClick={() => selectItem(item.id)}
                style={{
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                  borderLeft: selectedId === item.id ? '3px solid var(--accent, #4a90b8)' : '3px solid transparent',
                  background: selectedId === item.id ? 'var(--surface-alt)' : 'transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-muted)' }}>{item.id}</span>
                  <span style={{ fontSize: 11, padding: '2px 6px', background: statusColor(item.status), color: 'white', borderRadius: 3 }}>
                    {item.status}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{relativeTime(item.updatedAt)}</span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{item.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  iter {item.iteration}/{item.maxIterations}
                  {item.findings.filter(f => f.status === 'open').length > 0 && (
                    <span style={{ color: 'var(--error)', marginLeft: 8 }}>
                      {item.findings.filter(f => f.status === 'open').length} open
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div class="work-detail" style={{ overflow: 'auto' }}>
        {selectedId ? (
          <WorkDetail id={selectedId} />
        ) : (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
            Select a work item from the list
          </div>
        )}
      </div>
    </div>
  );
}

// Stub — full implementation in Task 4.
function WorkDetail({ id }: { id: string }) {
  return <div style={{ padding: 24 }}>Detail for {id} — coming in Task 4</div>;
}
