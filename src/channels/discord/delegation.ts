import { ChannelType, type Client, type Message } from 'discord.js';
import type { AgentRunContext, Config } from '../../types.js';
import { runAgentTurn } from '../../agent.js';
import { getCurrentModel, getCurrentThinking } from '../../gateway.js';
import type { ExecuteToolContext } from '../../tools/execute-context.js';
import type { NormalizedDelegateToAgentInput } from '../../tools/agent-delegation.js';
import {
  bindThreadAgent,
  getAgentProfileByAlias,
  type DiscordThreadAgent,
} from './thread-agents.js';
import {
  addToHistory,
  getDiscordToolConfig,
  getHistory,
  sendLongTextToChannel,
  startTypingIndicatorForChannel,
} from './utils.js';
import { buildThreadUrl } from './threads.js';
import { runConversationTurn } from '../../conversation-queue.js';

type SendableTextChannel = {
  id: string;
  type?: number;
  send: (content: string) => Promise<Message>;
  threads?: unknown;
};

type AgentRunChannel = {
  id: string;
  guildId?: string | null;
  parentId?: string | null;
  send?: (content: string) => Promise<unknown>;
  sendTyping?: () => Promise<unknown>;
};

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

function isThreadLike(channel: unknown): channel is { parentId?: string | null } {
  return Boolean((channel as { isThread?: () => boolean }).isThread?.());
}

function canStartThreadFromMessage(message: Message): boolean {
  return typeof (message as { startThread?: unknown }).startThread === 'function';
}

function truncateTask(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3).trim()}...`;
}

function buildRunContext(
  context: ExecuteToolContext | undefined,
  threadAgent: DiscordThreadAgent,
  parentChannelId: string | undefined,
): AgentRunContext {
  const depth = (context?.delegationDepth ?? 0) + 1;
  return {
    userId: context?.approverUserId,
    sessionId: threadAgent.threadId,
    channel: 'discord',
    trigger: 'discord',
    metadata: {
      username: context?.approverUsername,
      isDm: false,
      discordThreadId: threadAgent.threadId,
      discordChannelId: parentChannelId,
      isCronJob: context?.isCronJob === true,
      threadAgentAlias: threadAgent.alias,
      threadAgentId: threadAgent.agentId,
      threadAgentModel: threadAgent.model,
      threadAgentThinking: threadAgent.thinking,
      thinkingOverride: threadAgent.thinking ?? getCurrentThinking(),
      threadAgentPromptOverlay: threadAgent.promptOverlay,
      delegationDepth: depth,
      delegatedFromAgentAlias: context?.threadAgentAlias,
    },
  };
}

async function runDelegatedAgent(
  thread: AgentRunChannel,
  parentChannelId: string | undefined,
  threadAgent: DiscordThreadAgent,
  task: string,
  config: Config,
  context?: ExecuteToolContext,
): Promise<string> {
  return runConversationTurn(`discord:channel:${thread.id}`, async () => {
    await sendLongTextToChannel(
      thread,
      `Task delegated to @${threadAgent.alias}:\n${task}`,
    );

    const stopTyping = startTypingIndicatorForChannel(thread);
    try {
      const key = `channel:${thread.id}`;
      const history = await getHistory(key);
      const response = await runAgentTurn(
        threadAgent.agentId,
        task,
        config,
        threadAgent.model || getCurrentModel(),
        getDiscordToolConfig(config),
        history,
        buildRunContext(context, threadAgent, parentChannelId),
      );
      await addToHistory(key, task, response);
      await sendLongTextToChannel(thread, response, config);
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sendLongTextToChannel(
        thread,
        `Error: ${msg}`,
      );
      throw err;
    } finally {
      stopTyping();
    }
  });
}

async function resolveDelegationParentChannel(
  client: Client,
  context?: ExecuteToolContext,
): Promise<SendableTextChannel | null> {
  const sourceChannelId = context?.discordChannelId || context?.discordThreadId || context?.channelTargetId || context?.sessionId;
  if (!sourceChannelId) return null;

  const channel = await client.channels.fetch(String(sourceChannelId)).catch(() => null);
  if (!channel) return null;

  if (isThreadLike(channel)) {
    const parentId = channel.parentId;
    if (!parentId) return null;
    const parent = await client.channels.fetch(parentId).catch(() => null);
    return parent && 'send' in parent ? parent as unknown as SendableTextChannel : null;
  }

  const channelType = (channel as { type?: number }).type;
  const supportsThreads = channelType === ChannelType.GuildText || channelType === ChannelType.GuildAnnouncement;
  if (!supportsThreads || !('send' in channel)) return null;
  return channel as unknown as SendableTextChannel;
}

export function createDiscordAgentDelegateHandler(
  getClient: () => Client | null,
): ((
  input: NormalizedDelegateToAgentInput,
  config: Config,
  context?: ExecuteToolContext,
) => Promise<string>) {
  return async (input, config, context) => {
    const client = getClient();
    if (!client) return 'Error: Discord client is not available.';

    const profile = getAgentProfileByAlias(input.alias);
    if (!profile) return `Error: No Discord agent profile found for @${input.alias}.`;
    if (!config.agents.list[profile.agentId]) {
      return `Error: Agent profile @${profile.alias} points to missing configured agent "${profile.agentId}".`;
    }

    const parentChannel = await resolveDelegationParentChannel(client, context);
    if (!parentChannel) {
      return 'Error: Could not find a Discord server channel where I can create a delegated agent thread.';
    }

    const preview = truncateTask(input.task, 300);
    const starter = await parentChannel.send(`Delegating to @${profile.alias}:\n${preview}`);
    if (!canStartThreadFromMessage(starter)) {
      return 'Error: Discord did not allow creating a thread for this delegated agent.';
    }

    const thread = await starter.startThread({
      name: formatThreadAgentThreadName(profile.alias, input.task),
      autoArchiveDuration: 1440,
    });

    const threadAgent = bindThreadAgent({
      threadId: thread.id,
      alias: profile.alias,
      createdBy: context?.approverUserId || 'agent-delegation',
      guildId: thread.guildId,
      channelId: thread.parentId ?? parentChannel.id,
    });

    const url = buildThreadUrl(thread.guildId, thread.id);
    const runner = runDelegatedAgent(thread, thread.parentId ?? parentChannel.id, threadAgent, input.task, config, context);
    if (input.wait) {
      await runner;
    } else {
      void runner.catch((err) => {
        console.error('[discord-agent-delegation] Delegated agent failed:', err);
      });
    }

    return url
      ? `Delegated to @${profile.alias}: ${url}`
      : `Delegated to @${profile.alias} in thread ${thread.id}.`;
  };
}
