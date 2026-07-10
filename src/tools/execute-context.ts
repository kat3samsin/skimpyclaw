import type { AbortSignalLike, AuditTrace } from '../types.js';

export interface ExecuteToolContext {
  /** Task ID for file lock acquisition (concurrent writes) */
  lockTaskId?: string;
  /** Abort signal for cancelling long-running tool loops */
  abortSignal?: AbortSignalLike;
  /** Chat ID for channel routing */
  chatId?: number;
  /** Full config for agent tools */
  fullConfig?: import('../types.js').Config;
  /** Conversation history */
  history?: import('../types.js').ChatMessage[];
  /** Audit trace ID for recording tool events */
  auditTraceId?: string;
  /** Originating channel for approval routing */
  channel?: 'telegram' | 'discord' | string;
  /** Channel-specific target ID (Telegram chat ID or Discord channel snowflake) */
  channelTargetId?: string | number;
  /** User ID of the person who can approve */
  approverUserId?: string;
  /** Username of the approver */
  approverUsername?: string;
  /** Trigger source for usage tracking */
  trigger?: AuditTrace['trigger'];
  /** Agent ID for usage tracking */
  agentId?: string;
  /** True when this context is from a cron job — enables spawn tools even without a chatId */
  isCronJob?: boolean;
  /** Session ID used as file-lock scope + interactive-session key */
  sessionId?: string;
  /** Discord thread ID — set when command originates from a thread */
  discordThreadId?: string;
  /** Discord channel ID — parent channel when originating from a thread */
  discordChannelId?: string;
  /** True when Discord message originated from a DM (threads not supported) */
  isDm?: boolean;
  /** Discord agent profile alias for the current thread/profile turn */
  threadAgentAlias?: string;
  /** Nested agent delegation depth */
  delegationDepth?: number;
}
