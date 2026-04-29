import { describe, expect, it } from 'vitest';
import {
  initProviders,
  addResponsesApiProvider,
  isResponsesApiProvider,
  setUsingOAuth,
  isUsingOAuth,
} from '../providers/index.js';

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

describe('providers init reset behavior', () => {
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
