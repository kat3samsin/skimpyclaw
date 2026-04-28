import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { ThinkingLevel } from '../../types.js';

export interface DiscordAgentProfile {
  alias: string;
  agentId: string;
  model?: string;
  thinking?: ThinkingLevel;
  promptOverlay?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiscordThreadAgentBinding {
  threadId: string;
  profileAlias: string;
  guildId?: string;
  channelId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiscordThreadAgent extends DiscordAgentProfile {
  threadId: string;
  guildId?: string;
  channelId?: string;
  profileAlias: string;
}

export interface DiscordAgentMentionInvocation {
  alias: string;
  prompt: string;
}

const DEFAULT_STORE_PATH = join(homedir(), '.skimpyclaw', 'discord-thread-agents.json');
const ALIAS_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const THINKING_LEVELS = new Set<ThinkingLevel>(['none', 'low', 'medium', 'high', 'xhigh']);

let storePathOverride: string | null = null;
let loaded = false;
const profilesByAlias = new Map<string, DiscordAgentProfile>();
const bindingsByThreadId = new Map<string, DiscordThreadAgentBinding>();

function getStorePath(): string {
  return storePathOverride || DEFAULT_STORE_PATH;
}

export function normalizeThreadAgentAlias(value: string | undefined): string | null {
  const normalized = (value || '').trim().replace(/^@/, '').toLowerCase();
  if (!ALIAS_RE.test(normalized)) return null;
  return normalized;
}

export function parseDiscordAgentMention(value: string): DiscordAgentMentionInvocation | null {
  const match = value.trim().match(/^@([a-z][a-z0-9_-]{0,63})(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const alias = normalizeThreadAgentAlias(match[1]);
  if (!alias) return null;

  return {
    alias,
    prompt: (match[2] || '').trim(),
  };
}

function normalizeThinking(value: unknown): ThinkingLevel | undefined {
  return typeof value === 'string' && THINKING_LEVELS.has(value as ThinkingLevel)
    ? value as ThinkingLevel
    : undefined;
}

function normalizeProfile(value: unknown): DiscordAgentProfile | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<DiscordAgentProfile>;
  const alias = normalizeThreadAgentAlias(raw.alias);
  const agentId = typeof raw.agentId === 'string' ? raw.agentId.trim() : '';
  const createdBy = typeof raw.createdBy === 'string' ? raw.createdBy.trim() : '';
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt;
  if (!alias || !agentId || !createdBy) return null;
  return {
    alias,
    agentId,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
    thinking: normalizeThinking(raw.thinking),
    promptOverlay: typeof raw.promptOverlay === 'string' && raw.promptOverlay.trim()
      ? raw.promptOverlay.trim()
      : undefined,
    createdBy,
    createdAt,
    updatedAt,
  };
}

function normalizeBinding(value: unknown): DiscordThreadAgentBinding | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<DiscordThreadAgentBinding>;
  const threadId = typeof raw.threadId === 'string' ? raw.threadId.trim() : '';
  const profileAlias = normalizeThreadAgentAlias(raw.profileAlias);
  const createdBy = typeof raw.createdBy === 'string' ? raw.createdBy.trim() : '';
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt;
  if (!threadId || !profileAlias || !createdBy) return null;
  return {
    threadId,
    profileAlias,
    guildId: typeof raw.guildId === 'string' && raw.guildId.trim() ? raw.guildId.trim() : undefined,
    channelId: typeof raw.channelId === 'string' && raw.channelId.trim() ? raw.channelId.trim() : undefined,
    createdBy,
    createdAt,
    updatedAt,
  };
}

function normalizeLegacyRecord(value: unknown): { profile: DiscordAgentProfile; binding: DiscordThreadAgentBinding } | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<DiscordThreadAgent & { alias?: string }>;
  const alias = normalizeThreadAgentAlias(raw.alias);
  const threadId = typeof raw.threadId === 'string' ? raw.threadId.trim() : '';
  const agentId = typeof raw.agentId === 'string' ? raw.agentId.trim() : '';
  const createdBy = typeof raw.createdBy === 'string' ? raw.createdBy.trim() : '';
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt;
  if (!alias || !threadId || !agentId || !createdBy) return null;
  return {
    profile: {
      alias,
      agentId,
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
      thinking: normalizeThinking(raw.thinking),
      promptOverlay: typeof raw.promptOverlay === 'string' && raw.promptOverlay.trim()
        ? raw.promptOverlay.trim()
        : undefined,
      createdBy,
      createdAt,
      updatedAt,
    },
    binding: {
      threadId,
      profileAlias: alias,
      guildId: typeof raw.guildId === 'string' && raw.guildId.trim() ? raw.guildId.trim() : undefined,
      channelId: typeof raw.channelId === 'string' && raw.channelId.trim() ? raw.channelId.trim() : undefined,
      createdBy,
      createdAt,
      updatedAt,
    },
  };
}

function resolveBinding(binding: DiscordThreadAgentBinding | undefined): DiscordThreadAgent | null {
  if (!binding) return null;
  const profile = profilesByAlias.get(binding.profileAlias);
  if (!profile) return null;
  return {
    ...profile,
    threadId: binding.threadId,
    profileAlias: binding.profileAlias,
    guildId: binding.guildId,
    channelId: binding.channelId,
  };
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const storePath = getStorePath();
  if (!existsSync(storePath)) return;
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf-8'));
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const normalized = normalizeLegacyRecord(entry);
        if (!normalized) continue;
        profilesByAlias.set(normalized.profile.alias, normalized.profile);
        bindingsByThreadId.set(normalized.binding.threadId, normalized.binding);
      }
      return;
    }

    const profiles = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
    const bindings = Array.isArray(parsed?.bindings) ? parsed.bindings : [];
    for (const entry of profiles) {
      const normalized = normalizeProfile(entry);
      if (normalized) profilesByAlias.set(normalized.alias, normalized);
    }
    for (const entry of bindings) {
      const normalized = normalizeBinding(entry);
      if (normalized) bindingsByThreadId.set(normalized.threadId, normalized);
    }
  } catch (err) {
    console.error('[discord-thread-agents] Failed to load store:', err);
  }
}

function persist(): void {
  try {
    const storePath = getStorePath();
    mkdirSync(dirname(storePath), { recursive: true });
    const store = {
      version: 2,
      profiles: listAgentProfiles(),
      bindings: listThreadAgentBindings(),
    };
    writeFileSync(storePath, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 });
    chmodSync(storePath, 0o600);
  } catch (err) {
    console.error('[discord-thread-agents] Failed to persist store:', err);
  }
}

export function listAgentProfiles(): DiscordAgentProfile[] {
  ensureLoaded();
  return Array.from(profilesByAlias.values()).sort((a, b) => a.alias.localeCompare(b.alias));
}

export function listThreadAgentBindings(): DiscordThreadAgentBinding[] {
  ensureLoaded();
  return Array.from(bindingsByThreadId.values()).sort((a, b) => a.threadId.localeCompare(b.threadId));
}

export function getAgentProfileByAlias(alias: string | undefined): DiscordAgentProfile | null {
  ensureLoaded();
  const normalized = normalizeThreadAgentAlias(alias);
  if (!normalized) return null;
  return profilesByAlias.get(normalized) || null;
}

export function getThreadAgentByThreadId(threadId: string | undefined): DiscordThreadAgent | null {
  ensureLoaded();
  const id = (threadId || '').trim();
  if (!id) return null;
  return resolveBinding(bindingsByThreadId.get(id));
}

export function getThreadAgentBinding(threadId: string | undefined): DiscordThreadAgentBinding | null {
  ensureLoaded();
  const id = (threadId || '').trim();
  if (!id) return null;
  return bindingsByThreadId.get(id) || null;
}

export function upsertAgentProfile(input: {
  alias: string;
  agentId: string;
  createdBy: string;
}): DiscordAgentProfile {
  ensureLoaded();
  const alias = normalizeThreadAgentAlias(input.alias);
  const agentId = input.agentId.trim();
  const createdBy = input.createdBy.trim();
  if (!alias) throw new Error('Alias must start with a letter and use only letters, numbers, underscore, or dash.');
  if (!agentId) throw new Error('Agent ID is required.');
  if (!createdBy) throw new Error('Creator ID is required.');

  const existing = profilesByAlias.get(alias);
  const now = new Date().toISOString();
  const profile: DiscordAgentProfile = {
    alias,
    agentId,
    createdBy: existing?.createdBy || createdBy,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    model: existing?.model,
    thinking: existing?.thinking,
    promptOverlay: existing?.promptOverlay,
  };
  profilesByAlias.set(alias, profile);
  persist();
  return profile;
}

export function bindThreadAgent(input: {
  threadId: string;
  alias: string;
  createdBy: string;
  guildId?: string | null;
  channelId?: string | null;
}): DiscordThreadAgent {
  ensureLoaded();
  const threadId = input.threadId.trim();
  const profileAlias = normalizeThreadAgentAlias(input.alias);
  const createdBy = input.createdBy.trim();
  if (!threadId) throw new Error('Thread ID is required.');
  if (!profileAlias) throw new Error('Agent alias is required.');
  if (!createdBy) throw new Error('Creator ID is required.');
  if (!profilesByAlias.has(profileAlias)) throw new Error(`Agent profile "${profileAlias}" does not exist.`);

  const existing = bindingsByThreadId.get(threadId);
  const now = new Date().toISOString();
  const binding: DiscordThreadAgentBinding = {
    threadId,
    profileAlias,
    createdBy: existing?.createdBy || createdBy,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    guildId: input.guildId?.trim() || existing?.guildId,
    channelId: input.channelId?.trim() || existing?.channelId,
  };
  bindingsByThreadId.set(threadId, binding);
  persist();
  const resolved = resolveBinding(binding);
  if (!resolved) throw new Error(`Agent profile "${profileAlias}" does not exist.`);
  return resolved;
}

export function setAgentProfilePrompt(alias: string, promptOverlay: string | undefined): DiscordAgentProfile | null {
  ensureLoaded();
  const profile = getAgentProfileByAlias(alias);
  if (!profile) return null;
  const nextPrompt = promptOverlay?.trim();
  profile.promptOverlay = nextPrompt || undefined;
  profile.updatedAt = new Date().toISOString();
  persist();
  return profile;
}

export function setAgentProfileModel(alias: string, model: string | undefined): DiscordAgentProfile | null {
  ensureLoaded();
  const profile = getAgentProfileByAlias(alias);
  if (!profile) return null;
  const nextModel = model?.trim();
  profile.model = nextModel || undefined;
  profile.updatedAt = new Date().toISOString();
  persist();
  return profile;
}

export function setAgentProfileThinking(alias: string, thinking: ThinkingLevel | undefined): DiscordAgentProfile | null {
  ensureLoaded();
  const profile = getAgentProfileByAlias(alias);
  if (!profile) return null;
  profile.thinking = thinking;
  profile.updatedAt = new Date().toISOString();
  persist();
  return profile;
}

export function removeAgentProfile(alias: string): boolean {
  ensureLoaded();
  const normalized = normalizeThreadAgentAlias(alias);
  if (!normalized) return false;
  const deleted = profilesByAlias.delete(normalized);
  if (deleted) {
    for (const [threadId, binding] of bindingsByThreadId) {
      if (binding.profileAlias === normalized) bindingsByThreadId.delete(threadId);
    }
    persist();
  }
  return deleted;
}

export function _setThreadAgentStorePathForTesting(path: string | null): void {
  storePathOverride = path;
  profilesByAlias.clear();
  bindingsByThreadId.clear();
  loaded = false;
}
