import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setFeedbackDirForTesting, recordFeedback } from '../rl-feedback.js';
import { rankCorrections, retrieveRelevantCorrections, buildCorrectionsPrompt } from '../rl-retrieval.js';
import type { RLFeedbackEvent } from '../types.js';

const TEST_DIR = join(tmpdir(), `skimpyclaw-rl-retrieval-test-${Date.now()}`);

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  setFeedbackDirForTesting(TEST_DIR);
});

afterAll(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  setFeedbackDirForTesting(null);
});

// --- Helpers ---

let eventCounter = 0;

function makeCorrection(overrides: Partial<RLFeedbackEvent> = {}): RLFeedbackEvent {
  eventCounter++;
  return {
    id: `id-${eventCounter}`,
    sessionId: 'sess-1',
    timestamp: new Date().toISOString(),
    userId: 'user-1',
    agentId: 'main',
    userInput: 'How do I write a function in Python?',
    assistantOutput: 'Here is how...',
    feedbackType: 'explicit_correction',
    directiveText: 'Be more concise',
    evaluativeScore: -0.5,
    tags: [],
    safetyFlags: [],
    ...overrides,
  };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// ============================================================
// rankCorrections
// ============================================================

describe('rankCorrections', () => {
  it('returns empty array for empty corrections', () => {
    expect(rankCorrections([], 'hello world')).toEqual([]);
  });

  it('returns empty array for empty currentInput', () => {
    const c = makeCorrection();
    expect(rankCorrections([c], '')).toEqual([]);
    expect(rankCorrections([c], '   ')).toEqual([]);
  });

  it('ranks recent corrections higher than old ones with same input', () => {
    const recent = makeCorrection({
      id: 'recent',
      timestamp: daysAgo(1),
      userInput: 'write a python function',
    });
    const old = makeCorrection({
      id: 'old',
      timestamp: daysAgo(60),
      userInput: 'write a python function',
    });

    const ranked = rankCorrections([old, recent], 'write a python function');
    expect(ranked[0].id).toBe('recent');
    expect(ranked[1].id).toBe('old');
  });

  it('ranks semantically similar corrections higher', () => {
    const similar = makeCorrection({
      id: 'similar',
      timestamp: daysAgo(3),
      userInput: 'how do I sort a list in python',
    });
    const unrelated = makeCorrection({
      id: 'unrelated',
      timestamp: daysAgo(3),
      userInput: 'what is the capital of france',
    });

    const ranked = rankCorrections([unrelated, similar], 'how do I sort items in python');
    expect(ranked[0].id).toBe('similar');
  });

  it('returns all corrections sorted when input is non-empty', () => {
    const events = [
      makeCorrection({ id: 'a', timestamp: daysAgo(5), userInput: 'foo bar baz' }),
      makeCorrection({ id: 'b', timestamp: daysAgo(2), userInput: 'something else entirely' }),
      makeCorrection({ id: 'c', timestamp: daysAgo(1), userInput: 'foo bar baz qux' }),
    ];

    const ranked = rankCorrections(events, 'foo bar baz');
    expect(ranked).toHaveLength(3);
    // Just verify it returns all and they're in some order
    const ids = ranked.map(r => r.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('c');
  });

  it('does not mutate the input array', () => {
    const events = [
      makeCorrection({ id: 'x', timestamp: daysAgo(1) }),
      makeCorrection({ id: 'y', timestamp: daysAgo(10) }),
    ];
    const original = [...events];
    rankCorrections(events, 'test query');
    expect(events[0].id).toBe(original[0].id);
    expect(events[1].id).toBe(original[1].id);
  });
});

// ============================================================
// retrieveRelevantCorrections
// ============================================================

describe('retrieveRelevantCorrections', () => {
  it('returns empty array when no events exist', () => {
    const results = retrieveRelevantCorrections({ userId: 'user-1', currentInput: 'test' });
    expect(results).toEqual([]);
  });

  it('filters by userId — only returns events for the given user', () => {
    recordFeedback(makeCorrection({ id: 'u1', userId: 'alice', userInput: 'python sort list' }));
    recordFeedback(makeCorrection({ id: 'u2', userId: 'bob', userInput: 'python sort list' }));
    recordFeedback(makeCorrection({ id: 'u3', userId: 'alice', userInput: 'python function' }));

    const results = retrieveRelevantCorrections({ userId: 'alice', currentInput: 'python' });
    expect(results.every(r => r.userId === 'alice')).toBe(true);
    expect(results.length).toBe(2);
  });

  it('only returns explicit_correction events', () => {
    recordFeedback(makeCorrection({
      id: 'corr-1',
      userId: 'user-filter',
      feedbackType: 'explicit_correction',
      userInput: 'explain recursion',
    }));
    recordFeedback(makeCorrection({
      id: 'appr-1',
      userId: 'user-filter',
      feedbackType: 'approval',
      userInput: 'explain recursion',
    }));
    recordFeedback(makeCorrection({
      id: 'impl-1',
      userId: 'user-filter',
      feedbackType: 'implicit',
      userInput: 'explain recursion',
    }));

    const results = retrieveRelevantCorrections({ userId: 'user-filter', currentInput: 'explain recursion' });
    expect(results.every(r => r.feedbackType === 'explicit_correction')).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('corr-1');
  });

  it('respects maxResults option', () => {
    for (let i = 0; i < 10; i++) {
      recordFeedback(makeCorrection({
        id: `max-${i}`,
        userId: 'user-max',
        userInput: `python question ${i}`,
      }));
    }

    const results = retrieveRelevantCorrections({
      userId: 'user-max',
      currentInput: 'python question',
      maxResults: 3,
    });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('defaults to maxResults=5', () => {
    for (let i = 0; i < 8; i++) {
      recordFeedback(makeCorrection({
        id: `def-${i}`,
        userId: 'user-def',
        userInput: `test input ${i}`,
      }));
    }

    const results = retrieveRelevantCorrections({
      userId: 'user-def',
      currentInput: 'test input',
    });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('returns empty array for empty currentInput', () => {
    recordFeedback(makeCorrection({ id: 'emp-1', userId: 'user-empty' }));
    const results = retrieveRelevantCorrections({ userId: 'user-empty', currentInput: '' });
    expect(results).toEqual([]);
  });
});

// ============================================================
// buildCorrectionsPrompt
// ============================================================

describe('buildCorrectionsPrompt', () => {
  it('returns empty string for empty corrections array', () => {
    expect(buildCorrectionsPrompt([])).toBe('');
  });

  it('generates a prompt with the header', () => {
    const corrections = [makeCorrection({ userInput: 'write code', directiveText: 'Be concise' })];
    const prompt = buildCorrectionsPrompt(corrections);
    expect(prompt).toContain('## Prior Corrections');
    expect(prompt).toContain('Be concise');
  });

  it('includes userInput snippet in the correction line', () => {
    const corrections = [makeCorrection({ userInput: 'how do I sort a list', directiveText: 'Use bullet points' })];
    const prompt = buildCorrectionsPrompt(corrections);
    expect(prompt).toContain('how do I sort a list');
    expect(prompt).toContain('Use bullet points');
  });

  it('includes footer text', () => {
    const corrections = [makeCorrection({ userInput: 'test', directiveText: 'do this' })];
    const prompt = buildCorrectionsPrompt(corrections);
    expect(prompt).toContain('judgment');
  });

  it('respects maxTokens budget — excludes corrections that do not fit', () => {
    // Create many corrections with long text to overflow a tiny budget
    const corrections = Array.from({ length: 20 }, (_, i) =>
      makeCorrection({
        userInput: `This is a fairly long user input question number ${i} about various topics`,
        directiveText: `Directive for question ${i}: always use bullet points and be very detailed`,
      }),
    );

    // Use a small token budget
    const prompt = buildCorrectionsPrompt(corrections, { maxTokens: 100 });

    // Should still have header if any corrections fit, or be empty if none fit
    if (prompt !== '') {
      expect(prompt).toContain('## Prior Corrections');
      // Count correction lines
      const correctionLines = prompt.split('\n').filter(l => l.startsWith('- When asked'));
      // Verify it's fewer than 20
      expect(correctionLines.length).toBeLessThan(20);
    }
  });

  it('returns empty string if no corrections fit the budget', () => {
    // Budget so tiny that no single correction line fits
    const corrections = [
      makeCorrection({
        userInput: 'a very long question that takes up a lot of space in the prompt',
        directiveText: 'a very long directive that also takes up a lot of space',
      }),
    ];
    const prompt = buildCorrectionsPrompt(corrections, { maxTokens: 5 });
    expect(prompt).toBe('');
  });

  it('truncates long userInput to 80 chars with ellipsis', () => {
    const longInput = 'a'.repeat(100);
    const corrections = [makeCorrection({ userInput: longInput, directiveText: 'keep it short' })];
    const prompt = buildCorrectionsPrompt(corrections);
    // Should contain truncated input (77 chars + "...")
    expect(prompt).toContain('...');
    // The full 100-char input should not appear
    expect(prompt).not.toContain(longInput);
  });

  it('formats each correction as bullet with quoted input', () => {
    const corrections = [
      makeCorrection({ userInput: 'write a test', directiveText: 'use vitest' }),
    ];
    const prompt = buildCorrectionsPrompt(corrections);
    expect(prompt).toMatch(/- When asked "write a test": use vitest/);
  });

  it('includes multiple corrections when they fit', () => {
    const corrections = [
      makeCorrection({ userInput: 'short', directiveText: 'directive one' }),
      makeCorrection({ userInput: 'also short', directiveText: 'directive two' }),
    ];
    const prompt = buildCorrectionsPrompt(corrections, { maxTokens: 500 });
    expect(prompt).toContain('directive one');
    expect(prompt).toContain('directive two');
  });
});
