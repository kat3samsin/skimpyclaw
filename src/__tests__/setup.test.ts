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
    expect(config.models.aliases.codex).toBe('codex/codex-5.3');
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
});
