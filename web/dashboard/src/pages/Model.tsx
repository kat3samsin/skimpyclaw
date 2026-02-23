import { useState, useEffect } from 'preact/hooks';
import { getModel, setModel } from '../api/client.js';

interface ModelProps {
  showToast: (msg: string, type?: 'success' | 'error' | 'warning') => void;
}

const FULL_MODEL_SPEC_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/;
const BARE_MODEL_ID_RE = /^[A-Za-z0-9.-]+$/;
const SAFE_MODEL_INPUT_RE = /^[A-Za-z0-9._/-]+$/;

function validateModelSelection(
  input: string,
  aliases: Record<string, string>
): { ok: true } | { ok: false; error: string } {
  if (aliases[input]) return { ok: true };
  if (FULL_MODEL_SPEC_RE.test(input)) return { ok: true };
  if (BARE_MODEL_ID_RE.test(input) && /[-.]/.test(input)) return { ok: true };
  if (!SAFE_MODEL_INPUT_RE.test(input) || input.includes('/')) {
    return { ok: false, error: `Invalid model selection: "${input}". Use alias, provider/model, or model-id.` };
  }
  return { ok: false, error: `Unknown model alias: "${input}"` };
}

export function Model({ showToast }: ModelProps) {
  const [model, setModelState] = useState('');
  const [input, setInput] = useState('');
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await getModel();
      setModelState(data.current ?? '');
      setInput(data.current ?? '');
      setAliases(data.aliases ?? {});
    } catch (e) {
      console.error('[model] load failed', e);
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    const value = input.trim();
    if (!value) return;
    const validation = validateModelSelection(value, aliases);
    if (!validation.ok) {
      showToast(validation.error, 'error');
      return;
    }

    setSaving(true);
    try {
      const data = await setModel(value);
      setModelState(data.model);
      setInput(data.model);
      showToast('Model updated', 'success');
    } catch {
      showToast('Failed to update model', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div class="page-header">
        <div class="page-title">Model</div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
          <div class="spinner" />
        </div>
      ) : (
        <div style={{ maxWidth: 560 }}>
          <div class="feed-card" style={{ padding: '28px 32px' }}>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Active Model
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 15, color: 'var(--accent)', fontWeight: 600 }}>
                {model || '—'}
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Switch Model
              </div>
              <input
                type="text"
                value={input}
                onInput={(e) => setInput((e.target as HTMLInputElement).value)}
                placeholder="Model ID or alias"
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  background: 'var(--surface-alt)',
                  color: 'var(--text)',
                  fontFamily: 'var(--mono)',
                  fontSize: 14,
                  marginBottom: 14,
                  outline: 'none',
                }}
              />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                {Object.entries(aliases)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([alias, target]) => (
                    <button
                      key={alias}
                      class={`btn btn-sm${input === alias ? ' btn-primary' : ''}`}
                      onClick={() => setInput(alias)}
                      title={target}
                    >
                      {alias}
                    </button>
                  ))}
              </div>
              <button class="btn btn-primary" onClick={save} disabled={saving || !input.trim()}>
                {saving ? 'Saving…' : 'Switch Model'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
