// ToolCallGuard — Spin detection, no-progress detection, token budget

import { createHash } from 'crypto';

const SPIN_WARN_THRESHOLD = 3;
const SPIN_BLOCK_THRESHOLD = 5;
const NO_PROGRESS_THRESHOLD = 5;
const DEFAULT_MAX_TURN_TOKENS = 200_000;

interface CallRecord {
  name: string;
  inputHash: string;
}

export class ToolCallGuard {
  private callHistory: CallRecord[] = [];
  private resultHashes: string[] = [];
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private maxTurnTokens: number;

  constructor(maxTurnTokens?: number) {
    this.maxTurnTokens = typeof maxTurnTokens === 'number'
      && Number.isFinite(maxTurnTokens)
      && maxTurnTokens > 0
      ? maxTurnTokens
      : DEFAULT_MAX_TURN_TOKENS;
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

  /** Record token usage. Returns budget state after this response. */
  recordTokens(
    inputTokens: number | undefined,
    outputTokens: number | undefined,
  ): { exceeded: boolean; usageUnavailable?: boolean; warning?: string } {
    if (
      !Number.isFinite(inputTokens)
      || !Number.isFinite(outputTokens)
      || (inputTokens as number) < 0
      || (outputTokens as number) < 0
    ) {
      return {
        exceeded: true,
        usageUnavailable: true,
        warning: 'Token usage unavailable; configured turn budget cannot be enforced',
      };
    }
    this.totalInputTokens += inputTokens as number;
    this.totalOutputTokens += outputTokens as number;
    const total = this.totalInputTokens + this.totalOutputTokens;

    if (total >= this.maxTurnTokens) {
      return {
        exceeded: true,
        warning: `Token budget exceeded: ${total} tokens used (limit: ${this.maxTurnTokens})`,
      };
    }
    if (total >= this.maxTurnTokens * 0.8) {
      return {
        exceeded: false,
        warning: `Token budget warning: ${total}/${this.maxTurnTokens} tokens used (${Math.round(total / this.maxTurnTokens * 100)}%)`,
      };
    }
    return { exceeded: false };
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
