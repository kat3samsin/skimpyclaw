import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  buildCodeAgentSpawnEnv,
  normalizeCodeAgent,
  resolveSelectedCodeAgent,
  getAvailableCodingCliTools,
  getCodingCliPreflightError,
  readClaudeCodeDefaultModel,
  resolveCodeAgentModelLabel,
} from '../code-agents/utils.js';

describe('normalizeCodeAgent', () => {
  it('accepts strict ids', () => {
    expect(normalizeCodeAgent('claude')).toBe('claude');
    expect(normalizeCodeAgent('codex')).toBe('codex');
  });

  it('maps legacy alias-like values', () => {
    expect(normalizeCodeAgent('claude-coder')).toBe('claude');
    expect(normalizeCodeAgent('codex5.3')).toBe('codex');
  });

  it('returns null for unknown values', () => {
    expect(normalizeCodeAgent('gpt')).toBeNull();
    expect(normalizeCodeAgent(undefined)).toBeNull();
  });
});

describe('resolveSelectedCodeAgent', () => {
  it('prefers requested agent when provided', () => {
    expect(resolveSelectedCodeAgent('codex5.3', 'claude')).toBe('codex');
  });

  it('falls back to configured default agent', () => {
    expect(resolveSelectedCodeAgent(undefined, 'claude-coder')).toBe('claude');
  });

  it('uses claude as hard default', () => {
    expect(resolveSelectedCodeAgent(undefined, undefined)).toBe('claude');
  });

  it('auto-selects codex when model is a GPT model and no agent specified', () => {
    expect(resolveSelectedCodeAgent(undefined, 'claude', 'gpt-4.1')).toBe('codex');
    expect(resolveSelectedCodeAgent(undefined, 'claude', 'gpt-5.3-codex')).toBe('codex');
    expect(resolveSelectedCodeAgent(undefined, 'claude', 'openai/gpt-4.1')).toBe('codex');
    expect(resolveSelectedCodeAgent(undefined, 'claude', 'o3-pro')).toBe('codex');
  });

  it('respects explicit agent even when model suggests different agent', () => {
    expect(resolveSelectedCodeAgent('claude', 'claude', 'gpt-4.1')).toBe('claude');
  });
});

describe('coding CLI preflight', () => {
  it('returns a clear error when no supported CLI is found on PATH', () => {
    expect(getAvailableCodingCliTools(() => false)).toEqual([]);
    expect(getCodingCliPreflightError(() => false)).toBe(
      'Error: No supported coding CLI found on PATH. Install Codex CLI (`codex`) or Claude Code CLI (`claude` or `claude-code`).'
    );
  });

  it('accepts claude-code binary as claude support', () => {
    const hasCommand = (name: string) => name === 'claude-code';
    expect(getAvailableCodingCliTools(hasCommand)).toEqual(['claude']);
    expect(getCodingCliPreflightError(hasCommand)).toBeNull();
  });
});

describe('buildCodeAgentSpawnEnv', () => {
  it('points Codex subprocesses at the standard ~/.codex state directory', () => {
    const env = buildCodeAgentSpawnEnv({
      HOME: '/tmp/ignored-home',
      CODEX_HOME: '/tmp/old-codex-home',
      GH_TOKEN: 'stale-gh',
      GITHUB_TOKEN: 'stale-github',
      CLAUDECODE: 'nested',
    });

    expect(env.CODEX_HOME).toBe(join(homedir(), '.codex'));
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });
});

describe('code agent model labels', () => {
  it('reads Claude Code default model from settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skimpyclaw-claude-settings-'));
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus[1m]' }));

    expect(readClaudeCodeDefaultModel(settingsPath)).toBe('opus[1m]');
  });

  it('strips provider prefixes for explicit model labels', () => {
    expect(resolveCodeAgentModelLabel('claude', 'anthropic/claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(resolveCodeAgentModelLabel('codex', 'codex/gpt-5.5')).toBe('gpt-5.5');
  });
});
