import { describe, expect, it } from 'vitest';
import {
  initProviders,
  hasOpenAIClient,
  addResponsesApiProvider,
  isResponsesApiProvider,
  setUsingOAuth,
  isUsingOAuth,
} from '../providers/index.js';

function baseConfig(providers: Record<string, any>): any {
  return {
    gateway: { port: 18790, mode: 'local' },
    agents: { default: 'main', list: { main: { identity: { name: 'bot', emoji: 'x' }, model: 'openai/gpt-4o' } } },
    models: { providers, aliases: {} },
    channels: { telegram: { enabled: false, token: '', allowFrom: [] }, discord: { enabled: false, token: '', allowFrom: [] } },
    cron: { jobs: [] },
    heartbeat: { intervalMs: 60000, prompt: 'heartbeat' },
  };
}

describe('providers init reset behavior', () => {
  it('clears stale OpenAI clients on re-init', async () => {
    await initProviders(baseConfig({ openai: { apiKey: 'sk-test' } }));
    expect(hasOpenAIClient('openai')).toBe(true);

    await initProviders(baseConfig({}));
    expect(hasOpenAIClient('openai')).toBe(false);
  });

  it('clears stale codex provider registrations on re-init', async () => {
    addResponsesApiProvider('openai');
    expect(isResponsesApiProvider('openai')).toBe(true);

    await initProviders(baseConfig({}));
    expect(isResponsesApiProvider('openai')).toBe(false);
  });

  it('resets oauth flag on re-init', async () => {
    setUsingOAuth(true);
    expect(isUsingOAuth()).toBe(true);

    await initProviders(baseConfig({}));
    expect(isUsingOAuth()).toBe(false);
  });
});
