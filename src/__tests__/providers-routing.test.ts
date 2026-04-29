import { describe, expect, it } from 'vitest';
import { addResponsesApiProvider, chat, initProviders } from '../providers/index.js';

function baseConfig(providers: Record<string, any>): any {
  return {
    gateway: { port: 18790, mode: 'local' },
    agents: { default: 'main', list: { main: { identity: { name: 'bot', emoji: 'x' }, model: 'anthropic/claude-sonnet-4-6' } } },
    models: { providers, aliases: {} },
    channels: { telegram: { enabled: false, token: '', allowFrom: [] }, discord: { enabled: false, token: '', allowFrom: [] } },
    cron: { jobs: [] },
    heartbeat: { intervalMs: 60000, prompt: 'heartbeat' },
  };
}

describe('providers routing errors', () => {
  it('returns a consistent unknown provider error', async () => {
    const cfg = baseConfig({});
    await initProviders(cfg);
    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'unknown-provider/model-x' } as any, cfg)
    ).rejects.toThrow('Unknown provider "unknown-provider" for model: unknown-provider/model-x');
  });

  it('returns codex auth guidance for openai codex alias compatibility route', async () => {
    const cfg = baseConfig({});
    await initProviders(cfg);
    addResponsesApiProvider('codex');

    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'openai/gpt-5.3-codex' } as any, cfg)
    ).rejects.toThrow('Codex provider "openai" is configured but auth is unavailable. Run "codex" to re-authenticate.');
  });
});
