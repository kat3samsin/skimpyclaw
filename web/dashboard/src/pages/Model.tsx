import { useState, useEffect } from 'preact/hooks';
import { getModel, setModel } from '../api/client.js';

interface ModelProps {
  showToast: (msg: string, type?: 'success' | 'error' | 'warning') => void;
}

const PRESET_MODELS = [
  'claude-sonnet-4-5',
  'claude-opus-4',
  'claude-haiku-4-5',
  'claude-fast',
  'claude-think',
  'claude-opus',
  'codex5.3',
];

export function Model({ showToast }: ModelProps) {
  const [model, setModelState] = useState('');
  const [input, setInput] = useState('');
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
    } catch (e) {
      console.error('[model] load failed', e);
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!input.trim()) return;
    setSaving(true);
    try {
      await setModel(input.trim());
      setModelState(input.trim());
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
                {PRESET_MODELS.map(m => (
                  <button
                    key={m}
                    class={`btn btn-sm${input === m ? ' btn-primary' : ''}`}
                    onClick={() => setInput(m)}
                  >
                    {m}
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
