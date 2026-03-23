// RL Feedback persistence — JSONL append-only storage at ~/.skimpyclaw/logs/rl-feedback/YYYY-MM-DD.jsonl

import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { readJsonlDir } from './utils.js';
import type { RLFeedbackEvent, FeedbackSignal } from './types.js';

const FEEDBACK_DIR = join(homedir(), '.skimpyclaw', 'logs', 'rl-feedback');

/** For testing: override the feedback directory */
let feedbackDirOverride: string | null = null;
export function setFeedbackDirForTesting(dir: string | null): void {
  feedbackDirOverride = dir;
}
function getFeedbackDir(): string {
  return feedbackDirOverride ?? FEEDBACK_DIR;
}
function getFilePath(dateStr: string): string {
  return join(getFeedbackDir(), `${dateStr}.jsonl`);
}

// --- Validation ---

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate a feedback event, checking required fields and value ranges */
export function validateFeedbackEvent(event: Partial<RLFeedbackEvent>): ValidationResult {
  const errors: string[] = [];

  if (!event.id) errors.push('id is required');
  if (!event.sessionId) errors.push('sessionId is required');
  if (!event.timestamp) errors.push('timestamp is required');
  if (!event.userId) errors.push('userId is required');
  if (!event.agentId) errors.push('agentId is required');
  if (event.userInput === undefined || event.userInput === null) {
    errors.push('userInput is required');
  }
  if (event.assistantOutput === undefined || event.assistantOutput === null) {
    errors.push('assistantOutput is required');
  }
  if (!event.feedbackType) {
    errors.push('feedbackType is required');
  } else if (!['explicit_correction', 'approval', 'implicit'].includes(event.feedbackType)) {
    errors.push('feedbackType must be explicit_correction, approval, or implicit');
  }
  if (event.directiveText === undefined || event.directiveText === null) {
    errors.push('directiveText is required');
  }
  if (event.evaluativeScore === undefined || event.evaluativeScore === null) {
    errors.push('evaluativeScore is required');
  } else if (event.evaluativeScore < -1 || event.evaluativeScore > 1) {
    errors.push('evaluativeScore must be between -1 and 1');
  }

  return { valid: errors.length === 0, errors };
}

// --- Build ---

export interface BuildFeedbackEventOptions {
  sessionId: string;
  userId: string;
  agentId: string;
  userInput: string;
  assistantOutput: string;
  feedbackType: RLFeedbackEvent['feedbackType'];
  directiveText: string;
  evaluativeScore: number;
  toolCalls?: string[];
  toolResultsSummary?: string;
  tags?: string[];
  safetyFlags?: string[];
  model?: string;
  trigger?: string;
}

/** Build a complete RLFeedbackEvent with auto-generated id and timestamp */
export function buildFeedbackEvent(opts: BuildFeedbackEventOptions): RLFeedbackEvent {
  return {
    id: randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    sessionId: opts.sessionId,
    userId: opts.userId,
    agentId: opts.agentId,
    userInput: opts.userInput,
    assistantOutput: opts.assistantOutput,
    feedbackType: opts.feedbackType,
    directiveText: opts.directiveText,
    evaluativeScore: opts.evaluativeScore,
    toolCalls: opts.toolCalls,
    toolResultsSummary: opts.toolResultsSummary,
    tags: opts.tags ?? [],
    safetyFlags: opts.safetyFlags ?? [],
    model: opts.model,
    trigger: opts.trigger,
  };
}

// --- Persistence ---

/** Record a feedback event. Sync append, never throws. */
export function recordFeedback(event: RLFeedbackEvent): void {
  try {
    const dir = getFeedbackDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const dateStr = event.timestamp.slice(0, 10); // YYYY-MM-DD from ISO
    const filePath = getFilePath(dateStr);
    appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
  } catch (err) {
    console.warn('[rl-feedback] Failed to record feedback event:', err);
  }
}

export interface ReadFeedbackOptions {
  startDate?: string; // YYYY-MM-DD
  endDate?: string;   // YYYY-MM-DD
  userId?: string;
  feedbackType?: RLFeedbackEvent['feedbackType'];
  limit?: number;
  offset?: number;
}

/** Read feedback events from JSONL files, supporting userId/feedbackType filter and pagination */
export function readFeedbackEvents(
  options: ReadFeedbackOptions = {},
): { events: RLFeedbackEvent[]; total: number } {
  const dir = getFeedbackDir();
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const now = new Date();
  // Use UTC dates to match file naming (event.timestamp is ISO/UTC, sliced to YYYY-MM-DD)
  const endDate = options.endDate ?? now.toISOString().slice(0, 10);
  const startDate = options.startDate ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { userId, feedbackType } = options;

  const allEvents = readJsonlDir<RLFeedbackEvent>(
    dir,
    startDate,
    endDate,
    (e) => {
      if (userId && e.userId !== userId) return false;
      if (feedbackType && e.feedbackType !== feedbackType) return false;
      return true;
    },
  );

  // Sort newest first
  allEvents.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  const total = allEvents.length;
  const paged = allEvents.slice(offset, offset + limit);

  return { events: paged, total };
}

// --- Signal Conversion ---

/** Convert an array of FeedbackSignals into a single RLFeedbackEvent, or null if empty */
export function convertSignalsToFeedbackEvent(
  signals: FeedbackSignal[],
  opts: {
    sessionId: string;
    userId: string;
    agentId: string;
    userInput: string;
    assistantOutput: string;
    model?: string;
    trigger?: string;
  },
): RLFeedbackEvent | null {
  if (signals.length === 0) return null;

  // Pick the strongest signal by |reward| * confidence
  let strongest = signals[0];
  for (const s of signals) {
    if (Math.abs(s.reward) * s.confidence > Math.abs(strongest.reward) * strongest.confidence) {
      strongest = s;
    }
  }

  // Determine feedbackType from strongest signal
  let feedbackType: RLFeedbackEvent['feedbackType'];
  if (strongest.type === 'correction' || strongest.type === 'reask') {
    feedbackType = 'explicit_correction';
  } else if (strongest.type === 'acceptance' && strongest.confidence >= 0.5) {
    feedbackType = 'approval';
  } else {
    feedbackType = 'implicit';
  }

  // Aggregate evaluativeScore as confidence-weighted average
  let weightedSum = 0;
  let weightTotal = 0;
  for (const s of signals) {
    weightedSum += s.reward * s.confidence;
    weightTotal += s.confidence;
  }
  const evaluativeScore = weightTotal > 0 ? Math.max(-1, Math.min(1, weightedSum / weightTotal)) : 0;

  // Build directiveText from all signal reasons
  const directiveText = signals.map(s => s.reason).join('; ');

  // Extract dimension tags like "verbosity:decrease"
  const tags: string[] = [];
  for (const s of signals) {
    for (const [dim, val] of Object.entries(s.dimensions)) {
      if (val !== undefined) {
        const direction = val < 0 ? 'decrease' : 'increase';
        const tag = `${dim}:${direction}`;
        if (!tags.includes(tag)) {
          tags.push(tag);
        }
      }
    }
  }

  return buildFeedbackEvent({
    sessionId: opts.sessionId,
    userId: opts.userId,
    agentId: opts.agentId,
    userInput: opts.userInput,
    assistantOutput: opts.assistantOutput,
    feedbackType,
    directiveText,
    evaluativeScore,
    tags,
    safetyFlags: [],
    model: opts.model,
    trigger: opts.trigger,
  });
}
