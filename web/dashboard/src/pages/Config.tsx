import { useEffect, useState } from 'preact/hooks';
import { getConfig, saveConfig, reloadConfig } from '../api/client.js';

interface ConfigProps {
  showToast: (msg: string, type?: 'success' | 'error' | 'warning') => void;
}

interface ConfigFormState {
  gatewayHost: string;
  gatewayPort: string;
  gatewayMode: 'local' | 'remote';
  activeChannel: '' | 'telegram' | 'discord';
  telegramEnabled: boolean;
  discordEnabled: boolean;
  agentsDefault: string;
  heartbeatIntervalMs: string;
  heartbeatPrompt: string;
  heartbeatModel: string;
}

export function Config({ showToast }: ConfigProps) {
  const [configData, setConfigData] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [form, setForm] = useState<ConfigFormState>({
    gatewayHost: '127.0.0.1',
    gatewayPort: '18790',
    gatewayMode: 'local',
    activeChannel: '',
    telegramEnabled: true,
    discordEnabled: false,
    agentsDefault: 'main',
    heartbeatIntervalMs: '300000',
    heartbeatPrompt: '',
    heartbeatModel: '',
  });

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await getConfig();
      const cfg = (data.config ?? {}) as Record<string, any>;
      setConfigData(cfg);
      setForm({
        gatewayHost: cfg.gateway?.host ?? '127.0.0.1',
        gatewayPort: String(cfg.gateway?.port ?? 18790),
        gatewayMode: cfg.gateway?.mode === 'remote' ? 'remote' : 'local',
        activeChannel: cfg.channels?.active === 'telegram' || cfg.channels?.active === 'discord'
          ? cfg.channels.active
          : '',
        telegramEnabled: Boolean(cfg.channels?.telegram?.enabled),
        discordEnabled: Boolean(cfg.channels?.discord?.enabled),
        agentsDefault: cfg.agents?.default ?? 'main',
        heartbeatIntervalMs: String(cfg.heartbeat?.intervalMs ?? 300000),
        heartbeatPrompt: cfg.heartbeat?.prompt ?? '',
        heartbeatModel: cfg.heartbeat?.model ?? '',
      });
    } catch (e) {
      console.error('[config] load failed', e);
      showToast('Failed to load config', 'error');
    } finally {
      setLoading(false);
    }
  }

  async function reload() {
    setReloading(true);
    try {
      await reloadConfig();
      showToast('Config reloaded', 'success');
      await load();
    } catch (e) {
      console.error('[config] reload failed', e);
      showToast('Reload failed', 'error');
    } finally {
      setReloading(false);
    }
  }

  async function save() {
    if (!configData) return;

    const next = structuredClone(configData);
    next.gateway = next.gateway || {};
    next.channels = next.channels || {};
    next.channels.telegram = next.channels.telegram || {};
    next.channels.discord = next.channels.discord || {};
    next.agents = next.agents || {};
    next.heartbeat = next.heartbeat || {};
    next.cron = next.cron || { jobs: [] };
    next.models = next.models || { providers: {}, aliases: {} };

    next.gateway.host = form.gatewayHost.trim() || '127.0.0.1';
    next.gateway.port = Number(form.gatewayPort) || 18790;
    next.gateway.mode = form.gatewayMode;

    if (form.activeChannel) next.channels.active = form.activeChannel;
    else delete next.channels.active;

    next.channels.telegram.enabled = form.telegramEnabled;
    next.channels.discord.enabled = form.discordEnabled;

    next.agents.default = form.agentsDefault.trim() || 'main';

    next.heartbeat.intervalMs = Number(form.heartbeatIntervalMs) || 300000;
    next.heartbeat.prompt = form.heartbeatPrompt;
    next.heartbeat.model = form.heartbeatModel.trim() || undefined;

    setSaving(true);
    try {
      await saveConfig(next);
      setConfigData(next);
      showToast('Config saved', 'success');
    } catch (e) {
      console.error('[config] save failed', e);
      showToast('Failed to save config', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div class="page-header">
        <div class="page-title">Config</div>
        <div class="header-actions">
          <button class="btn btn-sm" onClick={() => void reload()} disabled={reloading}>
            {reloading ? 'Reloading…' : 'Reload'}
          </button>
          <button class="btn btn-sm btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
          <div class="spinner" />
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          <div class="card">
            <div class="card-title" style={{ fontWeight: 700 }}>Gateway</div>
            <div class="form-grid three">
              <label class="form-field">
                <span class="form-label">Host</span>
                <input value={form.gatewayHost} onInput={(e) => setForm(f => ({ ...f, gatewayHost: (e.target as HTMLInputElement).value }))} placeholder="127.0.0.1" />
              </label>
              <label class="form-field">
                <span class="form-label">Port</span>
                <input value={form.gatewayPort} onInput={(e) => setForm(f => ({ ...f, gatewayPort: (e.target as HTMLInputElement).value }))} placeholder="18790" />
              </label>
              <label class="form-field">
                <span class="form-label">Mode</span>
                <select value={form.gatewayMode} onChange={(e) => setForm(f => ({ ...f, gatewayMode: (e.target as HTMLSelectElement).value as 'local' | 'remote' }))}>
                  <option value="local">local</option>
                  <option value="remote">remote</option>
                </select>
              </label>
            </div>
          </div>

          <div class="card">
            <div class="card-title" style={{ fontWeight: 700 }}>Channels</div>
            <div class="form-grid">
              <label class="form-field">
                <span class="form-label">Active channel</span>
                <select value={form.activeChannel} onChange={(e) => setForm(f => ({ ...f, activeChannel: (e.target as HTMLSelectElement).value as '' | 'telegram' | 'discord' }))}>
                  <option value="">auto</option>
                  <option value="telegram">telegram</option>
                  <option value="discord">discord</option>
                </select>
              </label>
              <div class="form-check-row">
                <label class="form-checkbox">
                  <input type="checkbox" checked={form.telegramEnabled} onChange={(e) => setForm(f => ({ ...f, telegramEnabled: (e.target as HTMLInputElement).checked }))} />
                  Telegram enabled
                </label>
                <label class="form-checkbox">
                  <input type="checkbox" checked={form.discordEnabled} onChange={(e) => setForm(f => ({ ...f, discordEnabled: (e.target as HTMLInputElement).checked }))} />
                  Discord enabled
                </label>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-title" style={{ fontWeight: 700 }}>Agent</div>
            <div class="form-grid">
              <label class="form-field">
                <span class="form-label">Default agent</span>
                <input value={form.agentsDefault} onInput={(e) => setForm(f => ({ ...f, agentsDefault: (e.target as HTMLInputElement).value }))} placeholder="main" />
              </label>
            </div>
          </div>

          <div class="card">
            <div class="card-title" style={{ fontWeight: 700 }}>Heartbeat</div>
            <div class="form-grid two" style={{ marginBottom: 10 }}>
              <label class="form-field">
                <span class="form-label">Interval (ms)</span>
                <input value={form.heartbeatIntervalMs} onInput={(e) => setForm(f => ({ ...f, heartbeatIntervalMs: (e.target as HTMLInputElement).value }))} placeholder="300000" />
              </label>
              <label class="form-field">
                <span class="form-label">Model override</span>
                <input value={form.heartbeatModel} onInput={(e) => setForm(f => ({ ...f, heartbeatModel: (e.target as HTMLInputElement).value }))} placeholder="optional" />
              </label>
            </div>
            <label class="form-field">
              <span class="form-label">Prompt</span>
              <textarea value={form.heartbeatPrompt} onInput={(e) => setForm(f => ({ ...f, heartbeatPrompt: (e.target as HTMLTextAreaElement).value }))} placeholder="Heartbeat prompt" style={{ minHeight: 120 }} />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
