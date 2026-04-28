import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  ChannelType,
  type Client,
  type Message,
  type Interaction,
  type GuildTextBasedChannel,
} from 'discord.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import type { Config, ThinkingLevel } from '../../types.js';
import { getCurrentModel, getCurrentThinking, setCurrentModel, setCurrentThinking } from '../../gateway.js';
import { getCronJobs, runCronJob } from '../../cron.js';
import { runAgentTurn } from '../../agent.js';
import { runHeartbeatCheck } from '../../heartbeat.js';
import { isAllowed, isRateLimited } from '../../security.js';
import { getActiveCodeAgents, getRecentCodeAgents } from '../../tools.js';
import {
  listApprovals,
  approveRequest,
  denyRequest,
  getApproval,
  type PendingApproval,
} from '../../exec-approval.js';
import { transcribeAudio, synthesizeSpeech } from '../../voice.js';
import * as sessions from '../../sessions.js';
import { formatAliases, formatModelSelectionError, getModelSelectionUsage, resolveModelSelection } from '../../model-selection.js';
import { KNOWN_COMMANDS } from './types.js';
import {
  getHistory,
  addToHistory,
  clearHistory,
  replaceHistory,
  getDiscordToolConfig,
  getDiscordRunContext,
  conversationKey,
  buildCodeAgentThreadContext,
  buildHelpText,
  sendLongText,
  sendLongTextToChannel,
  startTypingIndicator,
  startTypingIndicatorForChannel,
} from './utils.js';
import { createTaskThread, buildThreadUrl } from './threads.js';
import {
  bindThreadAgent,
  getAgentProfileByAlias,
  getThreadAgentByThreadId,
  listAgentProfiles,
  parseDiscordAgentMention,
  removeAgentProfile,
  setAgentProfileModel,
  setAgentProfilePrompt,
  setAgentProfileThinking,
  upsertAgentProfile,
  type DiscordAgentProfile,
  type DiscordThreadAgent,
} from './thread-agents.js';
import { isDocumentAttachment, processAttachments, supportedExtensions } from './attachments.js';
import { getSession, linkThread } from '../../code-agents/interactive-sessions.js';
import { handleInteractiveThreadMessage } from '../../code-agents/interactive-resume.js';

type DiscordMessageChannel = Message['channel'] | GuildTextBasedChannel;

// ── Command handler ─────────────────────────────────────────────────

const THREAD_AGENT_USAGE = [
  'Usage:',
  '/agent create <alias> [agent-id]',
  '/agent use <alias> [message]',
  '/agent model [alias] <model-alias|provider/model|model-id>',
  '/agent effort [alias] <none|low|medium|high|xhigh>',
  '/agent prompt [alias] <prompt text>',
  '/agent delete <alias>',
  '/agent list',
  '@alias <message>',
].join('\n');

const THINKING_LEVELS: ThinkingLevel[] = ['none', 'low', 'medium', 'high', 'xhigh'];
const AGENT_PROMPT_MAX_CHARS = 20_000;

function parseThinkingLevel(value: string | undefined): ThinkingLevel | null {
  const normalized = (value || '').trim().toLowerCase().replace(/^x[-_ ]?high$/, 'xhigh');
  if (normalized === 'off') return 'none';
  return (THINKING_LEVELS as string[]).includes(normalized) ? normalized as ThinkingLevel : null;
}

function formatThinkingUsage(command = '/effort'): string {
  return `Usage: ${command} <${THINKING_LEVELS.join('|')}>`;
}

function formatAgentIds(config: Config): string {
  return Object.keys(config.agents.list).join(', ') || '(none configured)';
}

function resolveConfiguredAgentId(config: Config, rawAgentId?: string): string | null {
  const candidate = (rawAgentId || config.agents.default).trim();
  return config.agents.list[candidate] ? candidate : null;
}

function formatThreadAgent(record: DiscordThreadAgent): string {
  const prompt = record.promptOverlay
    ? `\nPrompt: ${record.promptOverlay.length > 120 ? record.promptOverlay.slice(0, 120) + '...' : record.promptOverlay}`
    : '';
  const model = record.model ? `, model ${record.model}` : '';
  const thinking = record.thinking ? `, effort ${record.thinking}` : '';
  return `This thread uses @${record.alias} -> ${record.agentId}${model}${thinking}${prompt}`;
}

function formatAgentProfile(profile: DiscordAgentProfile): string {
  const prompt = profile.promptOverlay
    ? `\nPrompt: ${profile.promptOverlay.length > 120 ? profile.promptOverlay.slice(0, 120) + '...' : profile.promptOverlay}`
    : '';
  const model = profile.model ? `, model ${profile.model}` : '';
  const thinking = profile.thinking ? `, effort ${profile.thinking}` : '';
  return `@${profile.alias} -> ${profile.agentId}${model}${thinking}${prompt}`;
}

function formatThreadAgentThreadName(alias: string, taskText?: string): string {
  const task = (taskText || '')
    .replace(/https?:\/\/\S+\/pull\/(\d+)\S*/g, '#$1')
    .replace(/https?:\/\/\S+\/issues\/(\d+)\S*/g, '#$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const base = task || 'agent';
  const maxTaskLength = Math.max(10, 96 - alias.length);
  const suffix = base.length > maxTaskLength ? `${base.slice(0, maxTaskLength - 3).trim()}...` : base;
  return `${alias}: ${suffix}`.slice(0, 100);
}

function isDiscordThreadChannel(channel: Message['channel']): boolean {
  if (channel.isDMBased()) return false;
  if (channel.isThread()) return true;
  const channelType = channel.type as number;
  return channelType === ChannelType.PublicThread
    || channelType === ChannelType.PrivateThread
    || channelType === ChannelType.AnnouncementThread;
}

async function createThreadAgentThread(message: Message, alias: string, taskText?: string): Promise<GuildTextBasedChannel | null> {
  if (message.channel.isDMBased()) return null;
  if (!('threads' in message.channel)) return null;
  try {
    const thread = await message.startThread({
      name: formatThreadAgentThreadName(alias, taskText),
      autoArchiveDuration: 1440,
    });
    return thread;
  } catch (err) {
    console.error('[discord-thread-agents] Failed to create thread agent thread:', err);
    return null;
  }
}

function getThreadAgentForMessage(message: Message, config: Config): DiscordThreadAgent | null {
  if (!isDiscordThreadChannel(message.channel)) return null;
  const record = getThreadAgentByThreadId(message.channel.id);
  if (!record) return null;
  if (!config.agents.list[record.agentId]) return null;
  return record;
}

function profileAsThreadAgent(
  profile: DiscordAgentProfile,
  message: Message,
  channel: DiscordMessageChannel,
): DiscordThreadAgent {
  const channelId = isThreadChannel(channel)
    ? channel.parentId ?? message.channelId
    : message.channelId;
  return {
    ...profile,
    threadId: channel.id,
    profileAlias: profile.alias,
    guildId: message.guildId || undefined,
    channelId,
  };
}

function isDMBasedChannel(channel: DiscordMessageChannel): boolean {
  return Boolean((channel as { isDMBased?: () => boolean }).isDMBased?.());
}

function isThreadChannel(channel: DiscordMessageChannel): channel is GuildTextBasedChannel & { parentId?: string | null } {
  return Boolean((channel as { isThread?: () => boolean }).isThread?.());
}

function conversationKeyForChannel(message: Message, channel: DiscordMessageChannel): string {
  if (isDMBasedChannel(channel)) {
    return `dm:${message.author.id}`;
  }
  return `channel:${channel.id}`;
}

function sendableChannel(channel: DiscordMessageChannel): { send?: (content: string) => Promise<unknown> } {
  return channel as { send?: (content: string) => Promise<unknown> };
}

function getDiscordRunContextForChannel(message: Message, channel: DiscordMessageChannel) {
  const context = getDiscordRunContext(message);
  const isDm = isDMBasedChannel(channel);
  const isThread = !isDm && isThreadChannel(channel);
  return {
    ...context,
    sessionId: channel.id,
    metadata: {
      ...(context.metadata || {}),
      isDm,
      ...(isThread ? {
        discordThreadId: channel.id,
        discordChannelId: channel.parentId ?? message.channelId,
      } : {}),
    },
  };
}

function getThreadAgentRunContext(
  message: Message,
  threadAgent: DiscordThreadAgent | null,
  channel: DiscordMessageChannel = message.channel,
) {
  const context = getDiscordRunContextForChannel(message, channel);
  if (!threadAgent) {
    return {
      ...context,
      metadata: {
        ...(context.metadata || {}),
        thinkingOverride: getCurrentThinking(),
      },
    };
  }
  return {
    ...context,
    metadata: {
      ...(context.metadata || {}),
      threadAgentAlias: threadAgent.alias,
      threadAgentId: threadAgent.agentId,
      threadAgentModel: threadAgent.model,
      threadAgentThinking: threadAgent.thinking,
      thinkingOverride: threadAgent.thinking ?? getCurrentThinking(),
      threadAgentPromptOverlay: threadAgent.promptOverlay,
    },
  };
}

async function runThreadAgentPrompt(
  message: Message,
  targetChannel: DiscordMessageChannel,
  threadAgent: DiscordThreadAgent,
  promptText: string,
  config: Config,
  options: { announceTask?: boolean } = {},
): Promise<void> {
  const prompt = promptText.trim();
  if (!prompt) return;

  if (options.announceTask) {
    await sendLongTextToChannel(
      sendableChannel(targetChannel),
      `Task from @${message.author.username || message.author.id}:\n${prompt}`,
    );
  }

  const stopTyping = startTypingIndicatorForChannel(targetChannel as { sendTyping?: () => Promise<unknown> });
  try {
    const key = conversationKeyForChannel(message, targetChannel);
    const history = await getHistory(key);
    const response = await runAgentTurn(
      threadAgent.agentId,
      prompt,
      config,
      threadAgent.model || getCurrentModel(),
      getDiscordToolConfig(config),
      history,
      getThreadAgentRunContext(message, threadAgent, targetChannel),
    );
    await addToHistory(key, prompt, response);
    await sendLongTextToChannel(sendableChannel(targetChannel), response);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    await sendLongTextToChannel(sendableChannel(targetChannel), `Error: ${msg}`);
  } finally {
    stopTyping();
  }
}

async function runMentionedAgentPrompt(message: Message, text: string, config: Config): Promise<boolean> {
  const invocation = parseDiscordAgentMention(text);
  if (!invocation) return false;

  const profile = getAgentProfileByAlias(invocation.alias);
  if (!profile) {
    await message.reply(`No Discord agent profile found for @${invocation.alias}. Create it with /agent create ${invocation.alias}.`);
    return true;
  }

  if (!config.agents.list[profile.agentId]) {
    await message.reply(`Agent profile @${profile.alias} points to missing configured agent "${profile.agentId}".`);
    return true;
  }

  if (!invocation.prompt) {
    await message.reply(`Usage: @${profile.alias} <message>`);
    return true;
  }

  try {
    if (message.channel.isDMBased()) {
      const record = profileAsThreadAgent(profile, message, message.channel);
      await runThreadAgentPrompt(message, message.channel, record, invocation.prompt, config);
      return true;
    }

    const isThread = isDiscordThreadChannel(message.channel);
    const targetChannel = isThread
      ? message.channel
      : await createThreadAgentThread(message, profile.alias, invocation.prompt);
    if (!targetChannel) {
      await message.reply('Agent mentions can only run in a DM, inside a Discord thread, or from a channel where I can create one.');
      return true;
    }

    const record = bindThreadAgent({
      threadId: targetChannel.id,
      alias: profile.alias,
      createdBy: message.author.id,
      guildId: message.guildId,
      channelId: targetChannel.isThread() ? targetChannel.parentId ?? message.channelId : message.channelId,
    });

    if (!isThread) {
      const url = buildThreadUrl(message.guildId, targetChannel.id);
      await message.reply(url ? `Started @${profile.alias}: ${url}` : `Started @${profile.alias}.`);
    }

    await runThreadAgentPrompt(message, targetChannel, record, invocation.prompt, config, {
      announceTask: !isThread,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await message.reply(`Error: ${msg}`);
    return true;
  }
}

async function readPromptAttachment(message: Message): Promise<{ text?: string; error?: string; filename?: string }> {
  const docAttachments = message.attachments.filter(a => isDocumentAttachment(a));
  if (docAttachments.size === 0) return {};

  const results = await processAttachments([...docAttachments.values()]);
  const firstOk = results.find(result => result.ok && result.text?.trim());
  if (firstOk?.text) {
    return {
      text: firstOk.text.trim(),
      filename: firstOk.filename,
    };
  }

  const errors = results.map(result => result.error).filter(Boolean);
  return {
    error: errors.join('\n') || `Could not read attached prompt. Supported file types: ${supportedExtensions().map(e => `.${e}`).join(', ')}`,
  };
}

function normalizeAliasArg(value: string | undefined): string {
  return (value || '').trim().replace(/^@/, '').toLowerCase();
}

function getAgentProfileCommandTarget(message: Message, alias?: string): { profile: DiscordAgentProfile | null; record?: DiscordThreadAgent | null; error?: string } {
  const normalizedAlias = normalizeAliasArg(alias);
  if (normalizedAlias) {
    const profile = getAgentProfileByAlias(normalizedAlias);
    return profile ? { profile } : { profile: null, error: `No Discord agent profile found for @${normalizedAlias}.` };
  }

  if (isDiscordThreadChannel(message.channel)) {
    const record = getThreadAgentByThreadId(message.channel.id);
    if (record) return { profile: getAgentProfileByAlias(record.alias), record };
  }

  const profiles = listAgentProfiles();
  if (profiles.length === 1) return { profile: profiles[0] };

  return {
    profile: null,
    error: `No target agent profile found. Pass an alias. Known profiles: ${profiles.map(profile => `@${profile.alias}`).join(', ') || '(none)'}.`,
  };
}

function getOrCreateAgentProfileCommandTarget(
  message: Message,
  config: Config,
  alias?: string,
): { profile: DiscordAgentProfile | null; created?: boolean; error?: string } {
  const normalizedAlias = normalizeAliasArg(alias);
  if (!normalizedAlias) return getAgentProfileCommandTarget(message);

  const existing = getAgentProfileByAlias(normalizedAlias);
  if (existing) return { profile: existing };

  try {
    return {
      profile: upsertAgentProfile({
        alias: normalizedAlias,
        agentId: config.agents.default,
        createdBy: message.author.id,
      }),
      created: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { profile: null, error: msg };
  }
}

async function handleEffortCommand(message: Message, args: string[]): Promise<void> {
  if (!args[0]) {
    await message.reply(`Current effort: ${getCurrentThinking() || 'default'}\n${formatThinkingUsage()}`);
    return;
  }
  const next = parseThinkingLevel(args[0]);
  if (!next) {
    await message.reply(`Invalid effort: ${args[0]}\n${formatThinkingUsage()}`);
    return;
  }
  setCurrentThinking(next);
  await message.reply(`Effort set to: ${next}`);
}

async function handleThreadAgentCommand(message: Message, args: string[], config: Config): Promise<void> {
  const subcommand = (args[0] || 'show').toLowerCase();

  if (subcommand === 'list') {
    const profiles = listAgentProfiles();
    if (profiles.length === 0) {
      await message.reply('No Discord agent profiles configured.');
      return;
    }
    const profileText = profiles.map(formatAgentProfile).join('\n\n');
    await sendLongText(message, `Profiles:\n${profileText}`);
    return;
  }

  const isThread = isDiscordThreadChannel(message.channel);
  if (subcommand === 'show' || subcommand === 'status') {
    if (!isThread) {
      await message.reply(THREAD_AGENT_USAGE);
      return;
    }
    const record = getThreadAgentByThreadId(message.channel.id);
    await message.reply(record ? formatThreadAgent(record) : `No agent profile is active in this thread.\n\n${THREAD_AGENT_USAGE}`);
    return;
  }

  if (subcommand === 'create') {
    const alias = args[1];
    const agentId = resolveConfiguredAgentId(config, args[2]);
    if (!alias || !agentId) {
      await message.reply(`Usage: /agent create <alias> [agent-id]\nConfigured agents: ${formatAgentIds(config)}`);
      return;
    }
    try {
      const profile = upsertAgentProfile({
        alias,
        agentId,
        createdBy: message.author.id,
      });
      await message.reply(`Configured agent profile ${formatAgentProfile(profile)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await message.reply(`Error: ${msg}`);
    }
    return;
  }

  if (subcommand === 'use') {
    const alias = args[1];
    const profile = getAgentProfileByAlias(alias);
    if (!alias || !profile) {
      await message.reply(`Usage: /agent use <alias> [message]\nKnown profiles: ${listAgentProfiles().map(p => p.alias).join(', ') || '(none)'}`);
      return;
    }
    const initialPrompt = args.slice(2).join(' ').trim();
    try {
      const targetChannel = isThread
        ? message.channel
        : await createThreadAgentThread(message, profile.alias, initialPrompt);
      if (!targetChannel) {
        await message.reply('Agent profiles can only run in a Discord thread or from a channel where I can create one.');
        return;
      }
      const record = bindThreadAgent({
        threadId: targetChannel.id,
        alias: profile.alias,
        createdBy: message.author.id,
        guildId: message.guildId,
        channelId: targetChannel.isThread() ? targetChannel.parentId ?? message.channelId : message.channelId,
      });
      const url = buildThreadUrl(message.guildId, targetChannel.id);
      await message.reply(!isThread && url
        ? `Started @${profile.alias}: ${url}`
        : `This thread now uses ${formatAgentProfile(profile)}`);
      if (initialPrompt) {
        await runThreadAgentPrompt(message, targetChannel, record, initialPrompt, config, {
          announceTask: !isThread,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await message.reply(`Error: ${msg}`);
    }
    return;
  }

  if (subcommand === 'prompt') {
    let alias: string | undefined;
    let promptStart = 1;
    const attachmentPrompt = await readPromptAttachment(message);
    if (attachmentPrompt.error) {
      await message.reply(attachmentPrompt.error);
      return;
    }
    if (args[1]) {
      const candidateAlias = normalizeAliasArg(args[1]);
      if ((attachmentPrompt.text && args.length === 2) || (args.length > 2 && getAgentProfileByAlias(candidateAlias))) {
        alias = args[1];
        promptStart = 2;
      }
    }
    const inlinePrompt = args.slice(promptStart).join(' ').trim();
    const prompt = attachmentPrompt.text || inlinePrompt;
    if (!prompt) {
      await message.reply('Usage: /agent prompt [@alias] <prompt text>\nYou can also attach a .txt or .md file.');
      return;
    }
    if (prompt.length > AGENT_PROMPT_MAX_CHARS) {
      await message.reply(`Prompt is too long. Keep agent prompts under ${AGENT_PROMPT_MAX_CHARS.toLocaleString()} characters.`);
      return;
    }
    const target = getAgentProfileCommandTarget(message, alias);
    if (!target.profile) {
      await message.reply(`${target.error || 'No target agent profile found.'}\n\n${THREAD_AGENT_USAGE}`);
      return;
    }
    const profile = setAgentProfilePrompt(target.profile.alias, prompt);
    if (!profile) return;
    const source = attachmentPrompt.filename ? ` from ${attachmentPrompt.filename}` : '';
    await message.reply(`Updated prompt for @${profile.alias}${source}.`);
    return;
  }

  if (subcommand === 'model') {
    let alias: string | undefined;
    let modelStart = 1;
    if (args[1] && args.length > 2) {
      alias = args[1];
      modelStart = 2;
    }
    const modelInput = args.slice(modelStart).join(' ').trim();
    if (!modelInput) {
      await message.reply(`Usage: /agent model [agent-alias] <model-alias|provider/model|model-id>\nAvailable model aliases: ${formatAliases(config)}`);
      return;
    }
    const selection = resolveModelSelection(modelInput, config);
    if (!selection.ok || !selection.resolved) {
      await message.reply(formatModelSelectionError(selection.error || 'Invalid model selection', config));
      return;
    }
    const target = getOrCreateAgentProfileCommandTarget(message, config, alias);
    if (!target.profile) {
      await message.reply(`${target.error || 'No target agent profile found.'}\n\n${THREAD_AGENT_USAGE}`);
      return;
    }
    const profile = setAgentProfileModel(target.profile.alias, selection.resolved);
    if (!profile) return;
    const aliasText = selection.aliasUsed ? ` (${selection.aliasUsed})` : '';
    const createdText = target.created ? `Created agent profile @${profile.alias} -> ${profile.agentId}\n` : '';
    await message.reply(`${createdText}Updated model for @${profile.alias}: ${selection.resolved}${aliasText}`);
    return;
  }

  if (subcommand === 'think' || subcommand === 'effort') {
    let alias: string | undefined;
    let effortArg = args[1];
    if (args[1] && args.length > 2) {
      alias = args[1];
      effortArg = args[2];
    }
    const next = parseThinkingLevel(effortArg);
    if (!effortArg || !next) {
      await message.reply(`Usage: /agent ${subcommand} [agent-alias] <${THINKING_LEVELS.join('|')}>`);
      return;
    }
    const target = getOrCreateAgentProfileCommandTarget(message, config, alias);
    if (!target.profile) {
      await message.reply(`${target.error || 'No target agent profile found.'}\n\n${THREAD_AGENT_USAGE}`);
      return;
    }
    const profile = setAgentProfileThinking(target.profile.alias, next);
    if (!profile) return;
    const createdText = target.created ? `Created agent profile @${profile.alias} -> ${profile.agentId}\n` : '';
    await message.reply(`${createdText}Updated effort for @${profile.alias}: ${next}`);
    return;
  }

  if (subcommand === 'clear-model') {
    const target = getAgentProfileCommandTarget(message, args[1]);
    if (!target.profile) {
      await message.reply(target.error || 'No target agent profile found.');
      return;
    }
    const profile = setAgentProfileModel(target.profile.alias, undefined);
    await message.reply(profile ? `Cleared model override for @${profile.alias}.` : 'No target agent profile found.');
    return;
  }

  if (subcommand === 'clear-think' || subcommand === 'clear-effort') {
    const target = getAgentProfileCommandTarget(message, args[1]);
    if (!target.profile) {
      await message.reply(target.error || 'No target agent profile found.');
      return;
    }
    const profile = setAgentProfileThinking(target.profile.alias, undefined);
    await message.reply(profile ? `Cleared effort override for @${profile.alias}.` : 'No target agent profile found.');
    return;
  }

  if (subcommand === 'clear-prompt') {
    const target = getAgentProfileCommandTarget(message, args[1]);
    if (!target.profile) {
      await message.reply(target.error || 'No target agent profile found.');
      return;
    }
    const profile = setAgentProfilePrompt(target.profile.alias, undefined);
    await message.reply(profile ? `Cleared prompt for @${profile.alias}.` : 'No target agent profile found.');
    return;
  }

  if (subcommand === 'delete') {
    const alias = args[1];
    if (!alias) {
      await message.reply('Usage: /agent delete <alias>');
      return;
    }
    const removed = removeAgentProfile(alias);
    await message.reply(removed ? `Deleted agent profile @${normalizeAliasArg(alias)} and its thread bindings.` : `No Discord agent profile found for @${normalizeAliasArg(alias)}.`);
    return;
  }

  await message.reply(THREAD_AGENT_USAGE);
}

export async function handleCommand(
  message: Message,
  command: string,
  args: string[],
  config: Config,
  silenceUntil: Date | null,
  setSilenceUntil: (d: Date | null) => void,
): Promise<void> {
  const rawArgs = args.join(' ').trim();

  if (command === 'start' || command === 'help') {
    await sendLongText(message, buildHelpText(config));
    return;
  }

  if (command === 'agent') {
    await handleThreadAgentCommand(message, args, config);
    return;
  }

  if (command === 'effort' || command === 'think') {
    await handleEffortCommand(message, args);
    return;
  }

  if (command === 'model') {
    if (!rawArgs) {
      const current = getCurrentModel();
      const aliases = formatAliases(config);
      await message.reply(`Current: ${current}\nAliases: ${aliases}\n\nUsage: /model <alias|provider/model|model-id>\n${getModelSelectionUsage()}`);
      return;
    }
    const selection = resolveModelSelection(rawArgs, config);
    if (!selection.ok || !selection.resolved) {
      const errorMessage = selection.error || 'Invalid model selection';
      await message.reply(formatModelSelectionError(errorMessage, config));
      return;
    }
    setCurrentModel(selection.resolved);
    if (selection.aliasUsed) {
      await message.reply(`Model switched to: ${selection.aliasUsed} (${selection.resolved})`);
    } else {
      await message.reply(`Model switched to: ${selection.resolved}`);
    }
    return;
  }

  if (command === 'status') {
    const model = getCurrentModel();
    const effort = getCurrentThinking();
    const { getLastMessage } = await import('../../gateway.js');
    const last = getLastMessage();
    const jobs = getCronJobs();
    const jobList = jobs.map(j => `- ${j.name}: ${j.nextRun?.toLocaleString() || 'unknown'}`).join('\n');

    const caActive = getActiveCodeAgents();
    const caRecent = getRecentCodeAgents(3);
    const caAll = [...caActive, ...caRecent];
    let caLine = 'Coding Agents: idle';
    if (caAll.length > 0) {
      const runningCount = caActive.length;
      const completedCount = caRecent.filter(t => t.status === 'completed').length;
      const failedCount = caRecent.filter(t => t.status === 'failed' || t.status === 'timeout').length;
      const parts: string[] = [];
      if (runningCount) parts.push(`${runningCount} running`);
      if (completedCount) parts.push(`${completedCount} completed`);
      if (failedCount) parts.push(`${failedCount} failed`);
      caLine = `Coding Agents: ${parts.join(', ') || 'idle'}`;
      const caPreview = caAll.slice(0, 5).map(t => {
        const elapsed = t.durationSeconds != null
          ? (t.durationSeconds < 60 ? `${t.durationSeconds}s` : `${Math.floor(t.durationSeconds / 60)}m ${t.durationSeconds % 60}s`)
          : (Math.round((Date.now() - new Date(t.startedAt).getTime()) / 1000) + 's');
        const taskPreview = t.task.length > 50 ? t.task.slice(0, 50) + '...' : t.task;
        return `  ${t.id}: ${t.status.toUpperCase()} (${t.agent}, ${elapsed}) — ${taskPreview}`;
      }).join('\n');
      if (caPreview) caLine += '\n' + caPreview;
    }

    await message.reply(
      `Agent: ${config.agents.default}\n` +
      `Model: ${model}\n` +
      `Effort: ${effort || 'default'}\n` +
      `Last message: ${last?.toLocaleString() || 'never'}\n` +
      `Silence until: ${silenceUntil?.toLocaleString() || 'not silenced'}\n\n` +
      `${caLine}\n\n` +
      `Scheduled jobs:\n${jobList || '(none)'}`
    );
    return;
  }

  if (command === 'cron') {
    const subcommand = args[0];
    if (!subcommand || subcommand === 'list') {
      const jobs = getCronJobs();
      if (jobs.length === 0) {
        await message.reply('No scheduled jobs.');
        return;
      }
      const list = jobs.map(j => `${j.id}: ${j.name} (next: ${j.nextRun?.toLocaleString() || '?'})`).join('\n');
      await message.reply(`Scheduled jobs:\n${list}`);
      return;
    }

    if (subcommand === 'run') {
      const jobId = args[1];
      if (!jobId) {
        await message.reply('Usage: /cron run <job-id>');
        return;
      }
      try {
        await runCronJob(jobId, config);
        await message.reply(`Triggered: ${jobId}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        await message.reply(`Error: ${msg}`);
      }
      return;
    }

    await message.reply('Usage: /cron list | /cron run <id>');
    return;
  }

  if (command === 'heartbeat') {
    const stopTyping = startTypingIndicator(message);
    try {
      const response = await runHeartbeatCheck(config);
      await sendLongText(message, `Heartbeat:\n\n${response}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await message.reply(`Heartbeat error: ${msg}`);
    } finally {
      stopTyping();
    }
    return;
  }

  if (command === 'approvals') {
    const pending = listApprovals();
    if (pending.length === 0) {
      await message.reply('No pending exec approvals.');
      return;
    }

    for (const approval of pending.slice(0, 10)) {
      const cmdPreview = approval.command.length > 80
        ? approval.command.slice(0, 80) + '...'
        : approval.command;
      const expiresIn = Math.max(0, Math.round((approval.expiresAt.getTime() - Date.now()) / 1000));
      const expiresStr = expiresIn < 60 ? `${expiresIn}s` : `${Math.floor(expiresIn / 60)}m`;

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve:${approval.id}`)
          .setLabel('Approve')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`deny:${approval.id}`)
          .setLabel('Deny')
          .setStyle(ButtonStyle.Danger),
      );

      await message.reply({
        content:
          `⛔ Approval #${approval.id}\n` +
          `Tier ${approval.tier}: ${approval.reason}\n` +
          `Command: ${cmdPreview}\n` +
          `${approval.cwd ? `CWD: ${approval.cwd}\n` : ''}` +
          `Expires in: ${expiresStr}`,
        components: [row],
      });
    }
    return;
  }

  if (command === 'approve') {
    const id = rawArgs;
    if (!id) {
      await message.reply('Usage: /approve <id>');
      return;
    }
    const by = message.author.username || message.author.id;
    const success = approveRequest(id, by);
    if (success) {
      await message.reply(`✅ Approved #${id}`);
    } else {
      const existing = getApproval(id);
      if (existing) {
        await message.reply(`Cannot approve #${id} — status is already "${existing.status}".`);
      } else {
        await message.reply(`No pending approval found with ID "${id}".`);
      }
    }
    return;
  }

  if (command === 'deny') {
    const id = rawArgs;
    if (!id) {
      await message.reply('Usage: /deny <id>');
      return;
    }
    const by = message.author.username || message.author.id;
    const success = denyRequest(id, by);
    if (success) {
      await message.reply(`❌ Denied #${id}`);
    } else {
      const existing = getApproval(id);
      if (existing) {
        await message.reply(`Cannot deny #${id} — status is already "${existing.status}".`);
      } else {
        await message.reply(`No pending approval found with ID "${id}".`);
      }
    }
    return;
  }

  if (command === 'tasks') {
    await message.reply('Use `/agents` to list active coding agents, or `/cron` to manage scheduled tasks.');
    return;
  }

  if (command === 'cancel') {
    await message.reply('Use the dashboard to cancel coding agents, or `/cron` to manage scheduled tasks.');
    return;
  }

  if (command === 'clear') {
    await clearHistory(conversationKey(message));
    await message.reply('Conversation cleared. Starting fresh.');
    return;
  }

  if (command === 'compact') {
    const key = conversationKey(message);
    const history = await getHistory(key);
    if (history.length === 0) {
      await message.reply('No conversation history to compact.');
      return;
    }

    const stopTyping = startTypingIndicator(message);
    try {
      const historyText = history.map(m => `${m.role}: ${m.content}`).join('\n');
      const summary = await runAgentTurn(
        config.agents.default,
        `Summarize this conversation in 2-3 sentences so you can remember the context:\n\n${historyText}`,
        config,
        getCurrentModel(),
        undefined,
        undefined,
        getDiscordRunContext(message),
      );
      await clearHistory(key);
      replaceHistory(key, summary);
      await sessions.replaceWithSummary('discord', key, summary);
      await message.reply(`Compacted ${history.length} messages into a summary.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await message.reply(`Error: ${msg}`);
    } finally {
      stopTyping();
    }
    return;
  }

  if (command === 'silence') {
    const minutes = parseInt(rawArgs, 10) || 30;
    const until = new Date(Date.now() + minutes * 60 * 1000);
    setSilenceUntil(until);
    await message.reply(`Proactive messages silenced until ${until.toLocaleTimeString()}`);
    return;
  }

  await message.reply(`Unknown command: /${command}\n\nType /help to see available commands.`);
}

// ── Incoming message handler ────────────────────────────────────────

export async function handleIncomingMessage(message: Message, config: Config): Promise<void> {
  if (message.author.bot) return;
  if (!config.channels.discord) return;

  console.log(
    `[discord] Received message from ${message.author.id} in ${message.channelId}: ${JSON.stringify(message.content).slice(0, 120)}`
  );

  const senderId = message.author.id;
  const senderUsername = message.author.username;
  if (!isAllowed(config.channels.discord.allowFrom, senderId, senderUsername)) {
    console.log(`[discord] Blocked message from ${senderId} (@${senderUsername})`);
    return;
  }

  if (isRateLimited(senderId)) {
    await message.reply('Too many messages. Please wait a moment.');
    return;
  }

  // Interactive coding session intercept: if this is a thread bound to an active
  // interactive session, route the message to --resume instead of the main agent.
  if (message.channel.isThread()) {
    try {
      const session = getSession(message.channel.id);
      if (session) {
        const stopTyping = startTypingIndicator(message);
        try {
          await handleInteractiveThreadMessage({
            discordThreadId: message.channel.id,
            userMessage: message.content,
            postToThread: async (chunks) => {
              for (const c of chunks) {
                await (message.channel as any).send(c);
              }
            },
          });
        } finally {
          stopTyping();
        }
        return;
      }
    } catch (err) {
      console.error('[discord] Interactive-session intercept failed:', err);
      // fall through to normal handling
    }
  }

  // Check for image attachments
  const imageAttachments = message.attachments.filter(
    a => a.contentType?.startsWith('image/')
  );

  if (imageAttachments.size > 0) {
    const attachment = imageAttachments.first()!;
    const stopTyping = startTypingIndicator(message);

    try {
      const imageResponse = await fetch(attachment.url);
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const base64Image = imageBuffer.toString('base64');
      const mediaType = attachment.contentType || 'image/jpeg';
      const caption = message.content.trim() || "What's in this image?";

      const content: import('../../types.js').ContentBlock[] = [
        {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: mediaType,
            data: base64Image,
          },
        },
        {
          type: 'text' as const,
          text: caption,
        },
      ];

      const key = conversationKey(message);
      const history = await getHistory(key);
      const threadAgent = getThreadAgentForMessage(message, config);
    const response = await runAgentTurn(
      threadAgent?.agentId || config.agents.default,
      content,
      config,
      threadAgent?.model || getCurrentModel(),
      getDiscordToolConfig(config),
        history,
        getThreadAgentRunContext(message, threadAgent)
      );

      await addToHistory(key, `[Image: ${caption}]`, response);
      await sendLongText(message, response);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await message.reply(`Error processing image: ${msg}`);
    } finally {
      stopTyping();
    }
    return;
  }

  // Check for document attachments (txt, pdf, etc.)
  const docAttachments = message.attachments.filter(a => isDocumentAttachment(a));

  if (docAttachments.size > 0) {
    const stopTyping = startTypingIndicator(message);

    try {
      const results = await processAttachments([...docAttachments.values()]);
      const extracted: string[] = [];
      const errors: string[] = [];

      for (const r of results) {
        if (r.ok && r.text) {
          extracted.push(`--- ${r.filename} ---\n${r.text}`);
        } else if (r.error) {
          errors.push(r.error);
        }
      }

      if (errors.length > 0 && extracted.length === 0) {
        // All attachments failed
        const supported = supportedExtensions().map(e => `.${e}`).join(', ');
        await message.reply(
          errors.join('\n') + `\n\nSupported file types: ${supported}`
        );
        return;
      }

      // Build context: extracted text + user's message (or default prompt)
      const userText = message.content.trim() || 'Please read and summarize the attached file(s).';
      const attachmentContext = extracted.join('\n\n');
      const prompt = `The user uploaded the following file(s):\n\n${attachmentContext}\n\n${userText}`;

      // Include any errors as a note
      const errorNote = errors.length > 0
        ? `\n\n(Note: some attachments could not be processed: ${errors.join('; ')})`
        : '';

      const key = conversationKey(message);
      const history = await getHistory(key);
      const threadAgent = getThreadAgentForMessage(message, config);
    const response = await runAgentTurn(
      threadAgent?.agentId || config.agents.default,
      prompt + errorNote,
      config,
      threadAgent?.model || getCurrentModel(),
      getDiscordToolConfig(config),
        history,
        getThreadAgentRunContext(message, threadAgent)
      );

      const filenames = results.map(r => r.filename).join(', ');
      await addToHistory(key, `[Attachments: ${filenames}] ${userText}`, response);
      await sendLongText(message, response);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await message.reply(`Error processing attachment(s): ${msg}`);
    } finally {
      stopTyping();
    }
    return;
  }

  // Check for voice message attachments
  const voiceAttachments = message.attachments.filter(
    a => a.contentType?.startsWith('audio/') || a.contentType?.startsWith('voice/')
  );

  if (voiceAttachments.size > 0) {
    const attachment = voiceAttachments.first()!;
    const stopTyping = startTypingIndicator(message);

    try {
      if (!config.voice) {
        await message.reply('Voice transcription not configured. Add a "voice" section to config.json.');
        return;
      }

      const voiceResponse = await fetch(attachment.url);
      const buffer = Buffer.from(await voiceResponse.arrayBuffer());

      const ext = attachment.name?.split('.').pop() || 'ogg';
      const tempDir = join(tmpdir(), 'skimpyclaw-voice');
      if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
      const tempPath = join(tempDir, `discord-voice-${Date.now()}.${ext}`);
      writeFileSync(tempPath, buffer);

      try {
        const result = await transcribeAudio(tempPath, config.voice);
        const transcription = result.text.trim();
        console.log(`[discord] Transcription result: ${transcription}`);

        if (!transcription) {
          await message.reply('Could not transcribe audio — no speech detected.');
          return;
        }

        const key = conversationKey(message);
        const history = await getHistory(key);
        const threadAgent = getThreadAgentForMessage(message, config);
        const agentResponse = await runAgentTurn(
          threadAgent?.agentId || config.agents.default,
          transcription,
          config,
          threadAgent?.model || getCurrentModel(),
          getDiscordToolConfig(config),
          history,
          getThreadAgentRunContext(message, threadAgent)
        );
        await addToHistory(key, transcription, agentResponse);

        console.log('[discord] TTS check - sendVoice:', config.voice?.channels?.['discord']?.sendVoice);
        if (config.voice?.channels?.['discord']?.sendVoice) {
          console.log('[discord] Attempting TTS synthesis...');
          try {
            const speech = await synthesizeSpeech(agentResponse, config.voice);
            console.log('[discord] TTS synthesis success:', speech.format, speech.provider, 'buffer size:', speech.buffer.length);
            const voiceAttachment = new AttachmentBuilder(Buffer.from(speech.buffer), {
              name: `voice-reply.${speech.format}`,
              description: 'Voice reply'
            });
            await message.reply({ files: [voiceAttachment] });
            console.log('[discord] Voice reply sent');
          } catch (err) {
            console.error('[discord] TTS synthesis failed:', err);
          }
        }

        const combined = `> 🎤 ${transcription}\n\n${agentResponse}`;
        await sendLongText(message, combined);
      } finally {
        try {
          unlinkSync(tempPath);
        } catch { /* best effort */ }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await message.reply(`Voice transcription error: ${msg}`);
    } finally {
      stopTyping();
    }
    return;
  }

  const text = message.content.trim();
  if (!text) return;

  if (await runMentionedAgentPrompt(message, text, config)) {
    return;
  }

  const isPrefixedCommand = text.startsWith('/') || text.startsWith('!');
  const isDm = message.channel.isDMBased();
  if (isPrefixedCommand || isDm) {
    const commandText = isPrefixedCommand ? text.slice(1).trim() : text;
    const [commandPart, ...cmdArgs] = commandText.split(/\s+/);
    const command = (commandPart || '').toLowerCase();
    if (!KNOWN_COMMANDS.has(command)) {
      if (isPrefixedCommand) {
        await message.reply(`Unknown command: /${command}\n\nType /help to see available commands.`);
        return;
      }
    } else {
      // handleCommand is called from index.ts which passes silenceUntil/setter
      // For DM free-text that happens to match a command, delegate up
      return;
    }
  }

  const key = conversationKey(message);
  const stopTyping = startTypingIndicator(message);

  try {
    const history = await getHistory(key);
    const threadAgent = getThreadAgentForMessage(message, config);
    const codeAgentContext = buildCodeAgentThreadContext(message);
    const prompt = codeAgentContext
      ? `${codeAgentContext}\n\nUser message in this Discord thread:\n${text}`
      : text;
    const response = await runAgentTurn(
      threadAgent?.agentId || config.agents.default,
      prompt,
      config,
      threadAgent?.model || getCurrentModel(),
      getDiscordToolConfig(config),
      history,
      getThreadAgentRunContext(message, threadAgent)
    );
    await addToHistory(key, text, response);
    await sendLongText(message, response);

    // If the response started coding agent(s), create threads for status updates.
    // Only consider tasks started within the current turn (last 2 min) — older
    // unthreaded tasks are stale registry entries that will steal the single
    // thread Discord allows per message.
    const useThreads = config.channels.discord?.threadedReplies !== false;
    if (useThreads && !message.channel.isDMBased()) {
      try {
        const { getUnthreadedTasksForChat, writeCodeAgentTask } = await import('../../code-agents/registry.js');
        const chatId = Number(message.channel.id);
        const freshnessCutoffMs = Date.now() - 2 * 60 * 1000;
        const unthreadedTasks = getUnthreadedTasksForChat(chatId).filter(t => {
          const started = Date.parse(t.startedAt);
          return Number.isFinite(started) && started >= freshnessCutoffMs;
        });
        const isThread = message.channel.isThread();
        for (const task of unthreadedTasks) {
          let assignedThreadId: string | undefined;
          if (isThread) {
            // Already in a thread — use it directly instead of creating a sub-thread
            task.discordThreadId = message.channel.id;
            task.discordChannelId = message.channel.parentId ?? message.channelId;
            writeCodeAgentTask(task);
            assignedThreadId = task.discordThreadId;
          } else {
            const taskPreview = task.task.length > 90 ? task.task.slice(0, 90) + '...' : task.task;
            const threadId = await createTaskThread(message, task.id, taskPreview);
            if (threadId) {
              task.discordThreadId = threadId;
              task.discordChannelId = message.channelId;
              writeCodeAgentTask(task);
              assignedThreadId = threadId;
              // Post a clickable link to the new thread for easy mobile access.
              const url = buildThreadUrl(message.guildId, threadId);
              if (url) {
                try {
                  await (message.channel as any).send(`→ ${task.interactive ? 'Interactive session' : 'Thread'} ${task.id}: ${url}`);
                } catch (err) {
                  console.warn(`[discord] Failed to post thread link for ${task.id}:`, err);
                }
              }
            }
          }
          // Promote any pending interactive session from taskId-keyed to threadId-keyed.
          if (assignedThreadId && task.interactive) {
            try {
              linkThread(task.id, assignedThreadId);
            } catch (err) {
              console.error(`[discord] Failed to link interactive session ${task.id} → ${assignedThreadId}:`, err);
            }
          }
        }
      } catch (err) {
        console.error(`[discord] Failed to create threads for spawned tasks:`, err);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    await message.reply(`Error: ${msg}`);
  } finally {
    stopTyping();
  }
}

// ── Approval card ───────────────────────────────────────────────────

export async function sendApprovalCard(client: Client, channelId: string, approval: PendingApproval): Promise<void> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !('send' in channel) || typeof channel.send !== 'function') return;

  const cmdPreview = approval.command.length > 80
    ? approval.command.slice(0, 80) + '...'
    : approval.command;
  const expiresIn = Math.max(0, Math.round((approval.expiresAt.getTime() - Date.now()) / 1000));
  const expiresStr = expiresIn < 60 ? `${expiresIn}s` : `${Math.floor(expiresIn / 60)}m`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve:${approval.id}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`deny:${approval.id}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger),
  );

  await (channel as { send: (opts: any) => Promise<unknown> }).send({
    content:
      `⛔ Exec approval needed: #${approval.id}\n` +
      `Tier ${approval.tier}: ${approval.reason}\n` +
      `Command: ${cmdPreview}\n` +
      `${approval.cwd ? `CWD: ${approval.cwd}\n` : ''}` +
      `Expires in: ${expiresStr}`,
    components: [row],
  });
}

// ── Button interaction handler ──────────────────────────────────────

export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;
  const [action, id] = customId.split(':');
  if (!id || (action !== 'approve' && action !== 'deny')) {
    await interaction.reply({ content: 'Unknown action', ephemeral: true });
    return;
  }

  const by = interaction.user.username || interaction.user.id;
  let success: boolean;
  let statusText: string;

  if (action === 'approve') {
    success = approveRequest(id, by);
    statusText = success ? `✅ Approved by @${by}` : 'Failed — not pending';
  } else {
    success = denyRequest(id, by);
    statusText = success ? `❌ Denied by @${by}` : 'Failed — not pending';
  }

  await interaction.reply({ content: statusText, ephemeral: true });

  try {
    const approval = getApproval(id);
    if (approval) {
      const cmdPreview = approval.command.length > 80
        ? approval.command.slice(0, 80) + '...'
        : approval.command;
      await interaction.message.edit({
        content:
          `${statusText}\n\n` +
          `Approval #${id}\n` +
          `Tier ${approval.tier}: ${approval.reason}\n` +
          `Command: ${cmdPreview}`,
        components: [],
      });
    }
  } catch {
    // Message may already be edited or deleted
  }
}
