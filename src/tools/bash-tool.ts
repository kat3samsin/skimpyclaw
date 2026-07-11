import { spawn } from 'child_process';

import { isBashCommandSafe } from '../security.js';
import {
  classifyCommandRisk,
  requiresApproval,
  createApprovalRequest,
  waitForApproval,
  denyRequest,
  type ApprovalChannelMeta,
} from '../exec-approval.js';
import type { ToolConfig } from '../types.js';
import type { ExecuteToolContext } from './execute-context.js';
import { isPathAllowed } from './path-utils.js';
import { validateBashPaths } from './bash-path-validation.js';
import { sanitizeExecEnv } from '../env-sanitizer.js';

function killChildProcessTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when no process group exists.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process already exited.
  }
}

function isChildProcessTreeAlive(child: ReturnType<typeof spawn>): boolean {
  if (process.platform === 'win32' || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
  if (context?.abortSignal?.aborted) return 'Error: Agent turn cancelled.';
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
      let resolved;
      try {
        resolved = await waitForApproval(request.id, ttlMs, context?.abortSignal);
      } catch (err) {
        if (!context?.abortSignal?.aborted) throw err;
        denyRequest(request.id, 'system:cancelled');
        return 'Error: Agent turn cancelled.';
      }

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
  if (context?.abortSignal?.aborted) return 'Error: Agent turn cancelled.';

  return new Promise((res) => {
    const child = spawn(executable, args, {
      cwd: cwd || undefined,
      env: sanitizeExecEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      context?.abortSignal?.removeEventListener('abort', onAbort);
    };
    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      res(result);
    };
    const terminationResult = () => {
      if (cancelled) return 'Error: Agent turn cancelled.';
      const output = [stdout, stderr].filter(Boolean).join('\n');
      return (output ? `${output}\n` : '') + `Exit code: timeout after ${timeout}ms`;
    };
    const terminate = (reason: 'timeout' | 'cancelled') => {
      if (timedOut || cancelled || settled) return;
      timedOut = reason === 'timeout';
      cancelled = reason === 'cancelled';
      killChildProcessTree(child, 'SIGTERM');
      sigkillTimer = setTimeout(() => {
        killChildProcessTree(child, 'SIGKILL');
        sigkillTimer = null;
        finish(terminationResult());
      }, 1000);
    };
    const onAbort = () => terminate('cancelled');

    const timer = setTimeout(() => {
      terminate('timeout');
    }, timeout);

    context?.abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (context?.abortSignal?.aborted) onAbort();

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > 60_000) stdout = stdout.slice(-60_000);
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > 60_000) stderr = stderr.slice(-60_000);
    });

    child.on('error', (error) => {
      finish(cancelled ? 'Error: Agent turn cancelled.' : `Error: ${error.message}`);
    });

    child.on('close', (code, signal) => {
      if (cancelled || timedOut) {
        // Do not release the caller while descendants can still mutate state.
        // A live process group is drained by the scheduled SIGKILL fallback.
        if (sigkillTimer && isChildProcessTreeAlive(child)) return;
        finish(terminationResult());
        return;
      }

      const output = [stdout, stderr].filter(Boolean).join('\n').slice(0, 50_000);
      if (code && code !== 0) {
        const reason = signal ? `signal ${signal}` : `Exit code: ${code}`;
        finish((output ? `${output}\n` : '') + reason);
        return;
      }
      finish(output || '(no output)');
    });
  });
}
