import { useState, useEffect } from 'preact/hooks';
import { getMemory, getMemoryFile } from '../api/client.js';
import type { MemoryFile } from '../types.js';
import { LuDatabase } from 'react-icons/lu';
import { MarkdownView } from '../components/MarkdownView.js';

const DEFAULT_AGENT = 'main';

export function Memory() {
  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [view, setView] = useState<'raw' | 'markdown'>('raw');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await getMemory(DEFAULT_AGENT);
      setFiles(data.files ?? []);
    } catch (e) {
      console.error('[memory] load failed', e);
    } finally {
      setLoading(false);
    }
  }

  async function selectFile(filename: string) {
    setSelected(filename);
    setView(filename.toLowerCase().endsWith('.md') ? 'markdown' : 'raw');
    setFileLoading(true);
    try {
      const data = await getMemoryFile(DEFAULT_AGENT, filename);
      setContent(data.content ?? '');
    } catch (e) {
      console.error('[memory] file load failed', e);
      setContent('');
    } finally {
      setFileLoading(false);
    }
  }

  return (
    <div>
      <div class="page-header">
        <div class="page-title">Memory</div>
        <div class="header-actions">
          {selected && (
            <>
              <button class={`btn btn-sm${view === 'raw' ? ' btn-primary' : ''}`} onClick={() => setView('raw')}>Raw</button>
              <button class={`btn btn-sm${view === 'markdown' ? ' btn-primary' : ''}`} onClick={() => setView('markdown')}>Markdown</button>
            </>
          )}
          <button class="btn btn-sm" onClick={load}>Refresh</button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
          <div class="spinner" />
        </div>
      ) : files.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state-icon"><LuDatabase size={18} /></div>
          <div class="empty-state-text">No memory files found</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 20 }}>
          <div class="feed-card" style={{ overflow: 'hidden', height: 'fit-content' }}>
            <div class="feed">
              {files.map(f => (
                <button
                  key={f.name}
                  class={`feed-item${selected === f.name ? ' active' : ''}`}
                  style={{ cursor: 'pointer', background: selected === f.name ? 'var(--accent-soft)' : undefined, border: 'none', width: '100%', textAlign: 'left', fontFamily: 'var(--sans)', borderBottom: '1px solid var(--border-light)' }}
                  onClick={() => selectFile(f.name)}
                >
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div class="feed-title" style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{f.name}</div>
                    <div class="feed-detail">{(f.size / 1024).toFixed(1)} KB</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div class="feed-card" style={{ padding: 24 }}>
            {!selected ? (
              <div class="empty-state" style={{ padding: '32px 0' }}>
                <div class="empty-state-text">Select a file to view</div>
              </div>
            ) : fileLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '32px' }}>
                <div class="spinner" />
              </div>
            ) : view === 'markdown' ? (
              <MarkdownView content={content} />
            ) : (
              <pre style={{
                fontFamily: 'var(--mono)',
                fontSize: 13,
                lineHeight: 1.6,
                color: 'var(--text-dim)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                margin: 0,
              }}>
                {content}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
