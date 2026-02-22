import { useState, useEffect } from 'preact/hooks';
import { getTemplates, getTemplate, saveTemplate } from '../api/client.js';
import type { TemplateListItem } from '../types.js';
import { LuFileText, LuRefreshCw } from 'react-icons/lu';
import { MarkdownView } from '../components/MarkdownView.js';

interface TemplatesProps {
  showToast: (msg: string, type?: 'success' | 'error' | 'warning') => void;
}

const DEFAULT_AGENT = 'main';

export function Templates({ showToast }: TemplatesProps) {
  const [templates, setTemplates] = useState<TemplateListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<'edit' | 'preview'>('edit');

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
    setView(name.toLowerCase().endsWith('.md') ? 'preview' : 'edit');
    setFileLoading(true);
    try {
      const data = await getTemplate(DEFAULT_AGENT, name);
      const fileContent = data.content ?? '';
      setContent(fileContent);
      setOriginalContent(fileContent);
    } catch (e) {
      console.error('[templates] file load failed', e);
      setContent('');
      setOriginalContent('');
    } finally {
      setFileLoading(false);
    }
  }

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      await saveTemplate(DEFAULT_AGENT, selected, content);
      setOriginalContent(content);
      showToast('Template saved', 'success');
    } catch {
      showToast('Failed to save template', 'error');
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setContent(originalContent);
  }

  const hasUnsavedChanges = content !== originalContent;
  const selectedTemplate = templates.find(t => t.name === selected);

  return (
    <div class="templates-page">
      <div class="templates-header">
        <div class="page-title">Templates</div>
        <button class="btn-refresh" onClick={load}>
          <LuRefreshCw size={14} /> Refresh
        </button>
      </div>

      {loading ? (
        <div class="templates-loading">
          <div class="spinner" />
        </div>
      ) : templates.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state-icon"><LuFileText size={18} /></div>
          <div class="empty-state-text">No templates found</div>
        </div>
      ) : (
        <div class="templates-layout">
          {/* Left sidebar */}
          <div class="templates-sidebar">
            <div class="templates-sidebar-header">
              <div class="templates-sidebar-label">Agent Templates</div>
              <select class="templates-agent-select" value={DEFAULT_AGENT} disabled>
                <option value="main">main</option>
              </select>
            </div>
            <div class="templates-list">
              {templates.map(template => (
                <button
                  key={template.name}
                  class={`templates-list-item${selected === template.name ? ' active' : ''}`}
                  onClick={() => select(template.name)}
                >
                  <div class="templates-list-icon">
                    {template.name.substring(0, 2).toUpperCase()}
                  </div>
                  <div class="templates-list-content">
                    <div class="templates-list-title">{template.name}</div>
                    <div class="templates-list-meta">{Math.round((template.size || 0) / 1024)}KB</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Right panel */}
          <div class="templates-main">
            {!selected ? (
              <div class="templates-empty">
                <LuFileText size={32} />
                <p>Select a template to edit</p>
              </div>
            ) : fileLoading ? (
              <div class="templates-loading">
                <div class="spinner" />
              </div>
            ) : (
              <>
                {/* Header row */}
                <div class="templates-editor-header">
                  <div class="templates-editor-title-row">
                    <h2 class="templates-editor-title">{selected}</h2>
                    {hasUnsavedChanges && (
                      <span class="templates-unsaved-pill">Unsaved changes</span>
                    )}
                  </div>
                  <div class="templates-editor-actions">
                    {hasUnsavedChanges && (
                      <button class="templates-discard-btn" onClick={discard}>
                        Discard
                      </button>
                    )}
                    <button
                      class="templates-save-btn"
                      onClick={save}
                      disabled={saving || !hasUnsavedChanges}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>

                {/* Tabs */}
                <div class="templates-tabs">
                  <button
                    class={`templates-tab${view === 'edit' ? ' active' : ''}`}
                    onClick={() => setView('edit')}
                  >
                    Edit
                  </button>
                  <button
                    class={`templates-tab${view === 'preview' ? ' active' : ''}`}
                    onClick={() => setView('preview')}
                  >
                    Preview
                  </button>
                </div>

                {/* Metadata card */}
                {selectedTemplate && (
                  <div class="templates-metadata">
                    <div class="templates-metadata-item">
                      <div class="templates-metadata-label">SIZE</div>
                      <div class="templates-metadata-value">
                        {(selectedTemplate.size || 0) > 1024
                          ? `${Math.round((selectedTemplate.size || 0) / 1024)}KB`
                          : `${selectedTemplate.size || 0}B`}
                      </div>
                    </div>
                    <div class="templates-metadata-item">
                      <div class="templates-metadata-label">LAST EDITED</div>
                      <div class="templates-metadata-value">—</div>
                    </div>
                    <div class="templates-metadata-item">
                      <div class="templates-metadata-label">AGENT</div>
                      <div class="templates-metadata-value">{DEFAULT_AGENT}</div>
                    </div>
                    <div class="templates-metadata-item">
                      <div class="templates-metadata-label">PATH</div>
                      <div class="templates-metadata-value templates-metadata-path">
                        ~/.skimpyclaw/agents/{DEFAULT_AGENT}/{selected}
                      </div>
                    </div>
                  </div>
                )}

                {/* Editor or preview */}
                <div class="templates-content">
                  {view === 'preview' ? (
                    <div class="templates-markdown-preview">
                      <MarkdownView content={content} />
                    </div>
                  ) : (
                    <textarea
                      class="templates-textarea"
                      value={content}
                      onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
                      spellcheck={false}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
