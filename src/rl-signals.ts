// RL signal detection — extracts FeedbackSignal[] from user messages + conversation history

import type { FeedbackSignal, ChatMessage } from './types.js';

// --- Correction patterns ---

/** Phrases that strongly indicate the user is correcting the assistant */
const CORRECTION_PATTERNS: Array<{ pattern: RegExp; reward: number; confidence: number; reason: string }> = [
  // Explicit negation of assistant's output
  { pattern: /\bno[,.]?\s+(that('?s|\s+is)\s+)?(not|wrong|incorrect)\b/i, reward: -0.8, confidence: 0.9, reason: 'Explicit rejection of assistant output' },
  { pattern: /\bthat('?s|\s+is)\s+(not\s+)?(wrong|incorrect|inaccurate)\b/i, reward: -0.8, confidence: 0.85, reason: 'Marked assistant output as wrong' },
  { pattern: /\byou'?re\s+wrong\b/i, reward: -0.8, confidence: 0.9, reason: 'Direct correction' },

  // Re-asking / rephrasing (also emitted as 'reask' type below)
  { pattern: /\bi\s+(already\s+)?(said|told|asked|mentioned)\b/i, reward: -0.6, confidence: 0.8, reason: 'User re-stated prior instruction' },
  { pattern: /\bthat'?s?\s+not\s+what\s+i\s+(meant|wanted|asked)\b/i, reward: -0.7, confidence: 0.85, reason: 'User clarified misunderstood intent' },
  { pattern: /\bi\s+mean[t]?\b/i, reward: -0.4, confidence: 0.5, reason: 'User clarified meaning' },

  // Directive corrections
  { pattern: /\bdon'?t\s+(do\s+that|use|add|include|put|make)\b/i, reward: -0.6, confidence: 0.8, reason: 'User issued negative directive' },
  { pattern: /\bstop\s+(doing|using|adding|including)\b/i, reward: -0.7, confidence: 0.85, reason: 'User told assistant to stop behavior' },
  { pattern: /\binstead[,.]?\s+(use|do|try|make)\b/i, reward: -0.5, confidence: 0.7, reason: 'User redirected approach' },
  { pattern: /\bplease\s+(fix|correct|change|redo|undo)\b/i, reward: -0.5, confidence: 0.7, reason: 'User requested correction' },

  // Style / format corrections
  { pattern: /\btoo\s+(verbose|long|short|brief|detailed|vague)\b/i, reward: -0.5, confidence: 0.75, reason: 'User corrected response style' },
  { pattern: /\bless\s+(verbose|detailed|wordy)\b/i, reward: -0.4, confidence: 0.7, reason: 'User requested less verbosity' },
  { pattern: /\bmore\s+(detail|specific|concise|brief)\b/i, reward: -0.3, confidence: 0.6, reason: 'User requested style adjustment' },
];

/** Patterns that indicate the user is re-asking because the assistant missed the point */
const REASK_PATTERNS: Array<{ pattern: RegExp; reward: number; confidence: number; reason: string }> = [
  { pattern: /\bcan\s+you\s+(just|actually|please)\s+(re-?do|redo|try\s+again|start\s+over)\b/i, reward: -0.6, confidence: 0.8, reason: 'User asked assistant to redo' },
  { pattern: /\blet\s+me\s+(rephrase|clarify|try\s+again)\b/i, reward: -0.5, confidence: 0.75, reason: 'User rephrasing after misunderstanding' },
  { pattern: /\bwhat\s+i\s+(actually\s+)?(want|need|meant)\s+(is|was)\b/i, reward: -0.5, confidence: 0.7, reason: 'User re-explaining intent' },
  { pattern: /\bi('?ll|will)\s+(try|ask)\s+(again|differently)\b/i, reward: -0.5, confidence: 0.7, reason: 'User retrying after failed understanding' },
];

/** Phrases that indicate approval / acceptance — only meaningful after assistant output.
 *  Short-message gate: single-word approval tokens only match messages under 30 chars
 *  to reduce false positives from normal conversation. */
const APPROVAL_PATTERNS: Array<{ pattern: RegExp; reward: number; confidence: number; reason: string; shortOnly?: boolean }> = [
  { pattern: /\bthat('?s|\s+is)\s+(exactly\s+)?(what\s+i\s+)?(wanted|needed|meant)\b/i, reward: 0.7, confidence: 0.7, reason: 'User confirmed intent match' },
  { pattern: /\b(perfect|exactly|correct)\b/i, reward: 0.5, confidence: 0.5, reason: 'Positive acknowledgment', shortOnly: true },
  { pattern: /\b(thanks|thank\s+you)\b/i, reward: 0.3, confidence: 0.3, reason: 'Gratitude (weak signal)', shortOnly: true },
];

// --- Dimension extraction ---

/** Infer which preference dimensions a correction affects */
function inferDimensions(text: string): Partial<Record<string, number>> {
  const dims: Partial<Record<string, number>> = {};
  if (/\b(verbose|wordy|long|detailed)\b/i.test(text)) dims.verbosity = -1;
  if (/\b(brief|short|concise|terse)\b/i.test(text)) dims.verbosity = 1;
  if (/\b(blunt|direct|straight)\b/i.test(text)) dims.directness = 1;
  if (/\b(gentle|diplomatic|soft)\b/i.test(text)) dims.directness = -1;
  if (/\b(list|bullet|structured|format)\b/i.test(text)) dims.formatting = 1;
  if (/\b(prose|paragraph|flowing)\b/i.test(text)) dims.formatting = -1;
  if (/\b(proactive|suggest|initiative)\b/i.test(text)) dims.initiative = 1;
  if (/\b(only\s+what\s+i\s+ask|reactive|don'?t\s+suggest)\b/i.test(text)) dims.initiative = -1;
  if (/\b(technical|deep|detail)\b/i.test(text)) dims.technicalDepth = 1;
  if (/\b(high.level|overview|simple|simpl)\b/i.test(text)) dims.technicalDepth = -1;
  return dims;
}

// --- Main detection ---

/**
 * Detect feedback signals from a user message and conversation history.
 * Requires at least one prior assistant message in history to detect corrections.
 * Returns an empty array if nothing detected.
 */
export function detectFeedbackSignals(
  userMessage: string,
  history?: ChatMessage[],
): FeedbackSignal[] {
  if (!userMessage || userMessage.trim().length === 0) return [];

  const signals: FeedbackSignal[] = [];
  const hasAssistantHistory = (history || []).some(m => m.role === 'assistant');

  // Only detect corrections/approvals if there's prior assistant output to react to
  if (!hasAssistantHistory) return [];

  // Check correction patterns
  for (const { pattern, reward, confidence, reason } of CORRECTION_PATTERNS) {
    if (pattern.test(userMessage)) {
      signals.push({
        type: 'correction',
        reward,
        confidence,
        reason,
        dimensions: inferDimensions(userMessage),
      });
      break; // Take strongest match only to avoid signal spam
    }
  }

  // Check reask patterns (user re-explaining / retrying)
  if (signals.length === 0) {
    for (const { pattern, reward, confidence, reason } of REASK_PATTERNS) {
      if (pattern.test(userMessage)) {
        signals.push({
          type: 'reask',
          reward,
          confidence,
          reason,
          dimensions: inferDimensions(userMessage),
        });
        break;
      }
    }
  }

  // If no correction or reask, check for approval
  if (signals.length === 0) {
    const isShort = userMessage.trim().length < 30;
    for (const { pattern, reward, confidence, reason, shortOnly } of APPROVAL_PATTERNS) {
      if (shortOnly && !isShort) continue;
      if (pattern.test(userMessage)) {
        signals.push({
          type: 'acceptance',
          reward,
          confidence,
          reason,
          dimensions: {},
        });
        break;
      }
    }
  }

  return signals;
}
