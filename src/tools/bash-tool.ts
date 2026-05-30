import { spawn } from 'child_process';

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
import { sanitizeExecEnv } from '../env-sanitizer.js';

const SHELL_CONTROL_CHARS = new Set(['|', '&', ';', '<', '>', '(', ')', '`', '$']);

function hasUnquotedShellControl(command: string): boolean {
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // Keep Bash calls single-line even when a newline is inside quotes; multiline
    // snippets/heredocs are too easy to mistake for shell mode.
    if (ch === '\n' || ch === '\r') return true;

    if (ch === '\\' && quote !== "'") {
      if (i + 1 < command.length) i++;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (SHELL_CONTROL_CHARS.has(ch)) return true;
  }

  return false;
}

function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (ch === '\\' && quote !== "'") {
      const next = command[i + 1];
      if (next) {
        current += next;
        i++;
      }
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (quote) return null;
  if (current) tokens.push(current);
  return tokens;
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

  if (hasUnquotedShellControl(command)) {
    return 'Error: Shell control operators are blocked in safe mode. Run a single executable with explicit arguments (no pipes, redirects, chaining, or subshell expansion).';
  }

  const argv = tokenizeCommand(command);
  if (!argv || argv.length === 0) {
    return 'Error: Invalid command syntax.';
  }

  const timeout = config.bashTimeout || 30_000;
  const [executable, ...args] = argv;

  return new Promise((res) => {
    const child = spawn(executable, args, {
      cwd: cwd || undefined,
      env: sanitizeExecEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000);
    }, timeout);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > 60_000) stdout = stdout.slice(-60_000);
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > 60_000) stderr = stderr.slice(-60_000);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      res(`Error: ${error.message}`);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        const output = [stdout, stderr].filter(Boolean).join('\n');
        res((output ? `${output}\n` : '') + `Exit code: timeout after ${timeout}ms`);
        return;
      }

      const output = [stdout, stderr].filter(Boolean).join('\n').slice(0, 50_000);
      if (code && code !== 0) {
        const reason = signal ? `signal ${signal}` : `Exit code: ${code}`;
        res((output ? `${output}\n` : '') + reason);
        return;
      }
      res(output || '(no output)');
    });
  });
}
