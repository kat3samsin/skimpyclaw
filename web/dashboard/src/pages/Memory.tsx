import { useState, useEffect } from 'preact/hooks';
import { getMemory, getMemoryFile } from '../api/client.js';
import type { MemoryFile } from '../types.js';
import { LuDatabase, LuRefreshCw } from 'react-icons/lu';
import { MarkdownView } from '../components/MarkdownView.js';

const DEFAULT_AGENT = 'main';

export function Memory() {
  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
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
    <div class="templates-page">
      <div class="templates-header">
        <div class="page-title">Memory</div>
        <div class="header-actions" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button class="btn-refresh" onClick={load}>
            <LuRefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div class="templates-loading">
          <div class="spinner" />
        </div>
      ) : files.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state-icon"><LuDatabase size={18} /></div>
          <div class="empty-state-text">No memory files found</div>
        </div>
      ) : (
        <div class="templates-layout">
          <div class="templates-sidebar">
            <div class="templates-list">
              {files.map(f => (
                <button
                  key={f.name}
                  class={`templates-list-item${selected === f.name ? ' active' : ''}`}
                  onClick={() => selectFile(f.name)}
                >
                  <div class="templates-list-icon">
                    {f.name.substring(0, 2).toUpperCase()}
                  </div>
                  <div class="templates-list-content">
                    <div class="templates-list-title">{f.name}</div>
                    <div class="templates-list-meta">{(f.size / 1024).toFixed(1)} KB</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div class="templates-main">
            {!selected ? (
              <div class="templates-empty">
                <LuDatabase size={32} />
                <p>Select a file to view</p>
              </div>
            ) : fileLoading ? (
              <div class="templates-loading">
                <div class="spinner" />
              </div>
            ) : (
              <div class="templates-content">
                <div class="templates-markdown-preview">
                  <MarkdownView content={content} />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
