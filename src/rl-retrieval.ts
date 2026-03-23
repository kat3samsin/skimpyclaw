// RL Retrieval — rank and retrieve relevant correction events for prompt injection

import { readFeedbackEvents } from './rl-feedback.js';
import type { RLFeedbackEvent } from './types.js';

// --- Helpers ---

/** Truncate a string to maxLen, appending "..." if truncated */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

/**
 * Compute word overlap between two strings (Jaccard similarity).
 * Returns a value between 0 and 1.
 */
export function computeWordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

// --- Ranking ---

/**
 * Rank correction events by a combined recency + semantic similarity score.
 * Score = 0.4 * recencyScore + 0.6 * similarity
 * Recency uses a 7-day exponential half-life: Math.exp(-ageDays / 7)
 * Similarity uses computeWordOverlap(currentInput, correction.userInput)
 *
 * Returns a new array sorted most-relevant first.
 * Empty currentInput → returns empty array.
 */
export function rankCorrections(
  corrections: RLFeedbackEvent[],
  currentInput: string,
): RLFeedbackEvent[] {
  if (!currentInput || currentInput.trim() === '') return [];
  if (corrections.length === 0) return [];

  const now = Date.now();

  const scored = corrections.map(c => {
    const ageDays = (now - Date.parse(c.timestamp)) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.exp(-ageDays / 7);
    const similarity = computeWordOverlap(currentInput, c.userInput);
    const score = 0.4 * recencyScore + 0.6 * similarity;
    return { correction: c, score };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.map(s => s.correction);
}

// --- Retrieval ---

export interface RetrieveCorrectionsOptions {
  userId: string;
  currentInput: string;
  maxResults?: number;
  lookbackDays?: number;
}

/**
 * Retrieve the most relevant explicit_correction events for the given user and input.
 * Only returns events with feedbackType === 'explicit_correction'.
 * Reads the last lookbackDays (default 30) of events.
 * Ranks via rankCorrections and returns the top maxResults (default 5).
 */
export function retrieveRelevantCorrections(opts: RetrieveCorrectionsOptions): RLFeedbackEvent[] {
  const { userId, currentInput } = opts;
  const maxResults = opts.maxResults ?? 5;
  const lookbackDays = opts.lookbackDays ?? 30;

  const now = new Date();
  const startDate = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const startDateStr = startDate.toISOString().slice(0, 10);
  const endDateStr = now.toISOString().slice(0, 10);

  const { events } = readFeedbackEvents({
    userId,
    feedbackType: 'explicit_correction',
    startDate: startDateStr,
    endDate: endDateStr,
    limit: 1000, // fetch a generous batch before ranking
  });

  const ranked = rankCorrections(events, currentInput);

  return ranked.slice(0, maxResults);
}

// --- Prompt Building ---

const HEADER = '## Prior Corrections (learned from past interactions)';
const FOOTER = 'Apply these corrections with judgment — they reflect past preferences, not absolute rules.';
const DEFAULT_MAX_TOKENS = 500;
const CHARS_PER_TOKEN = 4;

/**
 * Build a prompt section from an array of correction events.
 * Returns empty string if corrections is empty.
 * Respects a token budget (default 500 tokens, ~4 chars/token).
 * Returns empty string if no corrections fit within the budget after the header.
 */
export function buildCorrectionsPrompt(
  corrections: RLFeedbackEvent[],
  opts?: { maxTokens?: number },
): string {
  if (corrections.length === 0) return '';

  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const budget = maxTokens * CHARS_PER_TOKEN;

  // Measure fixed structure: header + newline + footer + surrounding newlines
  const headerLine = HEADER + '\n';
  const footerLine = '\n' + FOOTER;
  const fixedChars = headerLine.length + footerLine.length + 1; // +1 for newline before footer

  let remaining = budget - fixedChars;
  const lines: string[] = [];

  for (const c of corrections) {
    // Truncate userInput to 80 chars for readability
    const inputSnippet = truncate(c.userInput, 80);
    const line = `- When asked "${inputSnippet}": ${c.directiveText}`;
    const lineWithNewline = line + '\n';

    if (remaining < lineWithNewline.length) break;

    lines.push(line);
    remaining -= lineWithNewline.length;
  }

  if (lines.length === 0) return '';

  return [headerLine + lines.join('\n') + footerLine].join('');
}
