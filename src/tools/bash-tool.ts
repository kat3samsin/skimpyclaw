import { exec } from 'child_process';

import { isBashCommandSafe } from '../security.js';
import {
  classifyCommandRisk,
  requiresApproval,
  createApprovalRequest,
  waitForApproval,
  type ApprovalChannelMeta,
} from '../exec-approval.js';
import type { ToolConfig } from '../types.js';
import type { ExecuteToolContext } from './execute-context.js';
import { isPathAllowed } from './path-utils.js';
import { validateBashPaths } from './bash-path-validation.js';

/** Env var name patterns that should never be exposed to model-executed commands. */
const SENSITIVE_ENV_PATTERNS = [
  /api.?key/i, /token/i, /secret/i, /password/i, /credential/i,
  /^ANTHROPIC_/i, /^OPENAI_/i, /^CLAUDE/i, /^CODEX_/i, /^MINIMAX_/i,
  /^KIMI_/i, /^TOGETHER_/i, /^GROQ_/i, /^OPENROUTER_/i,
];

/** Common tool paths that may be missing when launched as a service/daemon. */
const EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];

/** Create a sanitized copy of process.env with secrets stripped. */
function sanitizeEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (SENSITIVE_ENV_PATTERNS.some(p => p.test(key))) {
      delete env[key];
    }
  }
  // Ensure common tool directories are in PATH (daemon/service launches often have a minimal PATH)
  const currentPath = env.PATH || '';
  const missing = EXTRA_PATH_DIRS.filter(d => !currentPath.includes(d));
  if (missing.length > 0) {
    env.PATH = `${currentPath}:${missing.join(':')}`;
  }
  return env;
}

export async function executeBash(command: string, cwd: string | undefined, config: ToolConfig, context?: ExecuteToolContext): Promise<string> {
  // Hard block: existing safety filter (always enforced)
  if (!isBashCommandSafe(command)) {
    return Promise.resolve('Error: Command blocked by safety filter.');
  }
  if (cwd && !isPathAllowed(cwd, config.allowedPaths)) {
    return Promise.resolve('Error: Working directory not in allowed paths.');
  }

  // Validate file paths referenced in command arguments
  const pathError = validateBashPaths(command, cwd, config.allowedPaths);
  if (pathError) {
    return Promise.resolve(pathError);
  }

  // Exec approval gate: classify risk and check if approval is needed
  const approvalConfig = config.execApproval;
  if (approvalConfig?.enabled !== false) {
    const classification = classifyCommandRisk(command);
    if (requiresApproval(classification, approvalConfig)) {
      // Unattended contexts (cron, no approver) have no human available to approve.
      // Fast-deny instead of blocking for the full TTL.
      const isUnattended =
        context?.channel === 'subagent' ||
        context?.isCronJob === true ||
        (!context?.approverUserId && !context?.channelTargetId && !context?.chatId);

      if (isUnattended) {
        return `⛔ Command blocked — tier ${classification.tier} commands require approval but no approver is available in this context (${classification.reason}). Use safer alternatives or request approval via an interactive channel.`;
      }

      // Build channel metadata from context for notification routing
      const channelMeta: ApprovalChannelMeta | undefined = context?.channel
        ? {
            channel: context.channel,
            chatId: context.channelTargetId ?? context.chatId,
            userId: context.approverUserId,
            username: context.approverUsername,
          }
        : context?.chatId
          ? {
              channel: 'telegram',
              chatId: context.chatId,
            }
          : undefined;

      // Create a pending approval request and wait for resolution
      const ttlMs = approvalConfig?.ttlMs ?? 5 * 60 * 1000;
      const request = createApprovalRequest(command, cwd, classification, approvalConfig, channelMeta);
      const resolved = await waitForApproval(request.id, ttlMs);

      if (resolved.status !== 'approved') {
        return `⛔ Command not executed — approval ${resolved.status} (tier ${classification.tier}: ${classification.reason}).`;
      }
      // Approved — fall through to execution below
    }
  }

  const timeout = config.bashTimeout || 30_000;

  return new Promise((res) => {
    exec(command, {
      cwd: cwd || undefined,
      timeout,
      env: sanitizeEnv(),
      maxBuffer: 5 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const parts = [stdout, stderr, `Exit code: ${error.code ?? 'unknown'}`].filter(Boolean);
        res(parts.join('\n').slice(0, 50_000));
        return;
      }
      const output = [stdout, stderr].filter(Boolean).join('\n');
      res(output.slice(0, 50_000) || '(no output)');
    });
  });
}
