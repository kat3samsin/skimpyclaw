import { useState, useEffect } from 'preact/hooks';
import { getTemplates, getTemplate, saveTemplate } from '../api/client.js';
import type { TemplateListItem } from '../types.js';
import { LuFileText } from 'react-icons/lu';
import { MarkdownView } from '../components/MarkdownView.js';

interface TemplatesProps {
  showToast: (msg: string, type?: 'success' | 'error' | 'warning') => void;
}

const DEFAULT_AGENT = 'main';

export function Templates({ showToast }: TemplatesProps) {
  const [templates, setTemplates] = useState<TemplateListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<'edit' | 'markdown'>('edit');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await getTemplates(DEFAULT_AGENT);
      setTemplates(data.templates ?? []);
    } catch (e) {
      console.error('[templates] load failed', e);
    } finally {
      setLoading(false);
    }
  }

  async function select(name: string) {
    setSelected(name);
    setView(name.toLowerCase().endsWith('.md') ? 'markdown' : 'edit');
    setFileLoading(true);
    try {
      const data = await getTemplate(DEFAULT_AGENT, name);
      setContent(data.content ?? '');
    } catch (e) {
      console.error('[templates] file load failed', e);
      setContent('');
    } finally {
      setFileLoading(false);
    }
  }

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      await saveTemplate(DEFAULT_AGENT, selected, content);
      showToast('Template saved', 'success');
    } catch {
      showToast('Failed to save template', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div class="page-header">
        <div class="page-title">Templates</div>
        <div class="header-actions">
          {selected && (
            <>
              <button class={`btn btn-sm${view === 'edit' ? ' btn-primary' : ''}`} onClick={() => setView('edit')}>Edit</button>
              <button class={`btn btn-sm${view === 'markdown' ? ' btn-primary' : ''}`} onClick={() => setView('markdown')}>Markdown</button>
            </>
          )}
          {selected && (
            <button class="btn btn-sm btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          <button class="btn btn-sm" onClick={load}>Refresh</button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
          <div class="spinner" />
        </div>
      ) : templates.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state-icon"><LuFileText size={18} /></div>
          <div class="empty-state-text">No templates found</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20 }}>
          <div class="feed-card" style={{ height: 'fit-content', overflow: 'hidden' }}>
              <div class="feed">
              {templates.map(template => (
                <button
                  key={template.name}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '12px 16px',
                    border: 'none',
                    borderBottom: '1px solid var(--border-light)',
                    background: selected === template.name ? 'var(--accent-soft)' : 'transparent',
                    cursor: 'pointer',
                    fontFamily: 'var(--mono)',
                    fontSize: 13,
                    color: selected === template.name ? 'var(--accent)' : 'var(--text-dim)',
                    fontWeight: selected === template.name ? 600 : 400,
                  }}
                  onClick={() => select(template.name)}
                >
                  {template.name}
                </button>
              ))}
            </div>
          </div>

          <div class="feed-card" style={{ padding: '20px 24px' }}>
            {!selected ? (
              <div class="empty-state" style={{ padding: '32px 0' }}>
                <div class="empty-state-text">Select a template to edit</div>
              </div>
            ) : fileLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '32px' }}>
                <div class="spinner" />
              </div>
            ) : view === 'markdown' ? (
              <MarkdownView content={content} />
            ) : (
              <textarea
                value={content}
                onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
                spellcheck={false}
                style={{
                  width: '100%',
                  minHeight: 480,
                  fontFamily: 'var(--mono)',
                  fontSize: 13,
                  lineHeight: 1.6,
                  padding: '16px',
                  background: 'var(--surface-alt)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  resize: 'vertical',
                  outline: 'none',
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
