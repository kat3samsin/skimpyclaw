export interface ExecuteToolContext {
  /** Task ID for file lock acquisition (subagent writes) */
  lockTaskId?: string;
  /** Abort signal for cancelling long-running tool loops */
  abortSignal?: AbortSignal;
  /** Chat ID for spawn_subagent dispatch */
  chatId?: number;
  /** Full config for spawn_subagent */
  fullConfig?: import('../types.js').Config;
  /** Conversation history for spawn_subagent */
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
  trigger?: string;
  /** Agent ID for usage tracking */
  agentId?: string;
  /** True when this context is from a cron job — enables spawn tools even without a chatId */
  isCronJob?: boolean;
  /** Sandbox configuration for containerized tool execution */
  sandboxConfig?: import('../types.js').SandboxConfig;
  /** Session ID for sandbox container mapping */
  sessionId?: string;
}
