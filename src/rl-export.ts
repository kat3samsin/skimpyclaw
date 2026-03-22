// RL Export — DPO-style preference pair generation from feedback events

import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import type { RLFeedbackEvent, PreferencePair, RewardJudgment } from './types.js';
import { readFeedbackEvents } from './rl-feedback.js';

// --- Heuristic reward judge ---

/** Simple heuristic reward judgment based on feedback type and evaluative score */
export function heuristicRewardJudge(event: RLFeedbackEvent): RewardJudgment {
  const score = event.evaluativeScore;
  let confidence: number;

  switch (event.feedbackType) {
    case 'explicit_correction':
      confidence = 0.8;
      break;
    case 'approval':
      confidence = 0.7;
      break;
    case 'implicit':
    default:
      confidence = 0.3;
      break;
  }

  return {
    score,
    confidence,
    reason: `Heuristic: ${event.feedbackType} with score ${score}`,
  };
}

// --- Preference pair generation ---

export interface GenerateOptions {
  excludeTags?: string[];
  excludeSafetyFlags?: string[];
  rewardJudge?: (event: RLFeedbackEvent) => RewardJudgment;
}

/** Generate DPO-style preference pairs from feedback events.
 *  Only explicit_correction events produce pairs (no rejected sample for approval/implicit). */
export function generatePreferencePairs(
  events: RLFeedbackEvent[],
  opts: GenerateOptions = {},
): PreferencePair[] {
  const excludeSafetyFlags = opts.excludeSafetyFlags ?? ['contains_secret'];
  const excludeTags = opts.excludeTags ?? [];
  const judge = opts.rewardJudge ?? heuristicRewardJudge;

  const pairs: PreferencePair[] = [];

  for (const event of events) {
    // Only explicit_correction events produce pairs
    if (event.feedbackType !== 'explicit_correction') continue;

    // Skip events with matching safety flags
    if (event.safetyFlags.some(f => excludeSafetyFlags.includes(f))) continue;

    // Skip events with matching tags
    if (event.tags.some(t => excludeTags.includes(t))) continue;

    const judgment = judge(event);
    const absScore = Math.abs(judgment.score);

    pairs.push({
      id: randomUUID().slice(0, 8),
      prompt: event.userInput,
      chosen: `[Corrected per user feedback] ${event.directiveText}`,
      rejected: event.assistantOutput,
      reward_chosen: absScore,
      reward_rejected: -absScore,
      metadata: {
        userId: event.userId,
        sessionId: event.sessionId,
        timestamp: event.timestamp,
        feedbackType: event.feedbackType,
        model: event.model,
      },
    });
  }

  return pairs;
}

// --- Export ---

export interface ExportOptions {
  outputPath: string;
  startDate?: string;
  endDate?: string;
  excludeTags?: string[];
  excludeSafetyFlags?: string[];
  rewardJudge?: (event: RLFeedbackEvent) => RewardJudgment;
}

/** Export preference pairs to a JSONL file. Returns the number of pairs written.
 *  If no pairs, the file is not created. */
export function exportPreferencePairs(opts: ExportOptions): number {
  const { events } = readFeedbackEvents({
    startDate: opts.startDate,
    endDate: opts.endDate,
    limit: 10000,  // large limit for export
  });

  const pairs = generatePreferencePairs(events, {
    excludeTags: opts.excludeTags,
    excludeSafetyFlags: opts.excludeSafetyFlags,
    rewardJudge: opts.rewardJudge,
  });

  if (pairs.length === 0) return 0;

  const jsonl = pairs.map(p => JSON.stringify(p)).join('\n') + '\n';
  writeFileSync(opts.outputPath, jsonl, 'utf-8');

  return pairs.length;
}
