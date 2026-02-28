import { useState, useEffect } from 'preact/hooks';
import { getHealth, getDoctor } from '../api/client.js';
import type { HealthResponse, DoctorResponse, HealthCheck, DoctorCheck } from '../types.js';
import { LuCheck, LuCircleDot, LuHeartPulse, LuTriangle, LuX } from 'react-icons/lu';

export function Health() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [doctor, setDoctor] = useState<DoctorResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [rechecking, setRechecking] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [h, d] = await Promise.all([getHealth(), getDoctor()]);
      setHealth(h);
      setDoctor(d);
    } catch (e) {
      console.error('[health] load failed', e);
    } finally {
      setLoading(false);
    }
  }

  async function recheck() {
    setRechecking(true);
    try {
      const [h, d] = await Promise.all([getHealth(), getDoctor()]);
      setHealth(h);
      setDoctor(d);
    } catch (e) {
      console.error('[health] recheck failed', e);
    } finally {
      setRechecking(false);
    }
  }

  function checkIcon(status: HealthCheck['status']): string {
    if (status === 'ok') return 'ok';
    if (status === 'warn') return 'warn';
    return 'error';
  }

  function checkColor(status: HealthCheck['status']): string {
    if (status === 'ok') return 'var(--success)';
    if (status === 'warn') return 'var(--warning)';
    return 'var(--error)';
  }

  function normalizeCheck(c: HealthCheck | DoctorCheck): HealthCheck {
    if ('status' in c && c.status) {
      return c;
    }
    if ('ok' in c) {
      return {
        name: c.name,
        status: c.ok ? 'ok' : (c.fatal ? 'error' : 'warn'),
        message: c.detail || c.remedy,
      };
    }
    return { name: c.name, status: 'error' };
  }

  const rawChecks = doctor?.report?.checks ?? health?.checks ?? [];
  const checks: HealthCheck[] = rawChecks.map((c) => normalizeCheck(c));
  const errorCount = checks.filter(c => c.status === 'error').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const okCount = checks.filter(c => c.status === 'ok').length;

  return (
    <div>
      <div class="page-header">
        <div class="page-title">Health</div>
        <div class="header-actions">
          <button class="btn btn-sm" id="healthRecheckBtn" onClick={recheck} disabled={rechecking || loading}>
            {rechecking ? 'Checking…' : 'Recheck'}
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
          <div class="spinner" />
        </div>
      ) : (
        <div>
          {/* Status summary */}
          <div class="stats-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 28 }}>
            <div class="stat-card">
              <div class="stat-icon green"><LuCircleDot size={16} /></div>
              <div class="stat-label">System</div>
              <div class="stat-value">{health?.ok ? 'OK' : 'Issue'}</div>
              <div class="stat-sub">{checks.length} checks</div>
            </div>
            <div class="stat-card">
              <div class="stat-icon sage"><LuCheck size={16} /></div>
              <div class="stat-label">Checks Passing</div>
              <div class="stat-value" style={{ color: 'var(--success)' }}>{okCount}</div>
              <div class="stat-sub">out of {checks.length}</div>
            </div>
            <div class="stat-card">
              <div class="stat-icon" style={{ background: errorCount > 0 ? 'var(--error-soft)' : warnCount > 0 ? 'var(--warning-soft)' : 'var(--success-soft)', color: errorCount > 0 ? 'var(--error)' : warnCount > 0 ? 'var(--warning)' : 'var(--success)' }}>
                {errorCount > 0 ? <LuX size={16} /> : warnCount > 0 ? <LuTriangle size={16} /> : <LuCheck size={16} />}
              </div>
              <div class="stat-label">Issues</div>
              <div class="stat-value" style={{ color: errorCount > 0 ? 'var(--error)' : warnCount > 0 ? 'var(--warning)' : 'var(--success)' }}>
                {errorCount + warnCount}
              </div>
              <div class="stat-sub">{errorCount} errors, {warnCount} warnings</div>
            </div>
          </div>

          {/* Doctor checks */}
          <div id="doctorSummary">
            <div class="section-header" style={{ marginBottom: 16 }}>
              <div class="section-title">Diagnostics</div>
              <div class="header-meta" id="doctorTimestamp">
                {new Date().toLocaleTimeString()}
              </div>
            </div>
            <div id="doctorCategories">
              {checks.length === 0 ? (
                <div class="empty-state">
                  <div class="empty-state-icon"><LuHeartPulse size={18} /></div>
                  <div class="empty-state-text">No diagnostics available</div>
                </div>
              ) : (
                <div class="feed-card">
                  <div class="feed">
                    {checks.map((c, i) => (
                      <div key={i} class="feed-item">
                        <div style={{
                          width: 32, height: 32,
                          borderRadius: 'var(--radius-sm)',
                          background: checkColor(c.status) + '18',
                          color: checkColor(c.status),
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontWeight: 700, fontSize: 14, flexShrink: 0,
                        }}>
                          {checkIcon(c.status) === 'ok'
                            ? <LuCheck size={14} />
                            : checkIcon(c.status) === 'warn'
                              ? <LuTriangle size={14} />
                              : <LuX size={14} />}
                        </div>
                        <div>
                          <div class="feed-title">{c.name}</div>
                          {c.message && <div class="feed-detail">{c.message}</div>}
                        </div>
                        <div style={{ fontSize: 12, color: checkColor(c.status), fontWeight: 600, fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>
                          {c.status}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Env vars placeholder — keeps element ID for parity */}
          <div id="healthEnvVars" style={{ display: 'none' }} />
          <div id="healthFeatures" style={{ display: 'none' }} />
        </div>
      )}
    </div>
  );
}
