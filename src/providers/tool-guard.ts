// ToolCallGuard — Spin detection, no-progress detection

import { createHash } from 'crypto';

const SPIN_WARN_THRESHOLD = 3;
const SPIN_BLOCK_THRESHOLD = 5;
const NO_PROGRESS_THRESHOLD = 5;

interface CallRecord {
  name: string;
  inputHash: string;
}

export class ToolCallGuard {
  private callHistory: CallRecord[] = [];
  private resultHashes: string[] = [];
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  // Kept for future use — not currently enforced
  private maxTurnTokens: number | undefined;

  constructor(maxTurnTokens?: number) {
    this.maxTurnTokens = maxTurnTokens;
  }

  private hash(data: string): string {
    return createHash('md5').update(data).digest('hex').slice(0, 16);
  }

  /** Record a tool call before execution. Returns blocking/warning info. */
  recordCall(name: string, input: Record<string, any>): { blocked: boolean; warning?: string } {
    const inputHash = this.hash(JSON.stringify({ name, input }));
    this.callHistory.push({ name, inputHash });

    // Count consecutive identical calls
    let consecutive = 0;
    for (let i = this.callHistory.length - 1; i >= 0; i--) {
      if (this.callHistory[i].inputHash === inputHash) {
        consecutive++;
      } else {
        break;
      }
    }

    if (consecutive >= SPIN_BLOCK_THRESHOLD) {
      return { blocked: true, warning: `Blocked: tool "${name}" called ${consecutive} times with identical input` };
    }
    if (consecutive >= SPIN_WARN_THRESHOLD) {
      return { blocked: false, warning: `Warning: tool "${name}" called ${consecutive} times with identical input — try a different approach` };
    }
    return { blocked: false };
  }

  /** Record a tool result. Returns nudge if no progress detected. */
  recordResult(result: string): { nudge?: string } {
    const resultHash = this.hash(result);
    this.resultHashes.push(resultHash);

    // Check if last N results are all the same
    if (this.resultHashes.length >= NO_PROGRESS_THRESHOLD) {
      const recent = this.resultHashes.slice(-NO_PROGRESS_THRESHOLD);
      const allSame = recent.every(h => h === recent[0]);
      if (allSame) {
        return { nudge: `No progress detected: last ${NO_PROGRESS_THRESHOLD} tool results are identical. Try a different approach.` };
      }
    }
    return {};
  }

  /** Record token usage for stats tracking. */
  recordTokens(inputTokens: number, outputTokens: number): void {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
  }

  /** Reset guard state (for testing or between turns). */
  reset(): void {
    this.callHistory = [];
    this.resultHashes = [];
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
  }

  /** Get current stats. */
  getStats(): { callCount: number; totalTokens: number } {
    return {
      callCount: this.callHistory.length,
      totalTokens: this.totalInputTokens + this.totalOutputTokens,
    };
  }
}
