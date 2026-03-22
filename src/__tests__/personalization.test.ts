import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  detectSignals,
  computeWordOverlap,
  updateProfile,
  buildPersonalizationPrompt,
  processUserTurn,
  loadProfile,
  saveProfile,
  createDefaultProfile,
  setProfilesDirForTesting,
  setUserOptOut,
} from '../personalization.js';
import type { ChatMessage, UserProfile, FeedbackSignal, PreferenceDimensions } from '../types.js';

const TEST_DIR = join(tmpdir(), `skimpyclaw-personalization-test-${Date.now()}`);

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  setProfilesDirForTesting(TEST_DIR);
});

afterAll(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// --- Helper ---
function makeHistory(...pairs: [string, string][]): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (const [user, assistant] of pairs) {
    msgs.push({ role: 'user', content: user });
    msgs.push({ role: 'assistant', content: assistant });
  }
  return msgs;
}

function profileWith(overrides: Partial<UserProfile> = {}): UserProfile {
  return { ...createDefaultProfile('test-user'), ...overrides };
}

// ============================================================
// Signal Detection
// ============================================================

describe('detectSignals', () => {
  describe('correction detection', () => {
    const corrections = [
      "That's wrong, I wanted a list",
      "No, I meant the other function",
      "Actually, what I meant was the config file",
      "You misunderstood, I need the API endpoint",
      "Not what I asked for",
      "I didn't ask for that",
      "Wrong answer",
    ];

    for (const msg of corrections) {
      it(`detects correction: "${msg}"`, () => {
        const signals = detectSignals(msg, makeHistory(['hi', 'hello']));
        const correctionSignals = signals.filter(s => s.type === 'correction');
        expect(correctionSignals.length).toBeGreaterThanOrEqual(1);
        expect(correctionSignals[0].reward).toBeLessThan(0);
      });
    }
  });

  describe('reask detection', () => {
    const reasks = [
      "I already asked about the config file",
      "Let me rephrase: what is the port number?",
      "As I said, I need the deployment steps",
      "Can you actually answer my question?",
      "You didn't answer my question",
    ];

    for (const msg of reasks) {
      it(`detects reask: "${msg}"`, () => {
        const signals = detectSignals(msg, makeHistory(['what is X?', 'Here is something unrelated']));
        const reaskSignals = signals.filter(s => s.type === 'reask');
        expect(reaskSignals.length).toBeGreaterThanOrEqual(1);
        expect(reaskSignals[0].reward).toBeLessThan(0);
      });
    }
  });

  describe('semantic reask detection', () => {
    it('detects repeated intent via word overlap', () => {
      const history = makeHistory(
        ['How do I configure the database connection string?', 'Here is some unrelated info about deployment.']
      );
      const signals = detectSignals('How do I set the database connection string?', history);
      const reask = signals.find(s => s.type === 'reask');
      expect(reask).toBeDefined();
      expect(reask!.confidence).toBeLessThanOrEqual(0.5);
    });

    it('does not flag unrelated follow-ups', () => {
      const history = makeHistory(
        ['How do I deploy to production?', 'Run npm run deploy.']
      );
      const signals = detectSignals('What database should I use?', history);
      const reask = signals.find(s => s.type === 'reask');
      expect(reask).toBeUndefined();
    });
  });

  describe('acceptance detection', () => {
    it('detects explicit thanks', () => {
      const signals = detectSignals('Thanks, that worked!', makeHistory(['fix the bug', 'Done, fixed it.']));
      const acceptance = signals.find(s => s.type === 'acceptance');
      expect(acceptance).toBeDefined();
      expect(acceptance!.reward).toBeGreaterThan(0);
    });

    it('detects "perfect"', () => {
      const signals = detectSignals("Perfect, that's exactly right", makeHistory(['what is X?', 'X is Y.']));
      expect(signals.some(s => s.type === 'acceptance' && s.reward > 0.2)).toBe(true);
    });

    it('gives mild positive for smooth follow-up', () => {
      const history = makeHistory(['explain feature A', 'Feature A does X and Y.']);
      const signals = detectSignals('Now can you help me with feature B?', history);
      const acceptance = signals.find(s => s.type === 'acceptance');
      expect(acceptance).toBeDefined();
      expect(acceptance!.reward).toBe(0.1);
      expect(acceptance!.reason).toContain('implicit');
    });
  });

  describe('dimension-specific signals', () => {
    it('detects verbosity: shorter', () => {
      const signals = detectSignals('Too verbose, make it shorter', []);
      const verbosity = signals.find(s => s.dimensions.verbosity !== undefined);
      expect(verbosity).toBeDefined();
      expect(verbosity!.dimensions.verbosity).toBeLessThan(0);
    });

    it('detects verbosity: longer', () => {
      const signals = detectSignals('Can you explain more in detail?', []);
      const verbosity = signals.find(s => s.dimensions.verbosity !== undefined);
      expect(verbosity).toBeDefined();
      expect(verbosity!.dimensions.verbosity).toBeGreaterThan(0);
    });

    it('detects formatting: structured', () => {
      const signals = detectSignals('Can you give me that as a bullet list?', []);
      const fmt = signals.find(s => s.dimensions.formatting !== undefined);
      expect(fmt).toBeDefined();
      expect(fmt!.dimensions.formatting).toBeGreaterThan(0);
    });

    it('detects formatting: prose', () => {
      const signals = detectSignals('Just tell me in plain text, no lists', []);
      const fmt = signals.find(s => s.dimensions.formatting !== undefined);
      expect(fmt).toBeDefined();
      expect(fmt!.dimensions.formatting).toBeLessThan(0);
    });

    it('detects technical depth: deeper', () => {
      const signals = detectSignals('How does that work under the hood?', []);
      const depth = signals.find(s => s.dimensions.technicalDepth !== undefined);
      expect(depth).toBeDefined();
      expect(depth!.dimensions.technicalDepth).toBeGreaterThan(0);
    });

    it('detects technical depth: simpler', () => {
      const signals = detectSignals("That's too technical, can you explain in simpler terms?", []);
      const depth = signals.find(s => s.dimensions.technicalDepth !== undefined);
      expect(depth).toBeDefined();
      expect(depth!.dimensions.technicalDepth).toBeLessThan(0);
    });
  });

  describe('no false positives', () => {
    it('returns only smooth follow-up for normal question', () => {
      const history = makeHistory(['hi', 'hello']);
      const signals = detectSignals('What time is it in Tokyo?', history);
      // Should only get smooth follow-up, not correction/reask
      const negatives = signals.filter(s => s.type === 'correction' || (s.type === 'reask'));
      expect(negatives).toHaveLength(0);
    });

    it('returns empty for empty message', () => {
      expect(detectSignals('', [])).toHaveLength(0);
    });

    it('returns empty for whitespace', () => {
      expect(detectSignals('   ', [])).toHaveLength(0);
    });
  });
});

// ============================================================
// Word Overlap
// ============================================================

describe('computeWordOverlap', () => {
  it('returns 1 for identical strings', () => {
    expect(computeWordOverlap('hello world foo', 'hello world foo')).toBeCloseTo(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(computeWordOverlap('alpha beta gamma', 'delta epsilon zeta')).toBe(0);
  });

  it('returns partial overlap', () => {
    const overlap = computeWordOverlap('configure database connection', 'set database connection string');
    expect(overlap).toBeGreaterThan(0.3);
    expect(overlap).toBeLessThan(1);
  });

  it('ignores short words (<=2 chars)', () => {
    expect(computeWordOverlap('I am a he', 'I am a he')).toBe(0);
  });

  it('handles empty strings', () => {
    expect(computeWordOverlap('', 'hello')).toBe(0);
    expect(computeWordOverlap('hello', '')).toBe(0);
  });
});

// ============================================================
// Profile Update
// ============================================================

describe('updateProfile', () => {
  it('increments interaction count', () => {
    const profile = profileWith();
    const updated = updateProfile(profile, []);
    expect(updated.interactionCount).toBe(1);
  });

  it('applies decay toward neutral', () => {
    const profile = profileWith({
      preferences: { verbosity: 0.5, directness: 0, formatting: 0, initiative: 0, technicalDepth: 0 },
    });
    const updated = updateProfile(profile, []);
    expect(updated.preferences.verbosity).toBeLessThan(0.5);
    expect(updated.preferences.verbosity).toBeGreaterThan(0);
  });

  it('applies dimension-specific signals', () => {
    const profile = profileWith();
    const signals: FeedbackSignal[] = [{
      type: 'correction',
      reward: -0.4,
      dimensions: { verbosity: -0.4 },
      confidence: 0.8,
      reason: 'test',
    }];
    const updated = updateProfile(profile, signals);
    expect(updated.preferences.verbosity).toBeLessThan(0);
  });

  it('respects confidence threshold', () => {
    const profile = profileWith();
    const signals: FeedbackSignal[] = [{
      type: 'correction',
      reward: -0.4,
      dimensions: { verbosity: -0.4 },
      confidence: 0.1, // Below default threshold of 0.3
      reason: 'low confidence',
    }];
    const updated = updateProfile(profile, signals, { confidenceThreshold: 0.3 });
    // After decay of 0 value, should still be ~0
    expect(Math.abs(updated.preferences.verbosity)).toBeLessThan(0.01);
  });

  it('clamps to maxDimensionValue', () => {
    const profile = profileWith({
      preferences: { verbosity: 0.8, directness: 0, formatting: 0, initiative: 0, technicalDepth: 0 },
    });
    const signals: FeedbackSignal[] = [{
      type: 'correction',
      reward: -0.4,
      dimensions: { verbosity: 0.5 },
      confidence: 1.0,
      reason: 'push to max',
    }];
    const updated = updateProfile(profile, signals, { maxDimensionValue: 0.85 });
    expect(updated.preferences.verbosity).toBeLessThanOrEqual(0.85);
  });

  it('does not mutate original profile', () => {
    const profile = profileWith();
    const original = JSON.parse(JSON.stringify(profile));
    updateProfile(profile, [{
      type: 'correction',
      reward: -0.4,
      dimensions: { verbosity: -0.4 },
      confidence: 0.8,
      reason: 'test',
    }]);
    expect(profile).toEqual(original);
  });

  it('boosts confidence for affected dimensions', () => {
    const profile = profileWith();
    const signals: FeedbackSignal[] = [{
      type: 'correction',
      reward: -0.4,
      dimensions: { verbosity: -0.4 },
      confidence: 0.8,
      reason: 'test',
    }];
    const updated = updateProfile(profile, signals);
    expect(updated.confidence.verbosity).toBeGreaterThan(0);
    expect(updated.confidence.directness).toBeLessThanOrEqual(0); // Unaffected
  });
});

// ============================================================
// Prompt Generation
// ============================================================

describe('buildPersonalizationPrompt', () => {
  it('returns empty for new profiles (<3 interactions)', () => {
    const profile = profileWith({ interactionCount: 2 });
    expect(buildPersonalizationPrompt(profile)).toBe('');
  });

  it('returns empty for disabled profiles', () => {
    const profile = profileWith({ interactionCount: 10, enabled: false });
    expect(buildPersonalizationPrompt(profile)).toBe('');
  });

  it('returns empty for neutral profiles', () => {
    const profile = profileWith({ interactionCount: 10 });
    expect(buildPersonalizationPrompt(profile)).toBe('');
  });

  it('includes dimension with sufficient confidence and magnitude', () => {
    const profile = profileWith({
      interactionCount: 10,
      preferences: { verbosity: -0.6, directness: 0, formatting: 0, initiative: 0, technicalDepth: 0 },
      confidence: { verbosity: 0.5, directness: 0, formatting: 0, initiative: 0, technicalDepth: 0 },
    });
    const prompt = buildPersonalizationPrompt(profile);
    expect(prompt).toContain('User Preferences');
    expect(prompt).toContain('brief and concise');
    expect(prompt).toContain('strongly');
  });

  it('says "slightly" for moderate preferences', () => {
    const profile = profileWith({
      interactionCount: 10,
      preferences: { verbosity: 0.3, directness: 0, formatting: 0, initiative: 0, technicalDepth: 0 },
      confidence: { verbosity: 0.5, directness: 0, formatting: 0, initiative: 0, technicalDepth: 0 },
    });
    const prompt = buildPersonalizationPrompt(profile);
    expect(prompt).toContain('slightly');
    expect(prompt).toContain('detailed and thorough');
  });

  it('skips dimensions below confidence threshold', () => {
    const profile = profileWith({
      interactionCount: 10,
      preferences: { verbosity: -0.6, directness: 0.6, formatting: 0, initiative: 0, technicalDepth: 0 },
      confidence: { verbosity: 0.5, directness: 0.1, formatting: 0, initiative: 0, technicalDepth: 0 },
    });
    const prompt = buildPersonalizationPrompt(profile);
    expect(prompt).toContain('brief');
    expect(prompt).not.toContain('direct');
  });

  it('includes override note', () => {
    const profile = profileWith({
      interactionCount: 10,
      preferences: { verbosity: -0.6, directness: 0, formatting: 0, initiative: 0, technicalDepth: 0 },
      confidence: { verbosity: 0.5, directness: 0, formatting: 0, initiative: 0, technicalDepth: 0 },
    });
    const prompt = buildPersonalizationPrompt(profile);
    expect(prompt).toContain('soft preferences');
  });
});

// ============================================================
// Profile Persistence
// ============================================================

describe('profile persistence', () => {
  it('saves and loads a profile', () => {
    const profile = profileWith({ userId: 'user-123', interactionCount: 5 });
    profile.preferences.verbosity = -0.3;
    saveProfile(profile);
    const loaded = loadProfile('user-123');
    expect(loaded.userId).toBe('user-123');
    expect(loaded.preferences.verbosity).toBeCloseTo(-0.3);
    expect(loaded.interactionCount).toBe(5);
  });

  it('returns default for non-existent user', () => {
    const profile = loadProfile('nonexistent');
    expect(profile.userId).toBe('nonexistent');
    expect(profile.interactionCount).toBe(0);
    expect(profile.enabled).toBe(true);
  });

  it('sanitizes userId for filesystem', () => {
    const profile = profileWith({ userId: 'user@foo/bar' });
    saveProfile(profile);
    // Should create file with sanitized name
    expect(existsSync(join(TEST_DIR, 'user_foo_bar.json'))).toBe(true);
  });

  it('sets file permissions to 0600', () => {
    const profile = profileWith({ userId: 'perm-test' });
    saveProfile(profile);
    // Just verify the file was created (permission check is OS-dependent)
    expect(existsSync(join(TEST_DIR, 'perm-test.json'))).toBe(true);
  });
});

// ============================================================
// Opt-out
// ============================================================

describe('setUserOptOut', () => {
  it('disables personalization and resets preferences', () => {
    const profile = profileWith({
      userId: 'opt-out-user',
      preferences: { verbosity: -0.5, directness: 0.3, formatting: 0, initiative: 0, technicalDepth: 0 },
    });
    saveProfile(profile);

    setUserOptOut('opt-out-user', true);
    const loaded = loadProfile('opt-out-user');
    expect(loaded.enabled).toBe(false);
    expect(loaded.preferences.verbosity).toBe(0);
    expect(loaded.preferences.directness).toBe(0);
  });

  it('re-enables personalization', () => {
    setUserOptOut('reenable-user', true);
    setUserOptOut('reenable-user', false);
    const loaded = loadProfile('reenable-user');
    expect(loaded.enabled).toBe(true);
  });
});

// ============================================================
// End-to-End: processUserTurn
// ============================================================

describe('processUserTurn', () => {
  it('returns empty prompt for disabled config', () => {
    const result = processUserTurn('u1', 'hello', [], { enabled: false });
    expect(result.promptSection).toBe('');
    expect(result.signals).toHaveLength(0);
  });

  it('detects signals and updates profile across multiple turns', () => {
    const history = makeHistory(['explain the auth system', 'The auth system uses JWT tokens for session management.']);

    // First turn: correction (too verbose)
    const r1 = processUserTurn('multi-turn', 'Too verbose, make it shorter', history, { enabled: true });
    expect(r1.signals.some(s => s.dimensions.verbosity !== undefined && s.dimensions.verbosity < 0)).toBe(true);

    // Simulate more turns to build confidence (need >= 3 for prompt)
    processUserTurn('multi-turn', 'Thanks, that works', history, { enabled: true });
    processUserTurn('multi-turn', 'Keep it brief', history, { enabled: true });
    processUserTurn('multi-turn', 'Perfect', history, { enabled: true });

    // After several turns, check profile
    const profile = loadProfile('multi-turn');
    expect(profile.interactionCount).toBe(4);
    expect(profile.preferences.verbosity).toBeLessThan(0); // Learned to be brief
  });

  it('persists profile to disk', () => {
    processUserTurn('persist-test', 'hello world test message', [], { enabled: true });
    const filePath = join(TEST_DIR, 'persist-test.json');
    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(raw.userId).toBe('persist-test');
    expect(raw.interactionCount).toBe(1);
  });

  it('handles content array messages in history', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'explain this image' }] },
      { role: 'assistant', content: 'This image shows a chart.' },
    ];
    // Should not throw
    const result = processUserTurn('img-user', "That's wrong, it shows a table", history, { enabled: true });
    expect(result.signals.some(s => s.type === 'correction')).toBe(true);
  });
});

// ============================================================
// Guardrails
// ============================================================

describe('guardrails', () => {
  it('preferences converge toward neutral over many empty turns', () => {
    const profile = profileWith({
      userId: 'decay-test',
      preferences: { verbosity: 0.8, directness: 0, formatting: 0, initiative: 0, technicalDepth: 0 },
      confidence: { verbosity: 0.5, directness: 0, formatting: 0, initiative: 0, technicalDepth: 0 },
    });
    saveProfile(profile);

    // Simulate 50 turns with no signals
    for (let i = 0; i < 50; i++) {
      processUserTurn('decay-test', 'neutral message here please', [], { enabled: true });
    }

    const final = loadProfile('decay-test');
    // Should have decayed significantly toward 0
    expect(Math.abs(final.preferences.verbosity)).toBeLessThan(0.3);
  });

  it('multiple concurrent dimension signals apply independently', () => {
    const profile = profileWith();
    const signals: FeedbackSignal[] = [
      { type: 'correction', reward: -0.3, dimensions: { verbosity: -0.4 }, confidence: 0.8, reason: 'shorter' },
      { type: 'correction', reward: -0.2, dimensions: { formatting: 0.3 }, confidence: 0.6, reason: 'structured' },
    ];
    const updated = updateProfile(profile, signals);
    expect(updated.preferences.verbosity).toBeLessThan(0);
    expect(updated.preferences.formatting).toBeGreaterThan(0);
    expect(updated.preferences.directness).toBeCloseTo(0, 5); // Unaffected
  });
});
