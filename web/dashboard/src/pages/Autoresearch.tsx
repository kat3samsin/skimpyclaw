import { useEffect, useState } from 'preact/hooks';
import { getAutoresearchSessions, createAutoresearchSession, getProjects } from '../api/client.js';
import { LuFlaskConical, LuPlay, LuPlus, LuRefreshCw } from 'react-icons/lu';

interface ExperimentResult {
  run: number;
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: 'keep' | 'discard' | 'crash' | 'checks_failed';
  description: string;
  timestamp: number;
}

interface SessionConfig {
  name: string;
  metricName: string;
  metricUnit: string;
  bestDirection: 'lower' | 'higher';
}

interface Session {
  project: string;
  config: SessionConfig;
  results: ExperimentResult[];
  agentId?: string;
  agentStatus?: string;
}

interface AutoresearchProps {
  showToast: (msg: string, type?: 'success' | 'error' | 'warning') => void;
}

// ── SVG Chart ──────────────────────────────────────────────────────

function MetricChart({ results, config }: { results: ExperimentResult[]; config: SessionConfig }) {
  const kept = results.filter(r => r.status === 'keep' && r.metric > 0);
  if (kept.length < 2) {
    return (
      <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>
        {results.length === 0
          ? 'No experiments yet — waiting for agent to start...'
          : 'Need at least 2 kept results to show chart'}
      </div>
    );
  }

  const W = 600, H = 200, PAD = 40;
  const metrics = kept.map(r => r.metric);
  const min = Math.min(...metrics);
  const max = Math.max(...metrics);
  const range = max - min || 1;

  const points = kept.map((r, i) => {
    const x = PAD + (i / (kept.length - 1)) * (W - PAD * 2);
    const y = PAD + (1 - (r.metric - min) / range) * (H - PAD * 2);
    return { x, y, r };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');

  const baseline = metrics[0];
  const best = config.bestDirection === 'lower' ? Math.min(...metrics) : Math.max(...metrics);
  const bestPct = baseline !== 0 ? ((best - baseline) / baseline * 100).toFixed(1) : '0';
  const improved = config.bestDirection === 'lower' ? best < baseline : best > baseline;

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
        <div class="stat-card" style={{ flex: '1 1 120px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Baseline</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{formatNum(baseline)}{config.metricUnit}</div>
        </div>
        <div class="stat-card" style={{ flex: '1 1 120px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Best</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: improved ? 'var(--success)' : 'var(--text)' }}>
            {formatNum(best)}{config.metricUnit}
          </div>
        </div>
        <div class="stat-card" style={{ flex: '1 1 120px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Improvement</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: improved ? 'var(--success)' : 'var(--error)' }}>
            {improved ? '' : '+'}{bestPct}%
          </div>
        </div>
        <div class="stat-card" style={{ flex: '1 1 120px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Experiments</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{results.length}</div>
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, height: 'auto', background: 'var(--surface-alt)', borderRadius: 'var(--radius-sm)' }}>
        <text x={PAD - 4} y={PAD} fill="var(--text-muted)" fontSize="10" textAnchor="end" dominantBaseline="middle">{formatNum(max)}</text>
        <text x={PAD - 4} y={H - PAD} fill="var(--text-muted)" fontSize="10" textAnchor="end" dominantBaseline="middle">{formatNum(min)}</text>
        <line x1={PAD} y1={PAD} x2={W - PAD} y2={PAD} stroke="var(--border)" strokeWidth="0.5" />
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--border)" strokeWidth="0.5" />
        {(() => {
          const baseY = PAD + (1 - (baseline - min) / range) * (H - PAD * 2);
          return <line x1={PAD} y1={baseY} x2={W - PAD} y2={baseY} stroke="var(--text-muted)" strokeWidth="1" strokeDasharray="4,4" />;
        })()}
        <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="4" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2">
            <title>#{p.r.run}: {formatNum(p.r.metric)}{config.metricUnit} — {p.r.description}</title>
          </circle>
        ))}
        <text x={W / 2} y={H - 6} fill="var(--text-muted)" fontSize="10" textAnchor="middle">Experiment #</text>
        <text x={10} y={H / 2} fill="var(--text-muted)" fontSize="10" textAnchor="middle" transform={`rotate(-90, 10, ${H / 2})`}>{config.metricName}</text>
      </svg>
    </div>
  );
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toFixed(2);
}

function statusColor(status: string): string {
  if (status === 'keep') return 'var(--success)';
  if (status === 'crash' || status === 'checks_failed') return 'var(--error)';
  return 'var(--warning)';
}

function statusIcon(status: string): string {
  if (status === 'keep') return '✓';
  if (status === 'crash') return '✗';
  if (status === 'checks_failed') return '⚠';
  return '–';
}

// ── Setup Wizard ──────────────────────────────────────────────────

function SetupWizard({ onCreated, showToast, projects }: {
  onCreated: () => void;
  showToast: AutoresearchProps['showToast'];
  projects: Record<string, string>;
}) {
  const [step, setStep] = useState(0);
  const [project, setProject] = useState('');
  const [goal, setGoal] = useState('');
  const [howToMeasure, setHowToMeasure] = useState('');
  const [constraints, setConstraints] = useState('');
  const [creating, setCreating] = useState(false);

  const projectEntries = Object.entries(projects);

  const steps = [
    {
      title: 'What do you want to improve?',
      subtitle: 'Pick the project and describe your optimization goal.',
    },
    {
      title: 'How should we measure it?',
      subtitle: 'Describe how to test and score the result. The agent will figure out the commands.',
    },
    {
      title: 'What must still work?',
      subtitle: 'Describe quality gates — tests, builds, or constraints that must pass.',
    },
  ];

  async function submit() {
    if (!project || !goal || !howToMeasure) {
      showToast('Fill in the goal and how to measure it', 'warning');
      return;
    }
    setCreating(true);
    try {
      await createAutoresearchSession({ project, goal, howToMeasure, constraints });
      showToast('Autoresearch session created! Agent is starting...', 'success');
      onCreated();
    } catch (err) {
      showToast(`Failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ maxWidth: 560 }}>
      {/* Progress bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24 }}>
        {steps.map((_, i) => (
          <div key={i} style={{
            flex: 1,
            height: 4,
            borderRadius: 2,
            background: i <= step ? 'var(--accent)' : 'var(--border)',
            transition: 'background 0.2s',
          }} />
        ))}
      </div>

      <h3 style={{ margin: '0 0 4px' }}>{steps[step].title}</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 20px' }}>{steps[step].subtitle}</p>

      {step === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 600 }}>
            Project <span style={{ color: 'var(--error)' }}>*</span>
            {projectEntries.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                {projectEntries.map(([name, path]) => (
                  <button
                    key={name}
                    class={`btn ${project === path ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setProject(path)}
                    style={{ textAlign: 'left', padding: '10px 14px' }}
                  >
                    <div style={{ fontWeight: 600 }}>{name}</div>
                    <div style={{ fontSize: 11, opacity: 0.7, fontFamily: 'var(--mono)' }}>{path}</div>
                  </button>
                ))}
              </div>
            ) : (
              <input
                type="text"
                value={project}
                onInput={(e) => setProject((e.target as HTMLInputElement).value)}
                placeholder="/path/to/project"
                class="input"
                style={{ marginTop: 4 }}
              />
            )}
          </label>
          <label style={{ fontSize: 13, fontWeight: 600 }}>
            What do you want to improve? <span style={{ color: 'var(--error)' }}>*</span>
            <textarea
              value={goal}
              onInput={(e) => setGoal((e.target as HTMLTextAreaElement).value)}
              placeholder="e.g. Make the test suite run faster&#10;e.g. Reduce the bundle size&#10;e.g. Improve the Lighthouse performance score"
              class="input"
              rows={3}
              style={{ marginTop: 4, resize: 'vertical' }}
            />
          </label>
        </div>
      )}

      {step === 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 600 }}>
            How should we test and score it? <span style={{ color: 'var(--error)' }}>*</span>
            <textarea
              value={howToMeasure}
              onInput={(e) => setHowToMeasure((e.target as HTMLTextAreaElement).value)}
              placeholder="e.g. Run pnpm test and measure wall-clock time in seconds&#10;e.g. Build the project and check the output bundle size in KB&#10;e.g. Run Lighthouse on localhost:3000 and use the performance score"
              class="input"
              rows={4}
              style={{ marginTop: 4, resize: 'vertical' }}
            />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Describe it naturally — the agent will write the benchmark script.
            </div>
          </label>
        </div>
      )}

      {step === 2 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 600 }}>
            What must still work?
            <textarea
              value={constraints}
              onInput={(e) => setConstraints((e.target as HTMLTextAreaElement).value)}
              placeholder="e.g. All tests must still pass&#10;e.g. The build must succeed and TypeScript must have no errors&#10;e.g. No new dependencies allowed"
              class="input"
              rows={4}
              style={{ marginTop: 4, resize: 'vertical' }}
            />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Optional — the agent will create quality checks from this.
            </div>
          </label>

          {/* Summary */}
          <div style={{ background: 'var(--surface-alt)', borderRadius: 'var(--radius-sm)', padding: 16, fontSize: 13 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>The agent will:</div>
            <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8 }}>
              <li>Read the project source to understand the codebase</li>
              <li>Write a benchmark script based on your measurement description</li>
              {constraints && <li>Write quality checks based on your constraints</li>}
              <li>Run a baseline measurement</li>
              <li>Start the experiment loop — try ideas, keep what improves, discard what doesn't</li>
            </ol>
          </div>

          <div style={{ background: 'var(--surface-alt)', borderRadius: 'var(--radius-sm)', padding: 16, fontSize: 13 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Summary</div>
            <div><strong>Project:</strong> {project.split('/').pop() || project}</div>
            <div><strong>Goal:</strong> {goal || '—'}</div>
            <div><strong>Measure:</strong> {howToMeasure || '—'}</div>
            {constraints && <div><strong>Constraints:</strong> {constraints}</div>}
          </div>
        </div>
      )}

      {/* Nav buttons */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
        <button class="btn btn-secondary" onClick={() => step > 0 ? setStep(step - 1) : null} disabled={step === 0}>
          Back
        </button>
        {step < steps.length - 1 ? (
          <button class="btn btn-primary" onClick={() => setStep(step + 1)}>
            Next
          </button>
        ) : (
          <button class="btn btn-primary" onClick={submit} disabled={creating}>
            <LuPlay size={14} />
            {creating ? 'Starting agent...' : 'Start Experiment'}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Results Table ────────────────────────────────────────────────

function ResultsTable({ results, config }: { results: ExperimentResult[]; config: SessionConfig }) {
  const baseline = results.length > 0 ? results[0].metric : 0;

  return (
    <div style={{ overflowX: 'auto' }}>
      <table class="data-table" style={{ fontSize: 12, width: '100%' }}>
        <thead>
          <tr>
            <th>#</th>
            <th>Commit</th>
            <th>★ {config.metricName}</th>
            <th>Δ</th>
            <th>Status</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => {
            const delta = baseline !== 0 ? ((r.metric - baseline) / baseline * 100).toFixed(1) : '0';
            const isImproved = config.bestDirection === 'lower' ? r.metric < baseline : r.metric > baseline;
            return (
              <tr key={i}>
                <td style={{ color: 'var(--text-muted)' }}>{r.run || i + 1}</td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r.commit || '—'}</td>
                <td style={{ fontWeight: 600 }}>{formatNum(r.metric)}{config.metricUnit}</td>
                <td style={{ color: i === 0 ? 'var(--text-muted)' : isImproved ? 'var(--success)' : 'var(--error)', fontSize: 11 }}>
                  {i === 0 ? 'baseline' : `${Number(delta) > 0 ? '+' : ''}${delta}%`}
                </td>
                <td>
                  <span style={{ color: statusColor(r.status), fontWeight: 600 }}>
                    {statusIcon(r.status)} {r.status}
                  </span>
                </td>
                <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.description}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────

export function Autoresearch({ showToast }: AutoresearchProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const [sessData, projData] = await Promise.all([
        getAutoresearchSessions(),
        getProjects(),
      ]);
      setSessions(sessData.sessions ?? []);
      setProjects(projData.projects ?? {});
      if ((sessData.sessions ?? []).length === 0) setShowWizard(true);
    } catch {
      showToast('Failed to load autoresearch data', 'error');
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return <div class="page"><div class="page-header"><h2><LuFlaskConical size={20} /> Autoresearch</h2></div><p style={{ color: 'var(--text-muted)' }}>Loading...</p></div>;
  }

  if (showWizard) {
    return (
      <div class="page">
        <div class="page-header">
          <h2><LuFlaskConical size={20} /> New Experiment</h2>
          {sessions.length > 0 && (
            <button class="btn btn-secondary" onClick={() => setShowWizard(false)}>Cancel</button>
          )}
        </div>
        <SetupWizard onCreated={() => { setShowWizard(false); load(); }} showToast={showToast} projects={projects} />
      </div>
    );
  }

  const session = sessions[selectedIdx];

  return (
    <div class="page">
      <div class="page-header">
        <h2><LuFlaskConical size={20} /> Autoresearch</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button class="btn btn-secondary" onClick={load}><LuRefreshCw size={14} /></button>
          <button class="btn btn-primary" onClick={() => setShowWizard(true)}><LuPlus size={14} /> New</button>
        </div>
      </div>

      {/* Session tabs */}
      {sessions.length > 1 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 16, overflowX: 'auto' }}>
          {sessions.map((s, i) => (
            <button
              key={i}
              class={`btn ${i === selectedIdx ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setSelectedIdx(i)}
              style={{ fontSize: 12, whiteSpace: 'nowrap' }}
            >
              {s.config.name}
            </button>
          ))}
        </div>
      )}

      {session && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{session.project}</span>
            {session.agentId && (
              <span style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 'var(--radius-sm)',
                background: session.agentStatus === 'running' ? 'var(--success)' : 'var(--surface-alt)',
                color: session.agentStatus === 'running' ? 'white' : 'var(--text-muted)',
              }}>
                {session.agentId} · {session.agentStatus || 'unknown'}
              </span>
            )}
          </div>

          {/* Chart */}
          <MetricChart results={session.results} config={session.config} />

          {/* Status bar */}
          <div style={{ display: 'flex', gap: 16, margin: '16px 0', fontSize: 13, color: 'var(--text-muted)' }}>
            <span style={{ color: 'var(--success)' }}>{session.results.filter(r => r.status === 'keep').length} kept</span>
            <span style={{ color: 'var(--warning)' }}>{session.results.filter(r => r.status === 'discard').length} discarded</span>
            <span style={{ color: 'var(--error)' }}>{session.results.filter(r => r.status === 'crash' || r.status === 'checks_failed').length} failed</span>
          </div>

          {/* Results table */}
          {session.results.length > 0 && (
            <ResultsTable results={session.results} config={session.config} />
          )}
        </>
      )}
    </div>
  );
}
