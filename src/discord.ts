import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  type Message,
  type Interaction,
} from 'discord.js';
import { join } from 'path';
import { homedir } from 'os';
import { tmpdir } from 'os';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import type { AgentRunContext, ChatMessage, Config, ToolConfig } from './types.js';
import { getCurrentModel, setCurrentModel, getLastMessage } from './gateway.js';
import { getCronJobs, runCronJob } from './cron.js';
import { runAgentTurn } from './agent.js';
import { runHeartbeatCheck } from './heartbeat.js';
import { isAllowed, isRateLimited } from './security.js';
import { getActiveCodeAgents, getRecentCodeAgents } from './tools.js';
import { getActiveTasks, getRecentTasks, cancelTask } from './subagent.js';
import {
  listApprovals,
  approveRequest,
  denyRequest,
  getApproval,
  onApprovalEvent,
  type PendingApproval,
} from './exec-approval.js';
import { transcribeAudio, synthesizeSpeech } from './voice.js';
import * as sessions from './sessions.js';

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
  { command: 'tasks', description: 'Show active/recent agent tasks' },
  { command: 'cancel', description: 'Cancel a running agent task' },
  { command: 'approvals', description: 'List pending exec approvals' },
  { command: 'approve', description: 'Approve an exec request by ID' },
  { command: 'deny', description: 'Deny an exec request by ID' },
  { command: 'heartbeat', description: 'Trigger heartbeat check' },
];

const KNOWN_COMMANDS = new Set(BOT_COMMANDS.map(c => c.command));

const MAX_HISTORY_PAIRS = 5;
const chatHistory = new Map<string, ChatMessage[]>();
// Track which keys have been loaded from disk this session
const loadedFromDisk = new Set<string>();

const DEFAULT_DISCORD_TOOLS: ToolConfig = {
  enabled: true,
  allowedPaths: [join(homedir(), '.skimpyclaw'), process.cwd()],
  maxIterations: 100,
  bashTimeout: 15000,
};

let client: Client | null = null;
let config: Config;
let silenceUntil: Date | null = null;

async function getHistory(key: string): Promise<ChatMessage[]> {
  // Lazy-load from disk on first access this session
  if (!loadedFromDisk.has(key)) {
    loadedFromDisk.add(key);
    const diskHistory = await sessions.loadHistory('discord', key).catch(() => []);
    if (diskHistory.length > 0 && !chatHistory.has(key)) {
      chatHistory.set(key, diskHistory);
    }
  }
  return chatHistory.get(key) || [];
}

async function addToHistory(key: string, userMsg: string, assistantMsg: string): Promise<void> {
  const history = await getHistory(key);
  history.push({ role: 'user', content: userMsg });
  history.push({ role: 'assistant', content: assistantMsg });
  while (history.length > MAX_HISTORY_PAIRS * 2) {
    history.shift();
    history.shift();
  }
  chatHistory.set(key, history);
  // Persist to disk (fire-and-forget)
  sessions.saveExchange('discord', key, userMsg, assistantMsg).catch(() => {});
}

async function clearHistory(key: string): Promise<void> {
  chatHistory.delete(key);
  loadedFromDisk.delete(key);
  await sessions.clearHistory('discord', key).catch(() => {});
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

    // Coding agents status (multi-agent)
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
    const active = getActiveTasks();
    const recent = getRecentTasks(5);

    if (recent.length === 0) {
      await message.reply('No agent tasks yet. Subagents spawn automatically for complex requests.');
      return;
    }

    const formatTask = (t: typeof recent[0]) => {
      const elapsed = ((t.completedAt || new Date()).getTime() - t.createdAt.getTime()) / 1000;
      const elapsedStr = elapsed < 60 ? `${Math.round(elapsed)}s` : `${Math.round(elapsed / 60)}m`;
      const status: Record<string, string> = {
        pending: '⏳ Pending',
        running: `🔄 Running (${elapsedStr})`,
        completed: `✅ Done (${elapsedStr})`,
        failed: `❌ Failed (${elapsedStr})`,
        cancelled: '🚫 Cancelled',
      };
      const promptPreview = t.prompt.slice(0, 60) + (t.prompt.length > 60 ? '...' : '');
      return `${t.id}: ${status[t.status] || t.status} [${t.type}] ${promptPreview}`;
    };

    const lines = recent.map(formatTask).join('\n');
    await sendLongText(message, `Agent tasks:\n\n${lines}`);
    return;
  }

  if (command === 'cancel') {
    const id = rawArgs;
    if (!id) {
      await message.reply('Usage: /cancel <task-id>\nExample: /cancel t1');
      return;
    }

    const task = cancelTask(id);
    if (!task) {
      await message.reply(`No task found: ${id}`);
      return;
    }

    if (task.status === 'cancelled') {
      await message.reply(`Cancelled ${id}.`);
    } else {
      await message.reply(`Task ${id} is already ${task.status}.`);
    }
    return;
  }

  if (command === 'new') {
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
      chatHistory.set(key, [
        { role: 'user', content: 'Summary of our previous conversation:' },
        { role: 'assistant', content: summary },
      ]);
      loadedFromDisk.add(key); // Mark as loaded so we don't re-load on next access
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
      const history = await getHistory(key);
      const response = await runAgentTurn(
        config.agents.default,
        content,
        config,
        getCurrentModel(),
        getDiscordToolConfig(config),
        history,
        getDiscordRunContext(message)
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

  // Check for voice message attachments
  const voiceAttachments = message.attachments.filter(
    a => a.contentType?.startsWith('audio/') || a.contentType?.startsWith('voice/')
  );

  if (voiceAttachments.size > 0) {
    const attachment = voiceAttachments.first()!;
    const stopTyping = startTypingIndicator(message);

    try {
      // Check if voice config is available
      if (!config.voice) {
        await message.reply('Voice transcription not configured. Add a "voice" section to config.json.');
        return;
      }

      // Download the voice file
      const voiceResponse = await fetch(attachment.url);
      const buffer = Buffer.from(await voiceResponse.arrayBuffer());

      // Save to temp file
      const ext = attachment.name?.split('.').pop() || 'ogg';
      const tempDir = join(tmpdir(), 'skimpyclaw-voice');
      if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
      const tempPath = join(tempDir, `discord-voice-${Date.now()}.${ext}`);
      writeFileSync(tempPath, buffer);

      try {
        // Transcribe
        const result = await transcribeAudio(tempPath, config.voice);
        const transcription = result.text.trim();
        console.log(`[discord] Transcription result: ${transcription}`);

        if (!transcription) {
          await message.reply('Could not transcribe audio — no speech detected.');
          return;
        }

        const key = conversationKey(message);
        const history = await getHistory(key);
        const agentResponse = await runAgentTurn(
          config.agents.default,
          transcription,
          config,
          getCurrentModel(),
          getDiscordToolConfig(config),
          history,
          getDiscordRunContext(message)
        );
        await addToHistory(key, transcription, agentResponse);

        // TTS voice reply if sendVoice enabled
        console.log('[discord] TTS check - sendVoice:', config.voice?.channels?.['discord']?.sendVoice);
        if (config.voice?.channels?.['discord']?.sendVoice) {
          console.log('[discord] Attempting TTS synthesis...');
          try {
            const speech = await synthesizeSpeech(agentResponse, config.voice);
            console.log('[discord] TTS synthesis success:', speech.format, speech.provider, 'buffer size:', speech.buffer.length);
            const attachment = new AttachmentBuilder(speech.buffer, {
              name: `voice-reply.${speech.format}`,
              description: 'Voice reply'
            });
            await message.reply({ files: [attachment] });
            console.log('[discord] Voice reply sent');
          } catch (err) {
            console.error('[discord] TTS synthesis failed:', err);
            // Non-fatal — text reply still sends below
          }
        }

        // Format response with transcription in a blockquote
        const combined = `> 🎤 ${transcription}\n\n${agentResponse}`;
        await sendLongText(message, combined);
      } finally {
        // Clean up temp file
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
    const history = await getHistory(key);
    const response = await runAgentTurn(
      config.agents.default,
      text,
      config,
      getCurrentModel(),
      getDiscordToolConfig(config),
      history,
      getDiscordRunContext(message)
    );
    await addToHistory(key, text, response);
    await sendLongText(message, response);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    await message.reply(`Error: ${msg}`);
  } finally {
    stopTyping();
  }
}

/** Send an approval card message with approve/deny buttons to a Discord channel. */
async function sendApprovalCard(channelId: string, approval: PendingApproval): Promise<void> {
  if (!client) return;

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

/** Handle Discord button interactions for approval approve/deny. */
async function handleInteraction(interaction: Interaction): Promise<void> {
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

  // Ephemeral acknowledgement to the clicker
  await interaction.reply({ content: statusText, ephemeral: true });

  // Update the original message to reflect the resolved status
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
        components: [], // Remove buttons after resolution
      });
    }
  } catch {
    // Message may already be edited or deleted — ignore
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

  // Handle button interactions (approval approve/deny)
  client.on('interactionCreate', (interaction: Interaction) => {
    void handleInteraction(interaction);
  });

  client.once('clientReady', () => {
    console.log(`[discord] Bot started as ${client?.user?.tag ?? 'unknown'}`);
  });

  client.on('error', (error: unknown) => {
    console.error('[discord] Client error:', error);
  });

  // Subscribe to approval-created events — proactively post to Discord for discord-origin approvals
  onApprovalEvent('created', (event) => {
    if (!client) return;
    const { approval } = event;
    const meta = approval.channelMeta;

    // Only post discord-origin approvals (or fallback when no channel set)
    if (meta?.channel && meta.channel !== 'discord') return;

    let targetChannelId: string | undefined;
    if (meta?.chatId) {
      targetChannelId = String(meta.chatId);
    }
    if (!targetChannelId) {
      targetChannelId = getDiscordDefaultTarget(cfg) ?? undefined;
    }
    if (!targetChannelId) return;

    void sendApprovalCard(targetChannelId, approval).catch((err) => {
      console.error('[discord] Failed to send approval notification:', err);
    });
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

export async function sendDiscordProactiveVoiceMessage(
  target: string | number,
  buffer: Buffer,
  format: 'ogg' | 'mp3'
): Promise<void> {
  if (!client || isDiscordSilenced()) return;

  const targetId = String(target);
  const attachment = new AttachmentBuilder(buffer, {
    name: `voice.${format}`,
    description: 'Voice message'
  });

  const channel = await client.channels.fetch(targetId).catch(() => null);
  if (channel && 'send' in channel && typeof channel.send === 'function') {
    await (channel as { send: (options: { files: AttachmentBuilder[] }) => Promise<unknown> }).send({ files: [attachment] });
    return;
  }

  const user = await client.users.fetch(targetId).catch(() => null);
  if (user) {
    await (user as { send: (options: { files: AttachmentBuilder[] }) => Promise<unknown> }).send({ files: [attachment] });
  }
}
