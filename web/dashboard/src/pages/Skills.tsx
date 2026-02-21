import { useEffect, useState } from 'preact/hooks';
import { createSkill, deleteSkill, getSkill, getSkills, setSkillEnabled, updateSkillContent } from '../api/client.js';
import type { Skill, SkillResponse } from '../types.js';
import { LuCircleCheck, LuCircleX, LuZap } from 'react-icons/lu';
import { MarkdownView } from '../components/MarkdownView.js';

interface SkillsProps {
  showToast: (msg: string, type?: 'success' | 'error' | 'warning') => void;
}

export function Skills({ showToast }: SkillsProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [newContent, setNewContent] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detailView, setDetailView] = useState<'raw' | 'markdown'>('raw');
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await getSkills();
      setSkills(data.skills ?? []);
    } catch {
      showToast('Failed to load skills', 'error');
    } finally {
      setLoading(false);
    }
  }

  async function openSkill(name: string) {
    setSelected(name);
    setDetailView('markdown');
    setDetailLoading(true);
    try {
      const data = await getSkill(name);
      setDetail(data);
      setEditContent(data.rawContent || data.body || '');
      setEditing(false);
    } catch {
      showToast('Failed to load skill details', 'error');
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }

  async function saveDetail() {
    if (!detail) return;
    setSaving(true);
    try {
      await updateSkillContent(detail.name, editContent);
      showToast('Skill updated', 'success');
      await openSkill(detail.name);
    } catch {
      showToast('Failed to update skill', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(skill: Skill) {
    if (skill.enabled === undefined) return;
    try {
      await setSkillEnabled(skill.name, !skill.enabled);
      showToast(`Skill ${skill.name} ${skill.enabled ? 'disabled' : 'enabled'}`, 'success');
      await load();
      if (selected === skill.name) await openSkill(skill.name);
    } catch {
      showToast('Failed to update skill', 'error');
    }
  }

  async function removeSkill(name: string) {
    try {
      await deleteSkill(name);
      showToast(`Deleted ${name}`, 'warning');
      if (selected === name) {
        setSelected(null);
        setDetail(null);
      }
      await load();
    } catch {
      showToast('Failed to delete skill', 'error');
    }
  }

  async function createNew() {
    const name = newName.trim();
    if (!name || !newContent.trim()) return;
    setSaving(true);
    try {
      await createSkill(name, newContent);
      showToast('Skill created', 'success');
      setNewName('');
      setNewContent('');
      setCreating(false);
      await load();
      await openSkill(name);
    } catch {
      showToast('Failed to create skill', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div class="page-header">
        <div class="page-title">Skills</div>
        <div class="header-actions">
          <button class="btn btn-sm" onClick={() => setCreating(v => !v)}>{creating ? 'Close' : 'New'}</button>
          <button class="btn btn-sm" onClick={load}>Refresh</button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
          <div class="spinner" />
        </div>
      ) : (
        <div>
          {skills.length === 0 ? (
            <div class="empty-state" style={{ padding: '24px 16px' }}>
              <div class="empty-state-icon"><LuZap size={18} /></div>
              <div class="empty-state-text">No skills found</div>
            </div>
          ) : (
            <div class="skills-grid" style={{ marginBottom: 14 }}>
              {skills.map(s => (
                <div key={s.name} class="skill-card">
                  <div class="skill-header">
                    <div class="skill-name">{s.name}</div>
                    <div title={s.eligible ? 'Eligible' : (s.reason || 'Ineligible')}>
                      {s.eligible === false ? <LuCircleX size={16} color="var(--error)" /> : <LuCircleCheck size={16} color="var(--success)" />}
                    </div>
                  </div>
                  <div class="skill-desc">{s.description || 'No description'}</div>
                  {s.tags && s.tags.length > 0 && (
                    <div class="skill-tags">
                      {s.tags.slice(0, 4).map(tag => <span class="skill-tag" key={tag}>{tag}</span>)}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button class="btn btn-sm" onClick={() => void openSkill(s.name)}>View</button>
                    <button class="btn btn-sm" onClick={() => void toggleEnabled(s)}>
                      {s.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button class="btn btn-sm btn-danger" onClick={() => void removeSkill(s.name)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div>
            {creating && (
              <div class="card">
                <div class="card-title" style={{ fontWeight: 700, marginBottom: 10 }}>Create Skill</div>
                <label class="form-field" style={{ marginBottom: 8 }}>
                  <span class="form-label">Skill name</span>
                  <input
                    value={newName}
                    onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
                    placeholder="skill-name"
                  />
                </label>
                <label class="form-field">
                  <span class="form-label">SKILL.md content</span>
                  <textarea
                    value={newContent}
                    onInput={(e) => setNewContent((e.target as HTMLTextAreaElement).value)}
                    placeholder="SKILL.md content"
                    style={{ minHeight: 180 }}
                  />
                </label>
                <div class="form-actions">
                  <button class="btn btn-sm btn-primary" disabled={saving || !newName.trim() || !newContent.trim()} onClick={createNew}>
                    {saving ? 'Creating…' : 'Create'}
                  </button>
                </div>
              </div>
            )}

            <div class="card">
              {!selected ? (
                <div class="empty-state" style={{ padding: '32px 0' }}>
                  <div class="empty-state-icon"><LuZap size={18} /></div>
                  <div class="empty-state-text">Select a skill to inspect</div>
                </div>
              ) : detailLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '32px' }}><div class="spinner" /></div>
              ) : detail ? (
                <>
                  <div class="audit-header">
                    <div style={{ fontWeight: 700 }}>{detail.name}</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button class="btn btn-sm" onClick={() => setDetailView(v => v === 'raw' ? 'markdown' : 'raw')}>
                        {detailView === 'raw' ? 'Markdown' : 'Raw'}
                      </button>
                      <button class="btn btn-sm" onClick={() => {
                        setEditing(v => !v);
                        setEditContent(detail.rawContent || detail.body || '');
                      }}>
                        {editing ? 'Cancel' : 'Edit'}
                      </button>
                      <button class="btn btn-sm" onClick={() => {
                        const s = skills.find(x => x.name === detail.name);
                        if (s) void toggleEnabled(s);
                      }}>Toggle</button>
                      <button class="btn btn-sm btn-danger" onClick={() => void removeSkill(detail.name)}>Delete</button>
                    </div>
                  </div>
                  <div class="audit-summary" style={{ marginBottom: 8 }}>
                    {detail.description || 'No description'}
                  </div>
                  <div class="audit-meta" style={{ marginBottom: 12 }}>
                    <span>Eligible: {detail.eligible ? 'yes' : 'no'}</span>
                    <span>Enabled: {detail.enabled ? 'yes' : 'no'}</span>
                    <span>Priority: {detail.priority ?? 100}</span>
                  </div>
                  {editing ? (
                    <>
                      <label class="form-field">
                        <span class="form-label">Edit SKILL.md</span>
                        <textarea
                          value={editContent}
                          onInput={(e) => setEditContent((e.target as HTMLTextAreaElement).value)}
                          style={{ minHeight: 280 }}
                        />
                      </label>
                      <div class="form-actions">
                        <button class="btn btn-sm btn-primary" onClick={() => void saveDetail()} disabled={saving || !editContent.trim()}>
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                        <button class="btn btn-sm" onClick={() => {
                          setEditing(false);
                          setEditContent(detail.rawContent || detail.body || '');
                        }}>
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : detailView === 'markdown'
                    ? <MarkdownView content={detail.rawContent || detail.body || ''} />
                    : <pre class="ca-output" style={{ marginTop: 0, maxHeight: 420 }}>{detail.rawContent || detail.body || '(empty)'}</pre>}
                </>
              ) : (
                <div class="empty-state" style={{ padding: '32px 0' }}>
                  <div class="empty-state-text">Failed to load skill detail</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
