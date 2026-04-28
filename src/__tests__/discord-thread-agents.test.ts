import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  _setThreadAgentStorePathForTesting,
  bindThreadAgent,
  getAgentProfileByAlias,
  getThreadAgentByThreadId,
  listAgentProfiles,
  listThreadAgentBindings,
  parseDiscordAgentMention,
  removeAgentProfile,
  setAgentProfileModel,
  setAgentProfilePrompt,
  setAgentProfileThinking,
  upsertAgentProfile,
} from '../channels/discord/thread-agents.js';

let tempDir: string;
let storePath: string;

describe('Discord thread agents registry', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'skimpyclaw-thread-agents-'));
    storePath = join(tempDir, 'thread-agents.json');
    _setThreadAgentStorePathForTesting(storePath);
  });

  afterEach(() => {
    _setThreadAgentStorePathForTesting(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores reusable profiles and binds them to threads', () => {
    const profile = upsertAgentProfile({
      alias: 'Reviewer',
      agentId: 'main',
      createdBy: 'user-1',
    });
    const binding = bindThreadAgent({
      threadId: 'thread-1',
      alias: 'reviewer',
      createdBy: 'user-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
    });

    expect(profile.alias).toBe('reviewer');
    expect(binding.alias).toBe('reviewer');
    expect(getThreadAgentByThreadId('thread-1')?.agentId).toBe('main');
    expect(listAgentProfiles()).toHaveLength(1);
    expect(listThreadAgentBindings()).toHaveLength(1);
  });

  it('allows one profile to be reused across multiple threads', () => {
    upsertAgentProfile({
      alias: 'claude-coder',
      agentId: 'main',
      createdBy: 'user-1',
    });
    bindThreadAgent({ threadId: 'thread-1', alias: 'claude-coder', createdBy: 'user-1' });
    bindThreadAgent({ threadId: 'thread-2', alias: 'claude-coder', createdBy: 'user-1' });

    expect(listAgentProfiles()).toHaveLength(1);
    expect(listThreadAgentBindings().map(record => record.threadId)).toEqual(['thread-1', 'thread-2']);
  });

  it('updates profile prompts, models, and thinking for all bound threads', () => {
    upsertAgentProfile({
      alias: 'claude-coder',
      agentId: 'main',
      createdBy: 'user-1',
    });
    bindThreadAgent({ threadId: 'thread-1', alias: 'claude-coder', createdBy: 'user-1' });
    bindThreadAgent({ threadId: 'thread-2', alias: 'claude-coder', createdBy: 'user-1' });

    expect(setAgentProfilePrompt('claude-coder', 'Review code like a senior engineer.')?.promptOverlay)
      .toBe('Review code like a senior engineer.');
    expect(setAgentProfileModel('claude-coder', 'anthropic/claude-sonnet-4-5')?.model)
      .toBe('anthropic/claude-sonnet-4-5');
    expect(setAgentProfileThinking('claude-coder', 'xhigh')?.thinking).toBe('xhigh');
    expect(getThreadAgentByThreadId('thread-2')?.model).toBe('anthropic/claude-sonnet-4-5');
    expect(getThreadAgentByThreadId('thread-2')?.thinking).toBe('xhigh');
  });

  it('deletes profiles with their bindings', () => {
    upsertAgentProfile({
      alias: 'reviewer',
      agentId: 'main',
      createdBy: 'user-1',
    });
    bindThreadAgent({ threadId: 'thread-1', alias: 'reviewer', createdBy: 'user-1' });

    expect(removeAgentProfile('reviewer')).toBe(true);
    expect(getAgentProfileByAlias('reviewer')).toBeNull();
    expect(getThreadAgentByThreadId('thread-1')).toBeNull();
  });

  it('migrates legacy thread-agent array stores', () => {
    _setThreadAgentStorePathForTesting(null);
    writeFileSync(storePath, JSON.stringify([
      {
        threadId: 'thread-1',
        alias: 'Reviewer',
        agentId: 'main',
        model: 'anthropic/claude-sonnet-4-5',
        thinking: 'high',
        promptOverlay: 'Review carefully.',
        createdBy: 'user-1',
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
        guildId: 'guild-1',
        channelId: 'channel-1',
      },
    ]), 'utf-8');
    _setThreadAgentStorePathForTesting(storePath);

    const migrated = getThreadAgentByThreadId('thread-1');
    expect(migrated?.alias).toBe('reviewer');
    expect(migrated?.model).toBe('anthropic/claude-sonnet-4-5');
    expect(migrated?.thinking).toBe('high');

    setAgentProfileModel('reviewer', 'anthropic/claude-opus-4-6');
    const persisted = JSON.parse(readFileSync(storePath, 'utf-8'));
    expect(persisted.version).toBe(2);
    expect(persisted.profiles[0].alias).toBe('reviewer');
    expect(persisted.bindings[0].profileAlias).toBe('reviewer');
  });

  it('parses leading agent mentions', () => {
    expect(parseDiscordAgentMention('@Claude-Coder review this PR')).toEqual({
      alias: 'claude-coder',
      prompt: 'review this PR',
    });
    expect(parseDiscordAgentMention('@codex-reviewer')).toEqual({
      alias: 'codex-reviewer',
      prompt: '',
    });
    expect(parseDiscordAgentMention('please ask @codex-reviewer')).toBeNull();
    expect(parseDiscordAgentMention('<@1234567890> review this')).toBeNull();
  });
});
