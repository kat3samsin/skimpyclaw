// Runs a single --resume turn against a live interactive coding session.
// Called from the Discord thread-message handler when it detects a user message
// in a thread that is mapped to an active interactive session.

import { spawn } from 'child_process';
import { CLAUDE_CLI_PATH, buildCodeAgentSpawnEnv } from './utils.js';
import { enqueue, dequeue, markIdle, getSession, touchActivity, updateStatus } from './interactive-sessions.js';
import { chunkForDiscord } from './stream-formatter.js';

export interface ResumeOptions {
  discordThreadId: string;
  userMessage: string;
  postToThread: (chunks: string[]) => Promise<void>;
}

export async function handleInteractiveThreadMessage(opts: ResumeOptions): Promise<void> {
  const { discordThreadId, userMessage, postToThread } = opts;

  const session = getSession(discordThreadId);
  if (!session) return; // not ours — normal handler will take it

  if (session.status !== 'active') {
    await postToThread([`⚠ this session is ${session.status}; start a new interactive \`code_with_agent\` call to begin again`]);
    return;
  }

  const { shouldStart } = enqueue(discordThreadId, userMessage);
  if (!shouldStart) return;

  try {
    for (;;) {
      const pending = dequeue(discordThreadId);
      if (!pending) break;
      try {
        const stdout = await runClaudeResumeSubprocess(session.cliSessionId, pending.content);
        touchActivity(discordThreadId);
        const chunks = chunkForDiscord(stdout);
        if (chunks.length > 0) await postToThread(chunks);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        updateStatus(discordThreadId, 'errored');
        await postToThread([`✗ subprocess crashed: ${msg.slice(0, 500)}`]);
        // Drain the rest of the queue so stranded messages don't sit forever.
        // The session is errored — emit a single notice instead of retrying.
        let dropped = 0;
        while (dequeue(discordThreadId)) dropped++;
        if (dropped > 0) {
          await postToThread([`(dropped ${dropped} queued message${dropped === 1 ? '' : 's'} because the session errored)`]);
        }
        return;
      }
    }
  } finally {
    markIdle(discordThreadId);
  }
}

function runClaudeResumeSubprocess(cliSessionId: string, message: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const env = buildCodeAgentSpawnEnv();

    const args = [
      '-p',
      '--resume', cliSessionId,
      '--dangerously-skip-permissions',
      message,
    ];

    const msgPreview = message.length > 80 ? message.slice(0, 80) + '...' : message;
    console.log(`[interactive-resume] spawn: claude -p --resume ${cliSessionId} "${msgPreview}"`);

    const proc = spawn(CLAUDE_CLI_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

    // Safety: 10min cap per turn.
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* best effort */ }
      reject(new Error('resume turn timed out after 10m'));
    }, 10 * 60 * 1000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else if (stdout) {
        // Non-zero exit but we still have output — surface it but log the failure.
        console.warn(`[interactive-resume] claude exited ${code}; returning partial stdout (${stdout.length} chars). stderr: ${stderr.slice(0, 200)}`);
        resolve(stdout);
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
