import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  validateFeedbackEvent,
  buildFeedbackEvent,
  recordFeedback,
  readFeedbackEvents,
  convertSignalsToFeedbackEvent,
  setFeedbackDirForTesting,
} from '../rl-feedback.js';
import type { RLFeedbackEvent, FeedbackSignal } from '../types.js';

const TEST_DIR = join(tmpdir(), `skimpyclaw-rl-feedback-test-${Date.now()}`);

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

function makeValidEvent(overrides: Partial<RLFeedbackEvent> = {}): RLFeedbackEvent {
  return {
    id: 'abc12345',
    sessionId: 'sess-1',
    timestamp: new Date().toISOString(),
    userId: 'user-1',
    agentId: 'main',
    userInput: 'Hello, assistant',
    assistantOutput: 'Hi there!',
    feedbackType: 'implicit',
    directiveText: '',
    evaluativeScore: 0.1,
    tags: [],
    safetyFlags: [],
    ...overrides,
  };
}

// ============================================================
// validateFeedbackEvent
// ============================================================

describe('validateFeedbackEvent', () => {
  it('returns valid for a complete event', () => {
    const result = validateFeedbackEvent(makeValidEvent());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('reports missing id', () => {
    const result = validateFeedbackEvent({ ...makeValidEvent(), id: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('id'))).toBe(true);
  });

  it('reports missing sessionId', () => {
    const result = validateFeedbackEvent({ ...makeValidEvent(), sessionId: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sessionId'))).toBe(true);
  });

  it('reports missing timestamp', () => {
    const result = validateFeedbackEvent({ ...makeValidEvent(), timestamp: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('timestamp'))).toBe(true);
  });

  it('reports missing userId', () => {
    const result = validateFeedbackEvent({ ...makeValidEvent(), userId: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('userId'))).toBe(true);
  });

  it('reports missing agentId', () => {
    const result = validateFeedbackEvent({ ...makeValidEvent(), agentId: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('agentId'))).toBe(true);
  });

  it('reports missing feedbackType', () => {
    const { feedbackType: _, ...rest } = makeValidEvent();
    const result = validateFeedbackEvent(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('feedbackType'))).toBe(true);
  });

  it('reports invalid feedbackType value', () => {
    const result = validateFeedbackEvent({ ...makeValidEvent(), feedbackType: 'unknown' as RLFeedbackEvent['feedbackType'] });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('feedbackType'))).toBe(true);
  });

  it('reports score out of range (too low)', () => {
    const result = validateFeedbackEvent(makeValidEvent({ evaluativeScore: -1.5 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('evaluativeScore'))).toBe(true);
  });

  it('reports score out of range (too high)', () => {
    const result = validateFeedbackEvent(makeValidEvent({ evaluativeScore: 2.0 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('evaluativeScore'))).toBe(true);
  });

  it('allows boundary scores -1 and 1', () => {
    expect(validateFeedbackEvent(makeValidEvent({ evaluativeScore: -1 })).valid).toBe(true);
    expect(validateFeedbackEvent(makeValidEvent({ evaluativeScore: 1 })).valid).toBe(true);
  });

  it('reports missing userInput', () => {
    const { userInput: _, ...rest } = makeValidEvent();
    const result = validateFeedbackEvent(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('userInput'))).toBe(true);
  });

  it('reports missing assistantOutput', () => {
    const { assistantOutput: _, ...rest } = makeValidEvent();
    const result = validateFeedbackEvent(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('assistantOutput'))).toBe(true);
  });
});

// ============================================================
// buildFeedbackEvent
// ============================================================

describe('buildFeedbackEvent', () => {
  it('auto-generates id of length 8', () => {
    const event = buildFeedbackEvent({
      sessionId: 'sess-1',
      userId: 'user-1',
      agentId: 'main',
      userInput: 'test',
      assistantOutput: 'response',
      feedbackType: 'implicit',
      directiveText: '',
      evaluativeScore: 0,
    });
    expect(event.id).toBeDefined();
    expect(event.id).toHaveLength(8);
  });

  it('auto-generates ISO timestamp', () => {
    const before = Date.now();
    const event = buildFeedbackEvent({
      sessionId: 'sess-1',
      userId: 'user-1',
      agentId: 'main',
      userInput: 'test',
      assistantOutput: 'response',
      feedbackType: 'approval',
      directiveText: 'good',
      evaluativeScore: 0.8,
    });
    const after = Date.now();
    const ts = Date.parse(event.timestamp);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('defaults tags and safetyFlags to empty arrays', () => {
    const event = buildFeedbackEvent({
      sessionId: 's',
      userId: 'u',
      agentId: 'a',
      userInput: 'in',
      assistantOutput: 'out',
      feedbackType: 'implicit',
      directiveText: '',
      evaluativeScore: 0,
    });
    expect(event.tags).toEqual([]);
    expect(event.safetyFlags).toEqual([]);
  });

  it('passes through optional fields', () => {
    const event = buildFeedbackEvent({
      sessionId: 's',
      userId: 'u',
      agentId: 'a',
      userInput: 'in',
      assistantOutput: 'out',
      feedbackType: 'explicit_correction',
      directiveText: 'be shorter',
      evaluativeScore: -0.5,
      toolCalls: ['Read', 'Edit'],
      toolResultsSummary: 'Read 2 files',
      tags: ['verbosity:decrease'],
      safetyFlags: [],
      model: 'claude-opus',
      trigger: 'telegram',
    });
    expect(event.toolCalls).toEqual(['Read', 'Edit']);
    expect(event.toolResultsSummary).toBe('Read 2 files');
    expect(event.tags).toEqual(['verbosity:decrease']);
    expect(event.model).toBe('claude-opus');
    expect(event.trigger).toBe('telegram');
  });

  it('produces unique ids on successive calls', () => {
    const opts = {
      sessionId: 's', userId: 'u', agentId: 'a',
      userInput: 'x', assistantOutput: 'y',
      feedbackType: 'implicit' as const,
      directiveText: '', evaluativeScore: 0,
    };
    const ids = new Set(Array.from({ length: 20 }, () => buildFeedbackEvent(opts).id));
    expect(ids.size).toBe(20);
  });
});

// ============================================================
// recordFeedback + readFeedbackEvents
// ============================================================

describe('recordFeedback + readFeedbackEvents', () => {
  it('write/read roundtrip preserves data', () => {
    const event = makeValidEvent({ userId: 'roundtrip', evaluativeScore: 0.5 });
    recordFeedback(event);

    const { events, total } = readFeedbackEvents();
    expect(total).toBe(1);
    expect(events[0].userId).toBe('roundtrip');
    expect(events[0].evaluativeScore).toBe(0.5);
  });

  it('stores multiple events', () => {
    for (let i = 0; i < 5; i++) {
      recordFeedback(makeValidEvent({ id: `id-${i}`, userId: `user-${i}` }));
    }
    const { total } = readFeedbackEvents();
    expect(total).toBe(5);
  });

  it('filters by userId', () => {
    recordFeedback(makeValidEvent({ id: 'e1', userId: 'alice' }));
    recordFeedback(makeValidEvent({ id: 'e2', userId: 'bob' }));
    recordFeedback(makeValidEvent({ id: 'e3', userId: 'alice' }));

    const { events, total } = readFeedbackEvents({ userId: 'alice' });
    expect(total).toBe(2);
    expect(events.every(e => e.userId === 'alice')).toBe(true);
  });

  it('filters by feedbackType', () => {
    recordFeedback(makeValidEvent({ id: 'e1', feedbackType: 'approval' }));
    recordFeedback(makeValidEvent({ id: 'e2', feedbackType: 'explicit_correction' }));
    recordFeedback(makeValidEvent({ id: 'e3', feedbackType: 'approval' }));

    const { events, total } = readFeedbackEvents({ feedbackType: 'approval' });
    expect(total).toBe(2);
    expect(events.every(e => e.feedbackType === 'approval')).toBe(true);
  });

  it('paginates with limit and offset', () => {
    for (let i = 0; i < 10; i++) {
      recordFeedback(makeValidEvent({ id: `ev-${i}` }));
    }
    const { events: page1, total } = readFeedbackEvents({ limit: 3, offset: 0 });
    const { events: page2 } = readFeedbackEvents({ limit: 3, offset: 3 });
    expect(total).toBe(10);
    expect(page1).toHaveLength(3);
    expect(page2).toHaveLength(3);
    // Pages should not overlap
    const ids1 = new Set(page1.map(e => e.id));
    const ids2 = new Set(page2.map(e => e.id));
    const intersection = [...ids1].filter(id => ids2.has(id));
    expect(intersection).toHaveLength(0);
  });

  it('never throws when given a bad event (still records best-effort)', () => {
    // This tests that recordFeedback swallows errors
    // We can test by temporarily breaking the dir
    setFeedbackDirForTesting('/dev/null/impossible-path');
    expect(() => recordFeedback(makeValidEvent())).not.toThrow();
    // Restore for remaining tests
    setFeedbackDirForTesting(TEST_DIR);
  });

  it('creates directory if it does not exist', () => {
    const subDir = join(TEST_DIR, 'subdir', 'nested');
    setFeedbackDirForTesting(subDir);
    recordFeedback(makeValidEvent());
    expect(existsSync(subDir)).toBe(true);
    setFeedbackDirForTesting(TEST_DIR);
  });

  it('returns empty results for no events', () => {
    const { events, total } = readFeedbackEvents();
    expect(events).toHaveLength(0);
    expect(total).toBe(0);
  });
});

// ============================================================
// convertSignalsToFeedbackEvent
// ============================================================

const BASE_OPTS = {
  sessionId: 'sess-convert',
  userId: 'user-convert',
  agentId: 'main',
  userInput: 'make it shorter',
  assistantOutput: 'Here is a long response...',
};

describe('convertSignalsToFeedbackEvent', () => {
  it('returns null for empty signals', () => {
    expect(convertSignalsToFeedbackEvent([], BASE_OPTS)).toBeNull();
  });

  it('maps correction signal to explicit_correction', () => {
    const signals: FeedbackSignal[] = [{
      type: 'correction',
      reward: -0.5,
      dimensions: { verbosity: -0.5 },
      confidence: 0.8,
      reason: 'too verbose',
    }];
    const event = convertSignalsToFeedbackEvent(signals, BASE_OPTS);
    expect(event).not.toBeNull();
    expect(event!.feedbackType).toBe('explicit_correction');
  });

  it('maps reask signal to explicit_correction', () => {
    const signals: FeedbackSignal[] = [{
      type: 'reask',
      reward: -0.3,
      dimensions: {},
      confidence: 0.7,
      reason: 'did not answer',
    }];
    const event = convertSignalsToFeedbackEvent(signals, BASE_OPTS);
    expect(event!.feedbackType).toBe('explicit_correction');
  });

  it('maps acceptance with high confidence to approval', () => {
    const signals: FeedbackSignal[] = [{
      type: 'acceptance',
      reward: 0.6,
      dimensions: {},
      confidence: 0.8,
      reason: 'thanks, perfect',
    }];
    const event = convertSignalsToFeedbackEvent(signals, BASE_OPTS);
    expect(event!.feedbackType).toBe('approval');
  });

  it('maps acceptance with low confidence to implicit', () => {
    const signals: FeedbackSignal[] = [{
      type: 'acceptance',
      reward: 0.1,
      dimensions: {},
      confidence: 0.3,
      reason: 'implicit acceptance',
    }];
    const event = convertSignalsToFeedbackEvent(signals, BASE_OPTS);
    expect(event!.feedbackType).toBe('implicit');
  });

  it('strongest signal wins for feedbackType', () => {
    // Two signals: weak acceptance and strong correction
    const signals: FeedbackSignal[] = [
      { type: 'acceptance', reward: 0.1, dimensions: {}, confidence: 0.2, reason: 'mild ok' },
      { type: 'correction', reward: -0.8, dimensions: { verbosity: -0.8 }, confidence: 0.9, reason: 'too long' },
    ];
    const event = convertSignalsToFeedbackEvent(signals, BASE_OPTS);
    // Correction: |−0.8| * 0.9 = 0.72, acceptance: 0.1 * 0.2 = 0.02 — correction wins
    expect(event!.feedbackType).toBe('explicit_correction');
  });

  it('aggregates evaluativeScore as confidence-weighted average', () => {
    const signals: FeedbackSignal[] = [
      { type: 'correction', reward: -0.8, dimensions: {}, confidence: 0.5, reason: 'a' },
      { type: 'acceptance', reward: 0.2, dimensions: {}, confidence: 0.5, reason: 'b' },
    ];
    // weighted avg = ((-0.8 * 0.5) + (0.2 * 0.5)) / (0.5 + 0.5) = (-0.4 + 0.1) / 1 = -0.3
    const event = convertSignalsToFeedbackEvent(signals, BASE_OPTS);
    expect(event!.evaluativeScore).toBeCloseTo(-0.3);
  });

  it('builds directiveText from all signal reasons', () => {
    const signals: FeedbackSignal[] = [
      { type: 'correction', reward: -0.5, dimensions: {}, confidence: 0.8, reason: 'too long' },
      { type: 'correction', reward: -0.3, dimensions: {}, confidence: 0.6, reason: 'off topic' },
    ];
    const event = convertSignalsToFeedbackEvent(signals, BASE_OPTS);
    expect(event!.directiveText).toContain('too long');
    expect(event!.directiveText).toContain('off topic');
  });

  it('extracts dimension tags like verbosity:decrease', () => {
    const signals: FeedbackSignal[] = [{
      type: 'correction',
      reward: -0.5,
      dimensions: { verbosity: -0.5, formatting: 0.3 },
      confidence: 0.8,
      reason: 'shorter and structured',
    }];
    const event = convertSignalsToFeedbackEvent(signals, BASE_OPTS);
    expect(event!.tags).toContain('verbosity:decrease');
    expect(event!.tags).toContain('formatting:increase');
  });

  it('deduplicates dimension tags', () => {
    const signals: FeedbackSignal[] = [
      { type: 'correction', reward: -0.5, dimensions: { verbosity: -0.5 }, confidence: 0.8, reason: 'a' },
      { type: 'correction', reward: -0.3, dimensions: { verbosity: -0.3 }, confidence: 0.6, reason: 'b' },
    ];
    const event = convertSignalsToFeedbackEvent(signals, BASE_OPTS);
    const verbosityTags = event!.tags.filter(t => t === 'verbosity:decrease');
    expect(verbosityTags).toHaveLength(1);
  });

  it('clamps evaluativeScore to [-1, 1]', () => {
    // Extreme signals that would exceed bounds before clamping
    const signals: FeedbackSignal[] = [
      { type: 'correction', reward: -1, dimensions: {}, confidence: 1, reason: 'worst' },
      { type: 'correction', reward: -1, dimensions: {}, confidence: 1, reason: 'also worst' },
    ];
    const event = convertSignalsToFeedbackEvent(signals, BASE_OPTS);
    expect(event!.evaluativeScore).toBeGreaterThanOrEqual(-1);
    expect(event!.evaluativeScore).toBeLessThanOrEqual(1);
  });

  it('passes through model and trigger', () => {
    const signals: FeedbackSignal[] = [{
      type: 'acceptance',
      reward: 0.5,
      dimensions: {},
      confidence: 0.7,
      reason: 'good',
    }];
    const event = convertSignalsToFeedbackEvent(signals, {
      ...BASE_OPTS,
      model: 'claude-sonnet',
      trigger: 'discord',
    });
    expect(event!.model).toBe('claude-sonnet');
    expect(event!.trigger).toBe('discord');
  });
});
