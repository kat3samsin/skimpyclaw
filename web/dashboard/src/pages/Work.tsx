import { useEffect, useMemo, useState } from 'preact/hooks';
import { LuPlus, LuPause, LuPlay, LuSquare, LuSend, LuCircleCheck, LuMessageSquare, LuFolderOpen } from 'react-icons/lu';
import {
  getWorkItems, createWork,
  getWorkItem, sendWorkChat, approveWork, pauseWork, resumeWork, stopWork, openWorkWorkdir, pickWorkdir,
} from '../api/client.js';
import type { WorkItemState, WorkStatus, CreateWorkInput, WorkTimelineEvent } from '../types.js';

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
  autoApprove: boolean;
}

function defaultFormState(): CreateFormState {
  return {
    prompt: '',
    workdir: '',
    advanced: false,
    plannerModel: 'claude-opus',
    devModel: 'claude-think',
    reviewerModel: 'codex',
    baseRef: 'HEAD',
    maxIterations: 5,
    autoApprove: false,
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
      payload.autoApprove = form.autoApprove;
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
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input
                placeholder="Workdir (absolute path or project alias)"
                value={form.workdir}
                onInput={e => setForm(s => ({ ...s, workdir: (e.target as HTMLInputElement).value }))}
                required
                style={{ flex: 1, fontSize: 12, padding: 6, boxSizing: 'border-box' }}
              />
              <button
                type="button"
                class="btn"
                title="Pick folder"
                onClick={async () => {
                  try {
                    const res = await pickWorkdir();
                    if (res.path) setForm(s => ({ ...s, workdir: res.path! }));
                  } catch (err: any) {
                    setError(err?.message ?? 'picker failed');
                  }
                }}
                style={{ fontSize: 11, padding: '2px 10px' }}
              >Browse…</button>
            </div>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <input
                type="checkbox"
                checked={form.autoApprove}
                onChange={e => setForm(s => ({ ...s, autoApprove: (e.target as HTMLInputElement).checked }))}
              />
              Auto-approve plans (skip the approval gate each iteration)
            </label>
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

function WorkDetail({ id }: { id: string }) {
  const [state, setState] = useState<WorkItemState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [actionPending, setActionPending] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const s = await getWorkItem(id);
        if (alive) setState(s);
      } catch (err: any) {
        if (alive) setError(err?.message ?? 'failed to load');
      }
    }
    load();
    const interval = setInterval(load, 3000);
    return () => { alive = false; clearInterval(interval); };
  }, [id]);

  if (error) return <div style={{ padding: 24, color: 'var(--error)' }}>{error}</div>;
  if (!state) return <div style={{ padding: 24 }}>Loading…</div>;

  async function runAction(key: string, fn: () => Promise<WorkItemState>) {
    setActionPending(key);
    try {
      const next = await fn();
      setState(next);
    } catch (err: any) {
      setError(err?.message ?? `${key} failed`);
    } finally {
      setActionPending(null);
    }
  }

  async function onSendChat(e: Event) {
    e.preventDefault();
    const msg = chatInput.trim();
    if (!msg) return;
    setChatInput('');
    await runAction('chat', () => sendWorkChat(id, msg));
  }

  const terminal = ['done', 'blocked', 'stopped'].includes(state.status);
  const paused = state.status === 'paused';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-muted)' }}>{state.id}</span>
        <span style={{ fontSize: 11, padding: '2px 6px', background: statusColor(state.status), color: 'white', borderRadius: 3 }}>{state.status}</span>
        <span style={{ fontSize: 12 }}>iter {state.iteration}/{state.maxIterations}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          planner: {state.plannerModel} · dev: {state.devModel} · reviewer: {state.reviewerModel}
        </span>
        <div style={{ flex: 1 }} />
        {!terminal && !paused && (
          <button class="btn" disabled={actionPending === 'pause'} onClick={() => runAction('pause', () => pauseWork(id))} style={{ fontSize: 12 }}>
            <LuPause size={12} /> Pause
          </button>
        )}
        {paused && (
          <button class="btn btn-primary" disabled={actionPending === 'resume'} onClick={() => runAction('resume', () => resumeWork(id))} style={{ fontSize: 12 }}>
            <LuPlay size={12} /> Resume
          </button>
        )}
        {!terminal && (
          <button class="btn" disabled={actionPending === 'stop'} onClick={() => runAction('stop', () => stopWork(id))} style={{ fontSize: 12 }}>
            <LuSquare size={12} /> Stop
          </button>
        )}
      </div>

      {(state.blockedReason || state.stoppedReason) && (
        <div style={{
          padding: '12px 16px',
          background: state.blockedReason ? 'rgba(193, 92, 79, 0.12)' : 'rgba(136, 136, 136, 0.12)',
          borderBottom: '1px solid var(--border)',
          fontSize: 13,
        }}>
          <strong style={{ color: state.blockedReason ? 'var(--error)' : 'var(--text-muted)' }}>
            {state.blockedReason ? 'Blocked' : 'Stopped'}:
          </strong>{' '}
          {state.blockedReason ?? state.stoppedReason}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        <div style={{
          padding: '10px 14px', marginBottom: 16, borderRadius: 8,
          background: 'var(--surface-alt)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>ORIGINAL GOAL</span>
            <span>·</span>
            <button
              onClick={() => openWorkWorkdir(id).catch(e => setError(e?.message ?? 'open failed'))}
              class="btn"
              title="Open workdir in file manager"
              style={{ fontSize: 11, padding: '2px 6px', fontFamily: 'var(--mono)', fontWeight: 400 }}
            >
              <LuFolderOpen size={11} /> {state.workdir}
            </button>
          </div>
          <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{state.prompt}</div>
        </div>
        <Feed state={state} onApprove={() => runAction('approve', () => approveWork(id))} approvePending={actionPending === 'approve'} />
      </div>

      {!terminal && (
        <form onSubmit={onSendChat} style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
          <input
            type="text"
            placeholder="Message the planner…"
            value={chatInput}
            onInput={e => setChatInput((e.target as HTMLInputElement).value)}
            style={{ flex: 1, fontSize: 13, padding: 8 }}
          />
          <button type="submit" class="btn btn-primary" disabled={!chatInput.trim() || actionPending === 'chat'}>
            <LuSend size={14} />
          </button>
        </form>
      )}
    </div>
  );
}

function Feed({ state, onApprove, approvePending }: { state: WorkItemState; onApprove: () => void; approvePending: boolean }) {
  const entries = useMemo(() => {
    type Entry =
      | { kind: 'chat'; at: string; role: 'user' | 'planner'; content: string; id: string }
      | { kind: 'iter'; at: string; iteration: number; ev: WorkTimelineEvent; id: string };
    const out: Entry[] = [];
    for (const m of state.chatMessages) {
      out.push({ kind: 'chat', at: m.createdAt, role: m.role, content: m.content, id: m.id });
    }
    for (const ev of state.timeline) {
      if (ev.kind === 'dev-completed' || ev.kind === 'review-completed') {
        out.push({ kind: 'iter', at: ev.at, iteration: ev.iteration, ev, id: ev.id });
      }
    }
    out.sort((a, b) => a.at.localeCompare(b.at));
    return out;
  }, [state]);

  return (
    <div>
      {entries.map(e => {
        if (e.kind === 'chat') {
          const isUser = e.role === 'user';
          return (
            <div key={e.id} style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: 12 }}>
              <div style={{
                maxWidth: '80%', padding: '8px 12px', borderRadius: 8,
                background: isUser ? 'var(--accent, #4a90b8)' : 'var(--surface-alt)',
                color: isUser ? 'white' : 'inherit',
                fontSize: 13, whiteSpace: 'pre-wrap',
              }}>
                {!isUser && <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, color: '#4a9b5a' }}>PLANNER</div>}
                {e.content}
                {!isUser && state.status === 'awaiting_approval' && isLatestPlannerMessage(state, e.id) && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    <button class="btn btn-primary" disabled={approvePending} onClick={onApprove} style={{ fontSize: 12 }}>
                      <LuCircleCheck size={12} /> Approve
                    </button>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>
                      or refine via chat below
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        }
        return <IterationRow key={e.id} ev={e.ev} />;
      })}

      {state.liveActivity && (
        <div style={{ padding: 10, background: 'var(--surface-alt)', borderRadius: 6, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <LuMessageSquare size={14} />
          <strong>{state.liveActivity.agent}</strong> running…
          <span style={{ color: 'var(--text-muted)' }}>
            {Math.round((Date.now() - new Date(state.liveActivity.startedAt).getTime()) / 1000)}s
          </span>
        </div>
      )}
    </div>
  );
}

function isLatestPlannerMessage(state: WorkItemState, msgId: string): boolean {
  const plannerMsgs = state.chatMessages.filter(m => m.role === 'planner');
  return plannerMsgs.length > 0 && plannerMsgs[plannerMsgs.length - 1]!.id === msgId;
}

function IterationRow({ ev }: { ev: WorkTimelineEvent }) {
  const [open, setOpen] = useState(false);
  const label = ev.kind === 'dev-completed'
    ? `iter ${ev.iteration} · dev → ${ev.changedFiles?.length ?? 0} files`
    : `iter ${ev.iteration} · reviewer → ${ev.findingsSnapshot?.length ?? 0} findings`;
  return (
    <div style={{ borderTop: '1px dashed var(--border)', padding: '8px 0', fontSize: 12, color: 'var(--text-muted)' }}>
      <button onClick={() => setOpen(v => !v)} class="btn" style={{ fontSize: 12, padding: '2px 6px' }}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open && (
        <div style={{ padding: '8px 16px', fontSize: 12 }}>
          {ev.changedFiles && ev.changedFiles.length > 0 && (
            <div><strong>Files:</strong>
              <ul style={{ margin: '4px 0 8px 20px' }}>{ev.changedFiles.map(f => <li key={f}>{f}</li>)}</ul>
            </div>
          )}
          {ev.findingsSnapshot && ev.findingsSnapshot.length > 0 && (
            <div><strong>Findings:</strong>
              <ul style={{ margin: '4px 0 0 20px' }}>
                {ev.findingsSnapshot.map(f => (
                  <li key={f.id}>
                    <span style={{ fontWeight: 600, color: f.severity === 'high' ? 'var(--error)' : f.severity === 'medium' ? '#c49a3a' : 'inherit' }}>
                      [{f.severity}]
                    </span>{' '}
                    {f.summary}
                    {f.file && <span style={{ color: 'var(--text-muted)' }}> — {f.file}{f.line ? `:${f.line}` : ''}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
