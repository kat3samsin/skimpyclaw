import { useState, useEffect } from 'preact/hooks';
import { getLogFiles, getLogContent } from '../api/client.js';
import type { LogFile } from '../types.js';
import { LuFileText, LuRefreshCw } from 'react-icons/lu';

export function Logs() {
  const [files, setFiles] = useState<LogFile[]>([]);
  const [selected, setSelected] = useState<LogFile | null>(null);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await getLogFiles();
      setFiles(data.files ?? []);
    } catch (e) {
      console.error('[logs] load failed', e);
    } finally {
      setLoading(false);
    }
  }

  async function selectFile(file: LogFile) {
    setSelected(file);
    setFileLoading(true);
    try {
      const data = await getLogContent(`logs/${encodeURIComponent(file.name)}`);
      setContent(data.content ?? '');
    } catch (e) {
      console.error('[logs] file load failed', e);
      setContent('Error loading log file.');
    } finally {
      setFileLoading(false);
    }
  }

  return (
    <div>
      <div class="page-header">
        <div class="page-title">Logs</div>
        <div class="header-actions">
          <button class="btn-refresh" onClick={load}>
            <LuRefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
          <div class="spinner" />
        </div>
      ) : files.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state-icon"><LuFileText size={18} /></div>
          <div class="empty-state-text">No log files found</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 20 }}>
          <div class="feed-card" style={{ height: 'fit-content', overflow: 'hidden' }}>
            <div class="feed">
              {files.map(f => (
                <button
                  key={f.name}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '12px 16px',
                    border: 'none',
                    borderBottom: '1px solid var(--border-light)',
                    background: selected?.name === f.name ? 'var(--accent-soft)' : 'transparent',
                    cursor: 'pointer',
                    fontFamily: 'var(--sans)',
                    color: selected?.name === f.name ? 'var(--accent)' : 'var(--text-dim)',
                  }}
                  onClick={() => selectFile(f)}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{f.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
                    {(f.size / 1024).toFixed(1)} KB
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div class="feed-card" style={{ padding: '20px 24px', maxHeight: '70vh', overflow: 'auto' }}>
            {!selected ? (
              <div class="empty-state" style={{ padding: '32px 0' }}>
                <div class="empty-state-text">Select a log file to view</div>
              </div>
            ) : fileLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '32px' }}>
                <div class="spinner" />
              </div>
            ) : (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6 }}>
                {content.split('\n').map((line, i) => (
                  <div
                    key={i}
                    style={{
                      color: line.toLowerCase().includes('error') ? 'var(--log-error)'
                        : line.toLowerCase().includes('warn') ? 'var(--log-warn)'
                        : 'var(--log-info)',
                      padding: '1px 0',
                    }}
                  >
                    {line || '\u00a0'}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
