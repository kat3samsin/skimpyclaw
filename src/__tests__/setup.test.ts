import { describe, expect, it } from 'vitest';
import { buildSetupArtifacts, buildSetupConfig } from '../setup.js';

describe('setup config generation', () => {
  it('builds Anthropic+Codex config with expected defaults', () => {
    const selectedProviders = new Set(['anthropic-api', 'codex-oauth'] as const);
    const config = buildSetupConfig({
      workspaceDir: '/tmp/workspace',
      telegramId: '12345',
      telegramToken: 'tg-token',
      agentName: 'Claw',
      selectedProviders,
      providerSecrets: { anthropicKey: 'sk-ant-test' },
    }) as any;

    expect(config.agents.list.main.model).toBe('anthropic/claude-opus-4-6');
    expect(config.models.providers.anthropic.apiKey).toBe('${ANTHROPIC_API_KEY}');
    expect(config.models.providers.codex.authPath).toBe('${HOME}/.codex/auth.json');
    expect(config.channels.telegram.allowFrom).toEqual([12345]);
    expect(config.channels.telegram.defaultAllowedPaths).toContain('/tmp/workspace');
    expect(config.models.aliases['claude-think']).toBe('anthropic/claude-sonnet-4-6');
    expect(config.models.aliases.codex).toBe('codex/gpt-5.3-codex');
  });

  it('builds OpenAI-only config and env content', () => {
    const selectedProviders = new Set(['openai-api'] as const);
    const { configJson, envContent } = buildSetupArtifacts({
      workspaceDir: '/tmp/workspace',
      telegramId: 'abc-user',
      telegramToken: 'tg-token',
      agentName: 'Claw',
      selectedProviders,
      providerSecrets: { openaiKey: 'sk-openai-test' },
    });
    const config = JSON.parse(configJson);

    expect(config.agents.list.main.model).toBe('openai/gpt-4o');
    expect(config.models.providers.openai.apiKey).toBe('${OPENAI_API_KEY}');
    expect(config.channels.telegram.allowFrom).toEqual(['abc-user']);
    expect(envContent).toContain('OPENAI_API_KEY=sk-openai-test');
    expect(envContent).toContain('TELEGRAM_BOT_TOKEN=tg-token');
    expect(envContent).not.toContain('ANTHROPIC_API_KEY=');
  });

  it('includes oauth placeholders when Anthropic OAuth is selected', () => {
    const selectedProviders = new Set(['anthropic-oauth'] as const);
    const { configJson, envContent } = buildSetupArtifacts({
      workspaceDir: '/tmp/workspace',
      telegramId: '1',
      telegramToken: 'tg-token',
      agentName: 'Claw',
      selectedProviders,
      providerSecrets: {},
    });
    const config = JSON.parse(configJson);

    expect(config.models.providers.anthropic.authToken).toBe('${CLAUDE_CODE_OAUTH_TOKEN}');
    expect(envContent).toContain('CLAUDE_CODE_OAUTH_TOKEN=');
    expect(envContent).not.toContain('ANTHROPIC_API_KEY=');
  });

  it('includes gateway host in generated config', () => {
    const config = buildSetupConfig({
      workspaceDir: '/tmp/workspace',
      telegramId: '12345',
      telegramToken: 'tg-token',
      agentName: 'Claw',
      selectedProviders: new Set(['anthropic-api'] as const),
      providerSecrets: { anthropicKey: 'sk-ant-test' },
    }) as any;

    expect(config.gateway.host).toBe('127.0.0.1');
    expect(config.gateway.port).toBe(18790);
  });

  it('disables browser when features.browser is false', () => {
    const config = buildSetupConfig({
      workspaceDir: '/tmp/workspace',
      telegramId: '12345',
      telegramToken: 'tg-token',
      agentName: 'Claw',
      selectedProviders: new Set(['anthropic-api'] as const),
      providerSecrets: { anthropicKey: 'sk-ant-test' },
      features: { browser: false, voice: false, mcp: false },
    }) as any;

    expect(config.heartbeat.tools.browser.enabled).toBe(false);
    expect(config.voice).toBeUndefined();
  });

  it('enables browser and voice when features are true', () => {
    const config = buildSetupConfig({
      workspaceDir: '/tmp/workspace',
      telegramId: '12345',
      telegramToken: 'tg-token',
      agentName: 'Claw',
      selectedProviders: new Set(['anthropic-api'] as const),
      providerSecrets: { anthropicKey: 'sk-ant-test' },
      features: { browser: true, voice: true, mcp: false },
    }) as any;

    expect(config.heartbeat.tools.browser.enabled).toBe(true);
    expect(config.voice).toBeDefined();
    expect(config.voice.enabled).toBe(true);
    expect(config.voice.channels.telegram.sendVoice).toBe(true);
    expect(config.voice.channels.telegram.acceptVoice).toBe(true);
    expect(config.voice.channels.discord.sendVoice).toBe(true);
  });

  it('rejects non-numeric telegram IDs by parsing to NaN', () => {
    // buildSetupConfig uses parseInt which returns NaN for non-numeric strings
    // The wizard loop validates before reaching here, but verify the fallback
    const config = buildSetupConfig({
      workspaceDir: '/tmp/workspace',
      telegramId: 'not-a-number',
      telegramToken: 'tg-token',
      agentName: 'Claw',
      selectedProviders: new Set(['anthropic-api'] as const),
      providerSecrets: { anthropicKey: 'sk-ant-test' },
    }) as any;

    // parseInt('not-a-number') is NaN, so || falls through to string
    expect(config.channels.telegram.allowFrom).toEqual(['not-a-number']);
  });
});
