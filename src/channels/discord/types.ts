import type { ChatMessage } from '../../types.js';

export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'help', description: 'Show available commands' },
  { command: 'model', description: 'Switch model' },
  { command: 'effort', description: 'Set reasoning effort (none/low/medium/high/xhigh)' },
  { command: 'status', description: 'Show bot status' },
  { command: 'agent', description: 'Manage Discord agent profiles' },
  { command: 'clear', description: 'Clear conversation history' },
  { command: 'compact', description: 'Compress conversation history' },
  { command: 'silence', description: 'Pause proactive messages' },
  { command: 'cron', description: 'List or run scheduled jobs' },
  { command: 'tasks', description: 'List active coding agents and cron jobs' },
  { command: 'cancel', description: 'Cancel a coding agent (use dashboard) or cron job' },
  { command: 'approvals', description: 'List pending exec approvals' },
  { command: 'approve', description: 'Approve an exec request by ID' },
  { command: 'deny', description: 'Deny an exec request by ID' },
  { command: 'heartbeat', description: 'Trigger heartbeat check' },
];

export const KNOWN_COMMANDS = new Set([...BOT_COMMANDS.map(c => c.command), 'think']);
export const MAX_HISTORY_PAIRS = 5;
