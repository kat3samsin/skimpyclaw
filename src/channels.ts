/*
 * Channel management for messaging integrations (Telegram, Discord).
 * Tracks the active channel, provides a unified adapter interface for
 * initializing, starting, stopping, and sending proactive messages
 * across supported platforms.
 */
import type { ChannelId, Config } from './types.js';

type ChannelTarget = string | number;

interface ChannelAdapter {
  init: (config: Config) => Promise<boolean>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isSilenced?: () => boolean;
  sendProactiveMessage?: (target: ChannelTarget, message: string) => Promise<void>;
  sendProactiveVoice?: (target: ChannelTarget, buffer: Buffer, format: string) => Promise<void>;
  resolveDefaultTarget?: (config: Config) => ChannelTarget | null;
}

let activeChannelId: ChannelId | null = null;
let activeAdapter: ChannelAdapter | null = null;

function isEnabled(config: Config, channel: ChannelId): boolean {
  if (channel === 'telegram') return !!config.channels.telegram?.enabled;
  return !!config.channels.discord?.enabled;
}

function resolveChannelPreference(config: Config): ChannelId | null {
  const preferred = config.channels.active;
  if (preferred) {
    if (isEnabled(config, preferred)) return preferred;
    console.log(`[channels] Requested active channel "${preferred}" is not enabled`);
  }

  const enabled: ChannelId[] = [];
  if (isEnabled(config, 'telegram')) enabled.push('telegram');
  if (isEnabled(config, 'discord')) enabled.push('discord');

  if (enabled.length === 0) return null;
  if (enabled.length > 1) {
    console.log('[channels] Multiple channels enabled; defaulting to telegram. Set channels.active to override.');
    return enabled.includes('telegram') ? 'telegram' : enabled[0];
  }

  return enabled[0];
}

async function loadAdapter(channel: ChannelId): Promise<ChannelAdapter> {
  if (channel === 'telegram') {
    const telegram = await import('./channels/telegram/index.js');
    return {
      init: async (config) => (await telegram.initTelegram(config)) !== null,
      start: telegram.startTelegram,
      stop: telegram.stopTelegram,
      isSilenced: telegram.isSilenced,
      sendProactiveMessage: telegram.sendProactiveMessage,
      sendProactiveVoice: telegram.sendProactiveVoice,
      resolveDefaultTarget: telegram.getTelegramDefaultChatId,
    };
  }

  const discord = await import('./channels/discord/index.js');
  return {
    init: discord.initDiscord,
    start: discord.startDiscord,
    stop: discord.stopDiscord,
    isSilenced: discord.isDiscordSilenced,
    sendProactiveMessage: discord.sendDiscordProactiveMessage,
    sendProactiveVoice: discord.sendDiscordProactiveVoice,
    resolveDefaultTarget: discord.getDiscordDefaultTarget,
  };
}

export async function initActiveChannel(config: Config): Promise<ChannelId | null> {
  const selected = resolveChannelPreference(config);
  if (!selected) {
    activeChannelId = null;
    activeAdapter = null;
    console.log('[channels] No enabled chat channel');
    return null;
  }

  const adapter = await loadAdapter(selected);
  const initialized = await adapter.init(config);
  if (!initialized) {
    activeChannelId = null;
    activeAdapter = null;
    console.log(`[channels] Failed to initialize ${selected}`);
    return null;
  }

  activeChannelId = selected;
  activeAdapter = adapter;
  console.log(`[channels] Active channel: ${selected}`);
  return selected;
}

export async function startActiveChannel(): Promise<void> {
  if (!activeAdapter) return;
  await activeAdapter.start();
}

export async function stopActiveChannel(): Promise<void> {
  if (!activeAdapter) return;
  await activeAdapter.stop();
}

export function getActiveChannelId(): ChannelId | null {
  return activeChannelId;
}

export function getActiveChannelDefaultTarget(config: Config): ChannelTarget | null {
  if (!activeAdapter?.resolveDefaultTarget) return null;
  const target = activeAdapter.resolveDefaultTarget(config);
  if (target === null || target === undefined || target === '') return null;
  return target;
}

export function isActiveChannelSilenced(): boolean {
  return activeAdapter?.isSilenced?.() ?? false;
}

export async function sendActiveChannelProactiveMessage(config: Config, message: string): Promise<boolean> {
  if (!activeAdapter?.sendProactiveMessage) {
    return false;
  }

  const target = getActiveChannelDefaultTarget(config);
  if (target === null) {
    return false;
  }

  await activeAdapter.sendProactiveMessage(target, message);
  return true;
}

export async function sendActiveChannelProactiveVoice(config: Config, buffer: Buffer, format: string): Promise<boolean> {
  if (!activeAdapter?.sendProactiveVoice || !activeAdapter.resolveDefaultTarget) {
    return false;
  }

  const target = activeAdapter.resolveDefaultTarget(config);
  if (target === null || target === undefined || target === '') {
    return false;
  }

  await activeAdapter.sendProactiveVoice(target, buffer, format);
  return true;
}
