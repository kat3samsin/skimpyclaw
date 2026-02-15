import { Client, GatewayIntentBits, Partials, type Message } from 'discord.js';
import { join } from 'path';
import { homedir } from 'os';
import type { AgentRunContext, ChatMessage, Config, ToolConfig } from './types.js';
import { getCurrentModel, setCurrentModel, getLastMessage } from './gateway.js';
import { getCronJobs, runCronJob } from './cron.js';
import { runAgentTurn } from './agent.js';
import { runHeartbeatCheck } from './heartbeat.js';
import { isAllowed, isRateLimited } from './security.js';
import { readCodeAgentStatus } from './tools.js';

function getDiscordRunContext(message: Message): AgentRunContext {
  return {
    userId: message.author.id,
    sessionId: message.channel.id,
    channel: 'discord',
    trigger: 'discord',
    metadata: {
      username: message.author.username,
    },
  };
}

const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'help', description: 'Show available commands' },
  { command: 'model', description: 'Switch model (fast/smart/opus)' },
  { command: 'status', description: 'Show bot status' },
  { command: 'new', description: 'Clear conversation history' },
  { command: 'compact', description: 'Compress conversation history' },
  { command: 'silence', description: 'Pause proactive messages' },
  { command: 'cron', description: 'List or run scheduled jobs' },
  { command: 'heartbeat', description: 'Trigger heartbeat check' },
];

const KNOWN_COMMANDS = new Set(BOT_COMMANDS.map(c => c.command));

const MAX_HISTORY_PAIRS = 5;
const chatHistory = new Map<string, ChatMessage[]>();

const DEFAULT_DISCORD_TOOLS: ToolConfig = {
  enabled: true,
  allowedPaths: [join(homedir(), '.skimpyclaw'), process.cwd()],
  maxIterations: 100,
  bashTimeout: 15000,
};

let client: Client | null = null;
let config: Config;
let silenceUntil: Date | null = null;

function getHistory(key: string): ChatMessage[] {
  return chatHistory.get(key) || [];
}

function addToHistory(key: string, userMsg: string, assistantMsg: string): void {
  const history = getHistory(key);
  history.push({ role: 'user', content: userMsg });
  history.push({ role: 'assistant', content: assistantMsg });
  while (history.length > MAX_HISTORY_PAIRS * 2) {
    history.shift();
    history.shift();
  }
  chatHistory.set(key, history);
}

function clearHistory(key: string): void {
  chatHistory.delete(key);
}

function getDiscordToolConfig(cfg: Config): ToolConfig {
  const discord = cfg.channels.discord;
  if (discord?.tools) {
    return {
      ...DEFAULT_DISCORD_TOOLS,
      ...discord.tools,
      allowedPaths: discord.tools.allowedPaths ?? discord.defaultAllowedPaths ?? DEFAULT_DISCORD_TOOLS.allowedPaths,
    };
  }
  if (discord?.defaultAllowedPaths?.length) {
    return {
      ...DEFAULT_DISCORD_TOOLS,
      allowedPaths: discord.defaultAllowedPaths,
    };
  }
  return DEFAULT_DISCORD_TOOLS;
}

function conversationKey(message: Message): string {
  if (message.channel.isDMBased()) {
    return `dm:${message.author.id}`;
  }
  return `channel:${message.channelId}`;
}

function buildHelpText(cfg: Config): string {
  const agentConfig = cfg.agents.list[cfg.agents.default];
  const emoji = agentConfig?.identity?.emoji || '🦞';
  const name = agentConfig?.identity?.name || 'SkimpyClaw';
  const commandList = BOT_COMMANDS.map(c => `/${c.command} - ${c.description}`).join('\n');
  return `${emoji} ${name} online.\n\nSend a message to chat, or use a command:\n\n${commandList}`;
}

function splitToChunks(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let current = '';

  for (const paragraph of text.split('\n\n')) {
    if (current.length + paragraph.length + 2 > maxLength) {
      if (current) chunks.push(current.trim());
      // If a single paragraph exceeds maxLength, split it on newlines or hard-cut
      if (paragraph.length > maxLength) {
        const lines = paragraph.split('\n');
        let lineBuf = '';
        for (const line of lines) {
          if (lineBuf.length + line.length + 1 > maxLength) {
            if (lineBuf) chunks.push(lineBuf.trim());
            // If a single line still exceeds, hard-cut it
            if (line.length > maxLength) {
              for (let i = 0; i < line.length; i += maxLength) {
                chunks.push(line.slice(i, i + maxLength));
              }
              lineBuf = '';
            } else {
              lineBuf = line;
            }
          } else {
            lineBuf += (lineBuf ? '\n' : '') + line;
          }
        }
        current = lineBuf;
      } else {
        current = paragraph;
      }
    } else {
      current += (current ? '\n\n' : '') + paragraph;
    }
  }
  if (current) chunks.push(current.trim());

  return chunks.filter(c => c.length > 0);
}

async function sendLongText(message: Message, text: string): Promise<void> {
  const chunks = splitToChunks(text, 1900);
  for (const chunk of chunks) {
    await message.reply(chunk);
  }
}

function startTypingIndicator(message: Message): () => void {
  const interval = setInterval(() => {
    const channel = message.channel as { sendTyping?: () => Promise<unknown> };
    if (typeof channel.sendTyping === 'function') {
      void channel.sendTyping().catch(() => {});
    }
  }, 4000);
  return () => clearInterval(interval);
}

async function handleCommand(message: Message, command: string, args: string[]): Promise<void> {
  const rawArgs = args.join(' ').trim();

  if (command === 'start' || command === 'help') {
    await sendLongText(message, buildHelpText(config));
    return;
  }

  if (command === 'model') {
    if (!rawArgs) {
      const current = getCurrentModel();
      const aliases = Object.keys(config.models.aliases).join(', ');
      await message.reply(`Current: ${current}\nAliases: ${aliases}\n\nUsage: /model <alias>`);
      return;
    }
    const resolved = config.models.aliases[rawArgs] || rawArgs;
    setCurrentModel(resolved);
    await message.reply(`Model switched to: ${resolved}`);
    return;
  }

  if (command === 'status') {
    const model = getCurrentModel();
    const last = getLastMessage();
    const jobs = getCronJobs();
    const jobList = jobs.map(j => `- ${j.name}: ${j.nextRun?.toLocaleString() || 'unknown'}`).join('\n');

    const caStatus = readCodeAgentStatus();
    let caLine = 'Coding Agent: idle';
    if (caStatus && (caStatus.status as string) !== 'idle') {
      const isActive = caStatus.status === 'running' || caStatus.status === 'validating';
      if (isActive) {
        const elapsed = Math.round((Date.now() - new Date(caStatus.startedAt).getTime()) / 1000);
        const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
        caLine = `Coding Agent: ${caStatus.status.toUpperCase()} (${caStatus.agent}, ${elapsedStr})\n  Task: ${caStatus.task.slice(0, 100)}`;
      } else {
        const dur = caStatus.durationSeconds != null ? `${caStatus.durationSeconds}s` : '-';
        const validation = caStatus.validationPassed != null ? (caStatus.validationPassed ? ' ✅' : ' ❌') : '';
        caLine = `Coding Agent: ${caStatus.status.toUpperCase()} (${dur}${validation})\n  Task: ${caStatus.task.slice(0, 100)}`;
      }
    }

    await message.reply(
      `Agent: ${config.agents.default}\n` +
      `Model: ${model}\n` +
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

  if (command === 'new') {
    clearHistory(conversationKey(message));
    await message.reply('Conversation cleared. Starting fresh.');
    return;
  }

  if (command === 'compact') {
    const key = conversationKey(message);
    const history = getHistory(key);
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
      clearHistory(key);
      chatHistory.set(key, [
        { role: 'user', content: 'Summary of our previous conversation:' },
        { role: 'assistant', content: summary },
      ]);
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
    silenceUntil = new Date(Date.now() + minutes * 60 * 1000);
    await message.reply(`Proactive messages silenced until ${silenceUntil.toLocaleTimeString()}`);
    return;
  }

  await message.reply(`Unknown command: /${command}\n\nType /help to see available commands.`);
}

async function handleIncomingMessage(message: Message): Promise<void> {
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

  // Check for image attachments
  const imageAttachments = message.attachments.filter(
    a => a.contentType?.startsWith('image/')
  );

  if (imageAttachments.size > 0) {
    const attachment = imageAttachments.first()!;
    const stopTyping = startTypingIndicator(message);

    try {
      // Download the image
      const imageResponse = await fetch(attachment.url);
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const base64Image = imageBuffer.toString('base64');

      // Determine media type
      const mediaType = attachment.contentType || 'image/jpeg';

      // Get message text or use default
      const caption = message.content.trim() || "What's in this image?";

      // Build multi-part content array
      const content: import('./types.js').ContentBlock[] = [
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
      const history = getHistory(key);
      const response = await runAgentTurn(
        config.agents.default,
        content,
        config,
        getCurrentModel(),
        getDiscordToolConfig(config),
        history,
        getDiscordRunContext(message)
      );

      addToHistory(key, `[Image: ${caption}]`, response);
      await sendLongText(message, response);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await message.reply(`Error processing image: ${msg}`);
    } finally {
      stopTyping();
    }
    return;
  }

  const text = message.content.trim();
  if (!text) return;

  const isPrefixedCommand = text.startsWith('/') || text.startsWith('!');
  const isDm = message.channel.isDMBased();
  if (isPrefixedCommand || isDm) {
    const commandText = isPrefixedCommand ? text.slice(1).trim() : text;
    const [commandPart, ...args] = commandText.split(/\s+/);
    const command = (commandPart || '').toLowerCase();
    if (!KNOWN_COMMANDS.has(command)) {
      if (isPrefixedCommand) {
        await message.reply(`Unknown command: /${command}\n\nType /help to see available commands.`);
        return;
      }
    } else {
      await handleCommand(message, command, args);
      return;
    }
  }

  const key = conversationKey(message);
  const stopTyping = startTypingIndicator(message);

  try {
    const history = getHistory(key);
    const response = await runAgentTurn(
      config.agents.default,
      text,
      config,
      getCurrentModel(),
      getDiscordToolConfig(config),
      history,
      getDiscordRunContext(message)
    );
    addToHistory(key, text, response);
    await sendLongText(message, response);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    await message.reply(`Error: ${msg}`);
  } finally {
    stopTyping();
  }
}

export async function initDiscord(cfg: Config): Promise<boolean> {
  const discord = cfg.channels.discord;
  if (!discord?.enabled || !discord.token) {
    console.log('[discord] Disabled or no token configured');
    return false;
  }

  config = cfg;
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.on('messageCreate', (message: Message) => {
    void handleIncomingMessage(message);
  });

  client.once('clientReady', () => {
    console.log(`[discord] Bot started as ${client?.user?.tag ?? 'unknown'}`);
  });

  client.on('error', (error: unknown) => {
    console.error('[discord] Client error:', error);
  });

  return true;
}

export async function startDiscord(): Promise<void> {
  if (!client || !config.channels.discord?.token) return;
  console.log('[discord] Starting bot...');
  await client.login(config.channels.discord.token);
}

export async function stopDiscord(): Promise<void> {
  if (!client) return;
  client.destroy();
  console.log('[discord] Bot stopped');
}

export function isDiscordSilenced(): boolean {
  if (!silenceUntil) return false;
  return new Date() < silenceUntil;
}

export function getDiscordDefaultTarget(cfg: Config): string | null {
  const discord = cfg.channels.discord;
  if (!discord) return null;
  if (discord.defaultChannelId?.trim()) return discord.defaultChannelId.trim();

  for (const entry of discord.allowFrom) {
    const value = String(entry).trim();
    if (value) return value;
  }
  return null;
}

async function sendChunked(target: { send: (content: string) => Promise<unknown> }, text: string): Promise<void> {
  const chunks = splitToChunks(text, 1900);
  for (const chunk of chunks) {
    await target.send(chunk);
  }
}

export async function sendDiscordProactiveMessage(target: string | number, message: string): Promise<void> {
  if (!client || isDiscordSilenced()) return;

  const targetId = String(target);
  const channel = await client.channels.fetch(targetId).catch(() => null);
  if (channel && 'send' in channel && typeof channel.send === 'function') {
    await sendChunked(channel as { send: (content: string) => Promise<unknown> }, message);
    return;
  }

  const user = await client.users.fetch(targetId).catch(() => null);
  if (user) {
    await sendChunked(user as { send: (content: string) => Promise<unknown> }, message);
  }
}
