// Personalization engine: implicit feedback detection, per-user preference profiles,
// and prompt injection for online adaptation without model fine-tuning.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type {
  FeedbackSignal,
  UserProfile,
  PreferenceDimensions,
  PersonalizationConfig,
  ChatMessage,
} from './types.js';

// --- Constants ---

const DEFAULT_CONFIG: Required<PersonalizationConfig> = {
  enabled: true,
  learningRate: 0.15,
  confidenceThreshold: 0.3,
  decayFactor: 0.98,
  maxDimensionValue: 0.85,
};

const DIMENSION_KEYS: (keyof PreferenceDimensions)[] = [
  'verbosity', 'directness', 'formatting', 'initiative', 'technicalDepth',
];

// --- Profiles Directory ---

let profilesDirOverride: string | null = null;

export function setProfilesDirForTesting(dir: string): void {
  profilesDirOverride = dir;
}

function getProfilesDir(): string {
  return profilesDirOverride || join(homedir(), '.skimpyclaw', 'profiles');
}

function getProfilePath(userId: string): string {
  // Sanitize userId for filesystem safety
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(getProfilesDir(), `${safe}.json`);
}

// --- Profile CRUD ---

export function createDefaultProfile(userId: string): UserProfile {
  return {
    userId,
    preferences: { verbosity: 0, directness: 0, formatting: 0, initiative: 0, technicalDepth: 0 },
    confidence: { verbosity: 0, directness: 0, formatting: 0, initiative: 0, technicalDepth: 0 },
    interactionCount: 0,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function loadProfile(userId: string): UserProfile {
  const path = getProfilePath(userId);
  if (!existsSync(path)) {
    return createDefaultProfile(userId);
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as UserProfile;
  } catch {
    console.log(`[personalization] Failed to load profile for ${userId}, using defaults`);
    return createDefaultProfile(userId);
  }
}

export function saveProfile(profile: UserProfile): void {
  const dir = getProfilesDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = getProfilePath(profile.userId);
  writeFileSync(path, JSON.stringify(profile, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

// --- Signal Detection ---

/** Extract the text content from a ChatMessage */
function messageText(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  const textBlock = msg.content.find(b => b.type === 'text');
  return textBlock?.type === 'text' ? textBlock.text : '';
}

// Correction patterns: user explicitly says something was wrong
const CORRECTION_PATTERNS = [
  /\b(?:that's|that is|thats)\s+(?:wrong|incorrect|not right|not what I)/i,
  /\b(?:no|nope),?\s+(?:I\s+(?:meant|said|asked|wanted)|what I\s+(?:meant|want))/i,
  /\bactually,?\s+(?:I\s+(?:meant|want|need)|what I)/i,
  /\b(?:you\s+(?:misunderstood|got\s+(?:it|that)\s+wrong|missed\s+(?:the|my)\s+point))/i,
  /\b(?:not\s+what\s+I\s+(?:asked|meant|wanted))\b/i,
  /\b(?:I\s+didn'?t\s+(?:ask|mean|want)\s+(?:for\s+)?that)\b/i,
  /\b(?:wrong\s+(?:answer|response|approach))\b/i,
];

// Reask patterns: user repeats same intent because prior response missed
const REASK_PATTERNS = [
  /\b(?:I\s+(?:already|just)\s+(?:asked|said|told you))\b/i,
  /\b(?:again|once more|one more time|let me (?:re(?:phrase|state)|try again))\b/i,
  /\b(?:as I (?:said|mentioned|asked))\b/i,
  /\b(?:can you (?:just|actually|please)\s+(?:answer|tell me|do))\b/i,
  /\b(?:you didn'?t (?:answer|address|respond to))\b/i,
];

// Positive acceptance patterns
const ACCEPTANCE_PATTERNS = [
  /\b(?:thanks|thank you|perfect|exactly|that'?s?\s+(?:right|correct|it|great|helpful))\b/i,
  /\b(?:yes|yep|yup|yeah),?\s+(?:that|exactly|perfect|right)/i,
  /\b(?:got it|makes sense|understood|nice|awesome|works)\b/i,
];

// Verbosity signals
const WANTS_SHORTER = [
  /\b(?:too\s+(?:long|verbose|much|detailed|wordy))\b/i,
  /\b(?:shorter|brief|concise|tl;?dr|summarize|just\s+the\s+(?:answer|gist|tl;?dr))\b/i,
  /\b(?:skip\s+the\s+(?:explanation|details|preamble))\b/i,
];

const WANTS_LONGER = [
  /\b(?:more\s+(?:detail|details|explanation|context|info|information))\b/i,
  /\b(?:elaborate|explain\s+(?:more|further|in\s+detail))\b/i,
  /\b(?:can you (?:expand|go\s+deeper|explain))\b/i,
];

// Formatting signals
const WANTS_STRUCTURED = [
  /\b(?:list|bullet\s*points?|numbered|steps?|table|format)\b/i,
];

const WANTS_PROSE = [
  /\b(?:just\s+(?:tell|explain|say)|in\s+(?:plain|simple)\s+(?:text|words)|no\s+(?:bullets|lists|formatting))\b/i,
];

// Technical depth signals
const WANTS_DEEPER = [
  /\b(?:why\s+(?:does|is|did)|how\s+(?:does|is)\s+(?:that|this)\s+(?:work|implemented))\b/i,
  /\b(?:under\s+the\s+hood|internal|implementation\s+detail)\b/i,
];

const WANTS_SIMPLER = [
  /\b(?:too\s+technical|simpler|in\s+(?:plain|simple)\s+(?:terms|english|language))\b/i,
  /\b(?:eli5|explain\s+like|high[\s-]?level)\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

/**
 * Detect implicit feedback signals from the current user message,
 * considering the conversation history for context.
 */
export function detectSignals(
  userMessage: string,
  history: ChatMessage[],
): FeedbackSignal[] {
  const signals: FeedbackSignal[] = [];
  const text = userMessage.trim();
  if (!text) return signals;

  // Find the last assistant message for context
  const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');
  const lastAssistantText = lastAssistant ? messageText(lastAssistant) : '';

  // --- Explicit correction detection ---
  if (matchesAny(text, CORRECTION_PATTERNS)) {
    signals.push({
      type: 'correction',
      reward: -0.6,
      dimensions: {},
      confidence: 0.8,
      reason: 'User explicitly corrected the response',
    });
  }

  // --- Reask detection ---
  if (matchesAny(text, REASK_PATTERNS)) {
    signals.push({
      type: 'reask',
      reward: -0.4,
      dimensions: {},
      confidence: 0.7,
      reason: 'User re-asked or indicated prior response missed the point',
    });
  }

  // --- Semantic reask: short follow-up question that repeats key words from a recent user message ---
  if (history.length >= 2 && !matchesAny(text, REASK_PATTERNS)) {
    const recentUserMsgs = history.filter(m => m.role === 'user').slice(-2);
    for (const prev of recentUserMsgs) {
      const prevText = messageText(prev);
      if (prevText && computeWordOverlap(text, prevText) > 0.5 && text.length < prevText.length * 1.3) {
        signals.push({
          type: 'reask',
          reward: -0.3,
          dimensions: {},
          confidence: 0.5,
          reason: 'User message has high word overlap with recent message (likely restating)',
        });
        break;
      }
    }
  }

  // --- Acceptance detection ---
  if (matchesAny(text, ACCEPTANCE_PATTERNS) && lastAssistantText) {
    signals.push({
      type: 'acceptance',
      reward: 0.3,
      dimensions: {},
      confidence: 0.6,
      reason: 'User accepted or praised the response',
    });
  }

  // --- Smooth continuation: user moves to a new topic without complaint ---
  // Heuristic: if the last exchange happened and the current message doesn't match
  // any negative pattern and doesn't look like a correction, treat as mild positive
  if (
    lastAssistantText &&
    signals.length === 0 &&
    !matchesAny(text, CORRECTION_PATTERNS) &&
    !matchesAny(text, REASK_PATTERNS) &&
    text.length > 10
  ) {
    signals.push({
      type: 'acceptance',
      reward: 0.1,
      dimensions: {},
      confidence: 0.3,
      reason: 'Smooth follow-up without complaint (implicit acceptance)',
    });
  }

  // --- Dimension-specific signals ---

  // Verbosity
  if (matchesAny(text, WANTS_SHORTER)) {
    signals.push({
      type: 'correction',
      reward: -0.4,
      dimensions: { verbosity: -0.4 },
      confidence: 0.8,
      reason: 'User wants shorter responses',
    });
  } else if (matchesAny(text, WANTS_LONGER)) {
    signals.push({
      type: 'correction',
      reward: -0.3,
      dimensions: { verbosity: 0.4 },
      confidence: 0.7,
      reason: 'User wants more detailed responses',
    });
  }

  // Formatting
  if (matchesAny(text, WANTS_STRUCTURED)) {
    signals.push({
      type: 'correction',
      reward: -0.2,
      dimensions: { formatting: 0.3 },
      confidence: 0.6,
      reason: 'User prefers structured formatting',
    });
  } else if (matchesAny(text, WANTS_PROSE)) {
    signals.push({
      type: 'correction',
      reward: -0.2,
      dimensions: { formatting: -0.3 },
      confidence: 0.6,
      reason: 'User prefers prose over structured formatting',
    });
  }

  // Technical depth
  if (matchesAny(text, WANTS_DEEPER)) {
    signals.push({
      type: 'correction',
      reward: -0.2,
      dimensions: { technicalDepth: 0.3 },
      confidence: 0.6,
      reason: 'User wants deeper technical detail',
    });
  } else if (matchesAny(text, WANTS_SIMPLER)) {
    signals.push({
      type: 'correction',
      reward: -0.3,
      dimensions: { technicalDepth: -0.4 },
      confidence: 0.7,
      reason: 'User wants simpler explanations',
    });
  }

  return signals;
}

/**
 * Compute word overlap ratio between two messages (Jaccard-like).
 * Returns 0-1 where 1 means identical word sets.
 */
export function computeWordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

// --- Profile Update ---

/**
 * Apply detected signals to a user profile. Returns the updated profile.
 * Uses bounded exponential moving average with decay.
 */
export function updateProfile(
  profile: UserProfile,
  signals: FeedbackSignal[],
  config?: PersonalizationConfig,
): UserProfile {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const updated = structuredClone(profile);

  // Apply decay toward neutral on every turn
  for (const dim of DIMENSION_KEYS) {
    updated.preferences[dim] *= cfg.decayFactor;
    // Decay confidence slightly too (slower)
    updated.confidence[dim] *= (1 - (1 - cfg.decayFactor) * 0.3);
  }

  // Apply each signal
  for (const signal of signals) {
    if (signal.confidence < cfg.confidenceThreshold) continue;

    // Update specific dimensions if the signal targets them
    for (const dim of DIMENSION_KEYS) {
      const delta = signal.dimensions[dim];
      if (delta !== undefined && delta !== 0) {
        const lr = cfg.learningRate * signal.confidence;
        updated.preferences[dim] += delta * lr;
        // Clamp to bounds
        updated.preferences[dim] = clamp(updated.preferences[dim], -cfg.maxDimensionValue, cfg.maxDimensionValue);
        // Boost confidence for this dimension
        updated.confidence[dim] = Math.min(1, updated.confidence[dim] + 0.1 * signal.confidence);
      }
    }
  }

  updated.interactionCount++;
  updated.updatedAt = new Date().toISOString();

  return updated;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// --- Prompt Injection ---

/** Dimension labels for the prompt */
const DIMENSION_LABELS: Record<keyof PreferenceDimensions, { low: string; high: string; name: string }> = {
  verbosity: { low: 'brief and concise', high: 'detailed and thorough', name: 'Response length' },
  directness: { low: 'diplomatic and gentle', high: 'direct and blunt', name: 'Communication style' },
  formatting: { low: 'flowing prose', high: 'structured with lists/headers', name: 'Formatting' },
  initiative: { low: 'reactive (wait for explicit asks)', high: 'proactive (suggest and anticipate)', name: 'Initiative' },
  technicalDepth: { low: 'high-level overviews', high: 'deep technical detail', name: 'Technical depth' },
};

/**
 * Generate a system prompt section describing the user's learned preferences.
 * Only includes dimensions with sufficient confidence.
 */
export function buildPersonalizationPrompt(
  profile: UserProfile,
  config?: PersonalizationConfig,
): string {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!profile.enabled) return '';
  if (profile.interactionCount < 3) return ''; // Need minimum interactions

  const lines: string[] = [];

  for (const dim of DIMENSION_KEYS) {
    const value = profile.preferences[dim];
    const conf = profile.confidence[dim];

    // Skip dimensions with low confidence or near-neutral values
    if (conf < cfg.confidenceThreshold) continue;
    if (Math.abs(value) < 0.15) continue;

    const label = DIMENSION_LABELS[dim];
    const strength = Math.abs(value) > 0.5 ? 'strongly' : 'slightly';
    const direction = value > 0 ? label.high : label.low;
    lines.push(`- ${label.name}: ${strength} prefers ${direction}`);
  }

  if (lines.length === 0) return '';

  return [
    '',
    '## User Preferences (learned from interaction patterns)',
    'Adapt your responses to match these observed preferences:',
    ...lines,
    '',
    'These are soft preferences — override them when the situation clearly calls for a different approach.',
  ].join('\n');
}

// --- High-Level API ---

/**
 * Process a user turn: detect signals, update profile, return prompt section.
 * This is the main entry point called from agent.ts.
 */
export function processUserTurn(
  userId: string,
  userMessage: string,
  history: ChatMessage[],
  config?: PersonalizationConfig,
): { promptSection: string; signals: FeedbackSignal[]; profile: UserProfile } {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return { promptSection: '', signals: [], profile: createDefaultProfile(userId) };
  }

  const profile = loadProfile(userId);
  if (!profile.enabled) {
    return { promptSection: '', signals: [], profile };
  }

  const signals = detectSignals(userMessage, history);
  const updatedProfile = updateProfile(profile, signals, config);

  // Persist
  saveProfile(updatedProfile);

  const promptSection = buildPersonalizationPrompt(updatedProfile, config);

  if (signals.length > 0) {
    console.log(
      `[personalization] User ${userId}: ${signals.length} signal(s) detected — ` +
      signals.map(s => `${s.type}(${s.reward.toFixed(2)})`).join(', ')
    );
  }

  return { promptSection, signals, profile: updatedProfile };
}

/**
 * Opt a user in or out of personalization.
 */
export function setUserOptOut(userId: string, optOut: boolean): void {
  const profile = loadProfile(userId);
  profile.enabled = !optOut;
  if (optOut) {
    // Reset preferences when opting out
    for (const dim of DIMENSION_KEYS) {
      profile.preferences[dim] = 0;
      profile.confidence[dim] = 0;
    }
  }
  saveProfile(profile);
}

export function getResolvedConfig(config?: PersonalizationConfig): Required<PersonalizationConfig> {
  return { ...DEFAULT_CONFIG, ...config };
}
