// Telegram Channel Types

import type { Context } from 'grammy';
import type { Config, ChatMessage, AgentRunContext } from '../../types.js';

// Command definitions — single source of truth for the / menu and /help
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'help', description: 'Show available commands' },
  { command: 'model', description: 'Switch model (fast/smart/opus)' },
  { command: 'status', description: 'Show bot status' },
  { command: 'memory', description: 'View recent memory entries' },
  { command: 'new', description: 'Clear conversation history' },
  { command: 'compact', description: 'Compress conversation history' },
  { command: 'silence', description: 'Pause proactive messages' },
  { command: 'cron', description: 'List or run scheduled jobs' },
  { command: 'tasks', description: 'Show active/recent agent tasks' },
  { command: 'cancel', description: 'Cancel a running agent task' },
  { command: 'skills', description: 'List loaded skills' },
  { command: 'skill', description: 'Skill details or enable/disable' },
  { command: 'approvals', description: 'List pending exec approvals' },
  { command: 'approve', description: 'Approve an exec request by ID' },
  { command: 'deny', description: 'Deny an exec request by ID' },
  { command: 'heartbeat', description: 'Trigger heartbeat check' },
  { command: 'restart', description: 'Restart the gateway' }
];

// Set of known command names for catch-all routing
export const KNOWN_COMMANDS = new Set(
  BOT_COMMANDS.map((c) => c.command).concat(['start'])
);

export const LAUNCHD_LABEL = 'com.skimpyclaw.gateway';

// State exports
export const state = {
  silenceUntil: null as Date | null,
  chatHistory: new Map<number, ChatMessage[]>(),
  loadedFromDisk: new Set<number>(),
};

export const MAX_HISTORY_PAIRS = 5;

export interface MemoryFileInfo {
  name: string;
  path: string;
  date: string;
  size: number;
}

export interface TelegramContext {
  cfg: Config;
  botInfo: { emoji: string; name: string };
}
