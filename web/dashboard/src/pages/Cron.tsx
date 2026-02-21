import { useState, useEffect } from 'preact/hooks';
import { getConfig, getCronJobs, getCronPromptFile, saveConfig, triggerCronJob } from '../api/client.js';
import type { CronJob } from '../types.js';
import { LuClock3, LuRefreshCw } from 'react-icons/lu';

function formatNextRun(dateStr?: string): string {
  if (!dateStr) return 'N/A';
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `in ${m}m`;
  return `in ${Math.floor(m / 60)}h ${m % 60}m`;
}

interface CronProps {
  showToast: (msg: string, type?: 'success' | 'error' | 'warning') => void;
}

export function Cron({ showToast }: CronProps) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [config, setConfig] = useState<Record<string, any> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [promptSourcePath, setPromptSourcePath] = useState<string | null>(null);
  const [promptSourceContent, setPromptSourceContent] = useState<string | null>(null);
  const [form, setForm] = useState({
    id: '',
    name: '',
    scheduleExpr: '',
    tz: 'America/Chicago',
    model: '',
    payloadKind: 'agentTurn',
    message: '',
    script: '',
    url: '',
    cwd: '',
    timeoutMs: '',
    sendAsVoice: false,
  });

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [jobData, cfgData] = await Promise.all([getCronJobs(), getConfig()]);
      setJobs(jobData.jobs ?? []);
      const cfg = (cfgData.config ?? {}) as Record<string, any>;
      setConfig(cfg);
    } catch (e) {
      showToast('Failed to load cron jobs', 'error');
    } finally {
      setLoading(false);
    }
  }

  async function loadFormFromJob(job: Record<string, any>) {
    const payloadKind = job.payload?.kind || 'agentTurn';
    const rawMessage = job.payload?.message || '';
    let visibleMessage = rawMessage;
    let sourcePath: string | null = null;
    let loadedSourceContent: string | null = null;

    if (payloadKind === 'agentTurn' && typeof rawMessage === 'string' && rawMessage.trim().endsWith('.md')) {
      try {
        const prompt = await getCronPromptFile(rawMessage);
        visibleMessage = prompt.content;
        sourcePath = rawMessage;
        loadedSourceContent = prompt.content;
      } catch {
        // Keep raw path in textarea if prompt file cannot be read.
      }
    }

    setPromptSourcePath(sourcePath);
    setPromptSourceContent(loadedSourceContent);
    setForm({
      id: job.id || '',
      name: job.name || '',
      scheduleExpr: job.schedule?.expr || '',
      tz: job.schedule?.tz || 'America/Chicago',
      model: job.model || '',
      payloadKind,
      message: visibleMessage,
      script: job.payload?.script || '',
      url: job.payload?.url || '',
      cwd: job.payload?.cwd || '',
      timeoutMs: job.payload?.timeoutMs ? String(job.payload.timeoutMs) : '',
      sendAsVoice: Boolean(job.payload?.sendAsVoice),
    });
  }

  function newJob() {
    setSelected(null);
    setPromptSourcePath(null);
    setPromptSourceContent(null);
    setForm({
      id: '',
      name: '',
      scheduleExpr: '',
      tz: 'America/Chicago',
      model: '',
      payloadKind: 'agentTurn',
      message: '',
      script: '',
      url: '',
      cwd: '',
      timeoutMs: '',
      sendAsVoice: false,
    });
  }

  function openJob(id: string) {
    setSelected(id);
    const fromCfg = ((config?.cron as any)?.jobs ?? []).find((j: any) => j.id === id);
    if (fromCfg) {
      void loadFormFromJob(fromCfg);
    }
  }

  async function saveJob() {
    if (!config) return;
    const id = form.id.trim();
    const name = form.name.trim();
    const expr = form.scheduleExpr.trim();
    if (!id || !name || !expr) {
      showToast('ID, name, and schedule are required', 'error');
      return;
    }

    const next = structuredClone(config);
    if (!next.cron) next.cron = { jobs: [] };
    if (!Array.isArray(next.cron.jobs)) next.cron.jobs = [];

    const payload: Record<string, any> = { kind: form.payloadKind };
    if (form.payloadKind === 'agentTurn') {
      const shouldKeepSourcePath =
        promptSourcePath &&
        promptSourceContent !== null &&
        form.message === promptSourceContent;
      payload.message = shouldKeepSourcePath ? promptSourcePath : form.message;
    }
    if (form.payloadKind === 'script') {
      payload.script = form.script;
      if (form.cwd.trim()) payload.cwd = form.cwd.trim();
      if (form.timeoutMs.trim()) payload.timeoutMs = Number(form.timeoutMs);
    }
    if (form.payloadKind === 'http') payload.url = form.url;
    if (form.sendAsVoice) payload.sendAsVoice = true;

    const job = {
      id,
      name,
      schedule: {
        kind: 'cron',
        expr,
        tz: form.tz.trim() || 'America/Chicago',
      },
      payload,
      model: form.model.trim() || undefined,
    };

    const existingIdx = next.cron.jobs.findIndex((j: any) => j.id === id);
    if (existingIdx >= 0) next.cron.jobs[existingIdx] = job;
    else next.cron.jobs.push(job);

    setSaving(true);
    try {
      await saveConfig(next);
      showToast(existingIdx >= 0 ? 'Cron job updated' : 'Cron job created', 'success');
      setConfig(next);
      setSelected(id);
      await load();
    } catch {
      showToast('Failed to save cron job', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function trigger(id: string) {
    setRunning(prev => new Set([...prev, id]));
    try {
      await triggerCronJob(id);
      showToast('Job triggered', 'success');
    } catch (e) {
      showToast('Failed to trigger job', 'error');
    } finally {
      setRunning(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  }

  return (
    <div>
      <div class="page-header">
        <div class="page-title">Scheduled Jobs</div>
        <div class="header-actions">
          <button class="btn btn-sm" onClick={newJob}>New Job</button>
          <button class="btn-refresh" onClick={load}>
            <LuRefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
          <div class="spinner" />
        </div>
      ) : jobs.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state-icon"><LuClock3 size={18} /></div>
          <div class="empty-state-text">No scheduled jobs configured</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16 }}>
          <div class="card" style={{ marginBottom: 0, padding: 0, overflow: 'hidden' }}>
            <div class="feed">
              {jobs.map(j => (
                <button
                  key={j.id}
                  class="feed-item"
                  style={{ border: 'none', width: '100%', textAlign: 'left', background: selected === j.id ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer' }}
                  onClick={() => openJob(j.id)}
                >
                  <div class="feed-icon cron"><LuClock3 size={14} /></div>
                  <div>
                    <div class="feed-title">{j.name}</div>
                    <div class="feed-detail">{j.id}</div>
                  </div>
                  <div class="feed-time">{formatNextRun(j.nextRun)}</div>
                </button>
              ))}
            </div>
          </div>

          <div class="card" style={{ marginBottom: 0 }}>
            <div class="card-title" style={{ fontWeight: 700, marginBottom: 12 }}>{selected ? 'Edit Cron Job' : 'Create Cron Job'}</div>
            <div class="form-grid two">
              <label class="form-field">
                <span class="form-label">Job ID</span>
                <input value={form.id} onInput={(e) => setForm(f => ({ ...f, id: (e.target as HTMLInputElement).value }))} placeholder="morning_digest" />
              </label>
              <label class="form-field">
                <span class="form-label">Job name</span>
                <input value={form.name} onInput={(e) => setForm(f => ({ ...f, name: (e.target as HTMLInputElement).value }))} placeholder="Morning Digest" />
              </label>
              <label class="form-field">
                <span class="form-label">Cron expression</span>
                <input value={form.scheduleExpr} onInput={(e) => setForm(f => ({ ...f, scheduleExpr: (e.target as HTMLInputElement).value }))} placeholder="*/30 * * * *" />
              </label>
              <label class="form-field">
                <span class="form-label">Timezone</span>
                <input value={form.tz} onInput={(e) => setForm(f => ({ ...f, tz: (e.target as HTMLInputElement).value }))} placeholder="America/Chicago" />
              </label>
              <label class="form-field">
                <span class="form-label">Model override</span>
                <input value={form.model} onInput={(e) => setForm(f => ({ ...f, model: (e.target as HTMLInputElement).value }))} placeholder="optional" />
              </label>
              <label class="form-field">
                <span class="form-label">Payload kind</span>
                <select value={form.payloadKind} onChange={(e) => setForm(f => ({ ...f, payloadKind: (e.target as HTMLSelectElement).value }))}>
                  <option value="agentTurn">agentTurn</option>
                  <option value="script">script</option>
                  <option value="http">http</option>
                </select>
              </label>
            </div>

            {form.payloadKind === 'agentTurn' && (
              <label class="form-field" style={{ marginTop: 10 }}>
                <span class="form-label">Agent prompt</span>
                {promptSourcePath && (
                  <span class="form-help">Loaded from {promptSourcePath}</span>
                )}
                <textarea value={form.message} onInput={(e) => setForm(f => ({ ...f, message: (e.target as HTMLTextAreaElement).value }))} placeholder="Message prompt" style={{ minHeight: 120 }} />
              </label>
            )}
            {form.payloadKind === 'script' && (
              <>
                <label class="form-field" style={{ marginTop: 10 }}>
                  <span class="form-label">Script</span>
                  <textarea value={form.script} onInput={(e) => setForm(f => ({ ...f, script: (e.target as HTMLTextAreaElement).value }))} placeholder="Shell script" style={{ minHeight: 120 }} />
                </label>
                <div class="form-grid two" style={{ marginTop: 10 }}>
                  <label class="form-field">
                    <span class="form-label">Working directory</span>
                    <input value={form.cwd} onInput={(e) => setForm(f => ({ ...f, cwd: (e.target as HTMLInputElement).value }))} placeholder="optional" />
                  </label>
                  <label class="form-field">
                    <span class="form-label">Timeout ms</span>
                    <input value={form.timeoutMs} onInput={(e) => setForm(f => ({ ...f, timeoutMs: (e.target as HTMLInputElement).value }))} placeholder="optional" />
                  </label>
                </div>
              </>
            )}
            {form.payloadKind === 'http' && (
              <label class="form-field" style={{ marginTop: 10 }}>
                <span class="form-label">URL</span>
                <input value={form.url} onInput={(e) => setForm(f => ({ ...f, url: (e.target as HTMLInputElement).value }))} placeholder="https://..." />
              </label>
            )}

            <label class="form-checkbox" style={{ marginTop: 10 }}>
              <input type="checkbox" checked={form.sendAsVoice} onChange={(e) => setForm(f => ({ ...f, sendAsVoice: (e.target as HTMLInputElement).checked }))} />
              Send output as voice
            </label>

            <div class="form-actions">
              {selected && (
                <button class="btn btn-sm" disabled={running.has(selected)} onClick={() => trigger(selected)}>
                  {running.has(selected) ? 'Running…' : 'Run now'}
                </button>
              )}
              <button class="btn btn-sm btn-primary" onClick={saveJob} disabled={saving}>
                {saving ? 'Saving…' : 'Save Job'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
