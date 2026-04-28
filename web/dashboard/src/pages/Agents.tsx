import { useEffect, useMemo, useState } from 'preact/hooks';
import { LuBot, LuPlus, LuRefreshCw, LuSave, LuTrash2 } from 'react-icons/lu';
import {
  createAgentProfile,
  deleteAgentProfile,
  getAgentProfiles,
  updateAgentProfile,
} from '../api/client.js';
import type { AgentProfile, AgentProfilesResponse, ThinkingLevel } from '../types.js';

interface AgentsProps {
  showToast: (msg: string, type?: 'success' | 'error' | 'warning') => void;
}

interface FormState {
  alias: string;
  agentId: string;
  model: string;
  thinking: '' | ThinkingLevel;
  promptOverlay: string;
}

const EMPTY_FORM: FormState = {
  alias: '',
  agentId: '',
  model: '',
  thinking: '',
  promptOverlay: '',
};

const THINKING_OPTIONS: Array<'' | ThinkingLevel> = ['', 'none', 'low', 'medium', 'high', 'xhigh'];

function profileToForm(profile: AgentProfile): FormState {
  return {
    alias: profile.alias,
    agentId: profile.agentId,
    model: profile.model || '',
    thinking: profile.thinking || '',
    promptOverlay: profile.promptOverlay || '',
  };
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function Agents({ showToast }: AgentsProps) {
  const [data, setData] = useState<AgentProfilesResponse | null>(null);
  const [selectedAlias, setSelectedAlias] = useState<string>('');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  const selected = useMemo(
    () => data?.profiles.find(profile => profile.alias === selectedAlias) || null,
    [data, selectedAlias],
  );

  const bindingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const binding of data?.bindings || []) {
      counts.set(binding.profileAlias, (counts.get(binding.profileAlias) || 0) + 1);
    }
    return counts;
  }, [data]);

  async function load(preferredAlias?: string) {
    setLoading(true);
    try {
      const next = await getAgentProfiles();
      setData(next);
      const alias = preferredAlias || selectedAlias || next.profiles[0]?.alias || '';
      setSelectedAlias(alias);
      const profile = next.profiles.find(p => p.alias === alias);
      setForm(profile ? profileToForm(profile) : {
        ...EMPTY_FORM,
        agentId: Object.keys(next.configuredAgents)[0] || '',
      });
      if (!profile && next.profiles.length === 0) setCreating(true);
    } catch {
      showToast('Failed to load agents', 'error');
    } finally {
      setLoading(false);
    }
  }

  function startCreate() {
    const defaultAgentId = Object.keys(data?.configuredAgents || {})[0] || '';
    setCreating(true);
    setSelectedAlias('');
    setForm({ ...EMPTY_FORM, agentId: defaultAgentId });
  }

  async function saveProfile() {
    const alias = form.alias.trim().replace(/^@/, '').toLowerCase();
    const agentId = form.agentId.trim();
    if (!alias || !agentId) return;

    setSaving(true);
    try {
      if (creating) {
        await createAgentProfile(alias, agentId);
      }
      await updateAgentProfile(alias, {
        agentId,
        model: form.model.trim() || undefined,
        thinking: form.thinking || undefined,
        promptOverlay: form.promptOverlay,
      });
      setCreating(false);
      showToast(`Saved @${alias}`, 'success');
      await load(alias);
    } catch {
      showToast('Failed to save agent profile', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function removeProfile(alias: string) {
    if (!window.confirm(`Delete @${alias}?`)) return;
    setSaving(true);
    try {
      await deleteAgentProfile(alias);
      showToast(`Deleted @${alias}`, 'warning');
      setSelectedAlias('');
      await load();
    } catch {
      showToast('Failed to delete agent profile', 'error');
    } finally {
      setSaving(false);
    }
  }

  function selectProfile(profile: AgentProfile) {
    setCreating(false);
    setSelectedAlias(profile.alias);
    setForm(profileToForm(profile));
  }

  const configuredAgents = data?.configuredAgents || {};
  const modelAliases = data?.modelAliases || {};
  const inheritedAgent = configuredAgents[form.agentId];

  return (
    <div>
      <div class="page-header">
        <div class="page-title">Agents</div>
        <div class="header-actions">
          <button class="btn btn-sm" onClick={startCreate}>
            <LuPlus size={14} /> New
          </button>
          <button class="btn-refresh" onClick={() => void load()}>
            <LuRefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
          <div class="spinner" />
        </div>
      ) : (
        <div class="agents-layout">
          <div class="agents-list">
            {(data?.profiles || []).length === 0 ? (
              <div class="empty-state agents-empty">
                <div class="empty-state-icon"><LuBot size={18} /></div>
                <div class="empty-state-text">No agent profiles</div>
              </div>
            ) : (
              data!.profiles.map(profile => {
                const active = profile.alias === selectedAlias && !creating;
                const agent = configuredAgents[profile.agentId];
                return (
                  <button
                    key={profile.alias}
                    class={`agent-profile-item${active ? ' active' : ''}`}
                    onClick={() => selectProfile(profile)}
                  >
                    <span class="agent-profile-icon">{agent?.emoji || '@'}</span>
                    <span class="agent-profile-main">
                      <span class="agent-profile-alias">@{profile.alias}</span>
                      <span class="agent-profile-meta">
                        {profile.agentId} · {profile.model || agent?.model || 'model inherit'}
                      </span>
                    </span>
                    <span class="agent-profile-count">{bindingCounts.get(profile.alias) || 0}</span>
                  </button>
                );
              })
            )}
          </div>

          <div class="agents-editor card">
            <div class="agents-editor-header">
              <div>
                <div class="card-title">{creating ? 'New Profile' : selected ? `@${selected.alias}` : 'Profile'}</div>
                <div class="agent-editor-subtitle">
                  {selected ? `Updated ${formatDate(selected.updatedAt)}` : 'Discord profile'}
                </div>
              </div>
              {selected && !creating ? (
                <button class="btn btn-sm btn-danger" onClick={() => void removeProfile(selected.alias)} disabled={saving}>
                  <LuTrash2 size={13} /> Delete
                </button>
              ) : null}
            </div>

            <div class="form-grid two">
              <label class="form-field">
                <span class="form-label">Alias</span>
                <input
                  value={form.alias}
                  disabled={!creating}
                  onInput={(e) => setForm(f => ({ ...f, alias: (e.target as HTMLInputElement).value }))}
                  placeholder="reviewer"
                />
              </label>
              <label class="form-field">
                <span class="form-label">Configured agent</span>
                <select value={form.agentId} onChange={(e) => setForm(f => ({ ...f, agentId: (e.target as HTMLSelectElement).value }))}>
                  {Object.entries(configuredAgents).map(([id, agent]) => (
                    <option value={id} key={id}>{agent.emoji ? `${agent.emoji} ` : ''}{id}</option>
                  ))}
                </select>
              </label>
            </div>

            <div class="agent-inherit-row">
              <span>{inheritedAgent?.name || form.agentId || 'agent'}</span>
              <code>{inheritedAgent?.model || 'model inherit'}</code>
              <code>{inheritedAgent?.thinking || 'effort inherit'}</code>
            </div>

            <div class="form-grid two">
              <label class="form-field">
                <span class="form-label">Model override</span>
                <input
                  value={form.model}
                  onInput={(e) => setForm(f => ({ ...f, model: (e.target as HTMLInputElement).value }))}
                  placeholder="inherit"
                />
              </label>
              <label class="form-field">
                <span class="form-label">Effort override</span>
                <select value={form.thinking} onChange={(e) => setForm(f => ({ ...f, thinking: (e.target as HTMLSelectElement).value as '' | ThinkingLevel }))}>
                  {THINKING_OPTIONS.map(level => (
                    <option value={level} key={level || 'inherit'}>{level || 'inherit'}</option>
                  ))}
                </select>
              </label>
            </div>

            <div class="agent-model-aliases">
              {Object.entries(modelAliases)
                .sort(([a], [b]) => a.localeCompare(b))
                .slice(0, 14)
                .map(([alias, target]) => (
                  <button
                    class="btn btn-sm"
                    title={target}
                    onClick={() => setForm(f => ({ ...f, model: alias }))}
                    key={alias}
                  >
                    {alias}
                  </button>
                ))}
            </div>

            <label class="form-field">
              <span class="form-label">Prompt overlay</span>
              <textarea
                class="agents-prompt"
                value={form.promptOverlay}
                onInput={(e) => setForm(f => ({ ...f, promptOverlay: (e.target as HTMLTextAreaElement).value }))}
                placeholder="Additional behavior for this profile"
              />
            </label>

            <div class="form-actions">
              <button
                class="btn btn-primary"
                onClick={() => void saveProfile()}
                disabled={saving || !form.alias.trim() || !form.agentId.trim()}
              >
                <LuSave size={14} /> {saving ? 'Saving...' : 'Save Profile'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
