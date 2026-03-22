import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { heuristicRewardJudge, generatePreferencePairs, exportPreferencePairs } from '../rl-export.js';
import { recordFeedback, setFeedbackDirForTesting } from '../rl-feedback.js';
import type { RLFeedbackEvent } from '../types.js';

const TEST_DIR = join(tmpdir(), `skimpyclaw-rl-export-test-${Date.now()}`);

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

function makeEvent(overrides: Partial<RLFeedbackEvent> = {}): RLFeedbackEvent {
  return {
    id: 'test1234',
    sessionId: 'sess-1',
    timestamp: new Date().toISOString(),
    userId: 'user-1',
    agentId: 'main',
    userInput: 'Make it shorter',
    assistantOutput: 'Here is a very long response...',
    feedbackType: 'explicit_correction',
    directiveText: 'Be concise',
    evaluativeScore: -0.5,
    tags: [],
    safetyFlags: [],
    ...overrides,
  };
}

// ============================================================
// heuristicRewardJudge
// ============================================================

describe('heuristicRewardJudge', () => {
  it('returns negative score for explicit_correction', () => {
    const event = makeEvent({ feedbackType: 'explicit_correction', evaluativeScore: -0.7 });
    const judgment = heuristicRewardJudge(event);
    expect(judgment.score).toBe(-0.7);
    expect(judgment.confidence).toBe(0.8);
    expect(judgment.reason).toContain('explicit_correction');
    expect(judgment.reason).toContain('-0.7');
  });

  it('returns positive score for approval', () => {
    const event = makeEvent({ feedbackType: 'approval', evaluativeScore: 0.8 });
    const judgment = heuristicRewardJudge(event);
    expect(judgment.score).toBe(0.8);
    expect(judgment.confidence).toBe(0.7);
    expect(judgment.reason).toContain('approval');
  });

  it('returns low confidence for implicit feedback', () => {
    const event = makeEvent({ feedbackType: 'implicit', evaluativeScore: 0.1 });
    const judgment = heuristicRewardJudge(event);
    expect(judgment.score).toBe(0.1);
    expect(judgment.confidence).toBe(0.3);
    expect(judgment.reason).toContain('implicit');
  });

  it('includes score in reason string', () => {
    const event = makeEvent({ feedbackType: 'approval', evaluativeScore: 0.5 });
    const judgment = heuristicRewardJudge(event);
    expect(judgment.reason).toBe('Heuristic: approval with score 0.5');
  });
});

// ============================================================
// generatePreferencePairs
// ============================================================

describe('generatePreferencePairs', () => {
  it('generates pairs from explicit_correction events', () => {
    const events = [makeEvent({ feedbackType: 'explicit_correction', directiveText: 'Be concise', assistantOutput: 'Long output' })];
    const pairs = generatePreferencePairs(events);
    expect(pairs).toHaveLength(1);
    const pair = pairs[0];
    expect(pair.chosen).toBe('[Corrected per user feedback] Be concise');
    expect(pair.rejected).toBe('Long output');
    expect(pair.prompt).toBe('Make it shorter');
    expect(pair.id).toHaveLength(8);
    expect(pair.reward_chosen).toBeGreaterThan(0);
    expect(pair.reward_rejected).toBeLessThan(0);
  });

  it('skips approval events (no rejected sample)', () => {
    const events = [makeEvent({ feedbackType: 'approval' })];
    const pairs = generatePreferencePairs(events);
    expect(pairs).toHaveLength(0);
  });

  it('skips implicit events', () => {
    const events = [makeEvent({ feedbackType: 'implicit' })];
    const pairs = generatePreferencePairs(events);
    expect(pairs).toHaveLength(0);
  });

  it('skips events with safety flags (default: contains_secret)', () => {
    const events = [makeEvent({ safetyFlags: ['contains_secret'] })];
    const pairs = generatePreferencePairs(events);
    expect(pairs).toHaveLength(0);
  });

  it('does not skip events with non-excluded safety flags', () => {
    const events = [makeEvent({ safetyFlags: ['some_other_flag'] })];
    const pairs = generatePreferencePairs(events);
    expect(pairs).toHaveLength(1);
  });

  it('skips events with excluded tags', () => {
    const events = [makeEvent({ tags: ['low-quality'] })];
    const pairs = generatePreferencePairs(events, { excludeTags: ['low-quality'] });
    expect(pairs).toHaveLength(0);
  });

  it('does not skip events with non-excluded tags', () => {
    const events = [makeEvent({ tags: ['verbosity:decrease'] })];
    const pairs = generatePreferencePairs(events, { excludeTags: ['low-quality'] });
    expect(pairs).toHaveLength(1);
  });

  it('uses custom reward judge when provided', () => {
    const events = [makeEvent({ evaluativeScore: -0.5 })];
    const customJudge = () => ({ score: -1.0, confidence: 0.9, reason: 'custom' });
    const pairs = generatePreferencePairs(events, { rewardJudge: customJudge });
    expect(pairs[0].reward_chosen).toBe(1.0);
    expect(pairs[0].reward_rejected).toBe(-1.0);
  });

  it('sets reward_chosen = abs(score) and reward_rejected = -abs(score)', () => {
    const events = [makeEvent({ evaluativeScore: -0.6 })];
    const pairs = generatePreferencePairs(events);
    expect(pairs[0].reward_chosen).toBeCloseTo(0.6);
    expect(pairs[0].reward_rejected).toBeCloseTo(-0.6);
  });

  it('includes correct metadata in each pair', () => {
    const ts = new Date().toISOString();
    const events = [makeEvent({
      userId: 'u-test',
      sessionId: 's-test',
      timestamp: ts,
      feedbackType: 'explicit_correction',
      model: 'claude-opus',
    })];
    const pairs = generatePreferencePairs(events);
    expect(pairs[0].metadata.userId).toBe('u-test');
    expect(pairs[0].metadata.sessionId).toBe('s-test');
    expect(pairs[0].metadata.timestamp).toBe(ts);
    expect(pairs[0].metadata.feedbackType).toBe('explicit_correction');
    expect(pairs[0].metadata.model).toBe('claude-opus');
  });

  it('handles mixed events — only corrections produce pairs', () => {
    const events = [
      makeEvent({ id: 'e1', feedbackType: 'explicit_correction' }),
      makeEvent({ id: 'e2', feedbackType: 'approval' }),
      makeEvent({ id: 'e3', feedbackType: 'implicit' }),
      makeEvent({ id: 'e4', feedbackType: 'explicit_correction' }),
    ];
    const pairs = generatePreferencePairs(events);
    expect(pairs).toHaveLength(2);
  });
});

// ============================================================
// exportPreferencePairs
// ============================================================

describe('exportPreferencePairs', () => {
  it('writes JSONL from stored events, only corrections produce pairs', () => {
    const ts = new Date().toISOString();
    recordFeedback(makeEvent({ id: 'r1', feedbackType: 'explicit_correction', timestamp: ts, directiveText: 'Be concise' }));
    recordFeedback(makeEvent({ id: 'r2', feedbackType: 'approval', timestamp: ts }));
    recordFeedback(makeEvent({ id: 'r3', feedbackType: 'implicit', timestamp: ts }));

    const outputPath = join(TEST_DIR, 'export.jsonl');
    const count = exportPreferencePairs({ outputPath });

    expect(count).toBe(1);
    expect(existsSync(outputPath)).toBe(true);

    const lines = readFileSync(outputPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const pair = JSON.parse(lines[0]);
    expect(pair.chosen).toBe('[Corrected per user feedback] Be concise');
    expect(pair.rejected).toBeDefined();
  });

  it('does not create the file when there are no pairs', () => {
    recordFeedback(makeEvent({ id: 'a1', feedbackType: 'approval' }));
    const outputPath = join(TEST_DIR, 'no-output.jsonl');
    const count = exportPreferencePairs({ outputPath });
    expect(count).toBe(0);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('writes multiple pairs as separate JSONL lines with trailing newline', () => {
    const ts = new Date().toISOString();
    recordFeedback(makeEvent({ id: 'p1', feedbackType: 'explicit_correction', timestamp: ts }));
    recordFeedback(makeEvent({ id: 'p2', feedbackType: 'explicit_correction', timestamp: ts }));

    const outputPath = join(TEST_DIR, 'multi.jsonl');
    const count = exportPreferencePairs({ outputPath });

    expect(count).toBe(2);
    const content = readFileSync(outputPath, 'utf-8');
    const lines = content.split('\n');
    // Last element should be empty string due to trailing newline
    expect(lines[lines.length - 1]).toBe('');
    const dataLines = lines.filter(l => l.length > 0);
    expect(dataLines).toHaveLength(2);
    dataLines.forEach(line => {
      const parsed = JSON.parse(line);
      expect(parsed.chosen).toBeDefined();
      expect(parsed.rejected).toBeDefined();
    });
  });

  it('respects excludeSafetyFlags option', () => {
    const ts = new Date().toISOString();
    recordFeedback(makeEvent({ id: 's1', feedbackType: 'explicit_correction', timestamp: ts, safetyFlags: ['contains_secret'] }));
    recordFeedback(makeEvent({ id: 's2', feedbackType: 'explicit_correction', timestamp: ts, safetyFlags: [] }));

    const outputPath = join(TEST_DIR, 'safety.jsonl');
    const count = exportPreferencePairs({ outputPath });
    expect(count).toBe(1);
  });
});
