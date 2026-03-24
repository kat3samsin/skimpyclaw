import { describe, it, expect } from 'vitest';
import { detectFeedbackSignals } from '../rl-signals.js';
import type { ChatMessage } from '../types.js';

const assistantHistory: ChatMessage[] = [
  { role: 'assistant', content: 'Here is your answer.' },
];

describe('detectFeedbackSignals', () => {
  // --- Corrections ---

  it('detects explicit "no that is wrong" correction', () => {
    const signals = detectFeedbackSignals('No, that is wrong.', assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('correction');
    expect(signals[0].reward).toBeLessThan(0);
    expect(signals[0].confidence).toBeGreaterThan(0.5);
  });

  it('detects "that\'s incorrect" correction', () => {
    const signals = detectFeedbackSignals("That's incorrect, the port is 8080.", assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('correction');
  });

  it('detects "you\'re wrong" correction', () => {
    const signals = detectFeedbackSignals("You're wrong about the timeout.", assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('correction');
  });

  it('detects "I already said" re-ask', () => {
    const signals = detectFeedbackSignals('I already said to use port 3000.', assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('correction');
    expect(signals[0].reason).toContain('re-stated');
  });

  it('detects "that\'s not what I wanted" correction', () => {
    const signals = detectFeedbackSignals("That's not what I wanted.", assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('correction');
  });

  it('detects "don\'t use" directive', () => {
    const signals = detectFeedbackSignals("Don't use that library.", assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('correction');
  });

  it('detects "stop doing" directive', () => {
    const signals = detectFeedbackSignals('Stop adding comments to the code.', assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('correction');
  });

  it('detects "instead use" redirection', () => {
    const signals = detectFeedbackSignals('Instead, use the fetch API.', assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('correction');
  });

  it('detects "please fix" request', () => {
    const signals = detectFeedbackSignals('Please fix the indentation.', assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('correction');
  });

  it('detects verbosity correction and sets dimension', () => {
    const signals = detectFeedbackSignals('Too verbose, keep it short.', assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('correction');
    expect(signals[0].dimensions).toHaveProperty('verbosity');
  });

  // --- Approvals ---

  it('detects "perfect" approval', () => {
    const signals = detectFeedbackSignals('Perfect, that works.', assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('acceptance');
    expect(signals[0].reward).toBeGreaterThan(0);
  });

  it('detects "that\'s exactly what I wanted" approval', () => {
    const signals = detectFeedbackSignals("That's exactly what I wanted.", assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('acceptance');
    expect(signals[0].confidence).toBeGreaterThanOrEqual(0.7);
  });

  // --- Reask ---

  it('detects "can you redo" as reask', () => {
    const signals = detectFeedbackSignals('Can you actually redo that?', assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('reask');
    expect(signals[0].reward).toBeLessThan(0);
  });

  it('detects "let me rephrase" as reask', () => {
    const signals = detectFeedbackSignals('Let me rephrase that.', assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('reask');
  });

  it('detects "what I actually want is" as reask', () => {
    const signals = detectFeedbackSignals('What I actually want is a simple function.', assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('reask');
  });

  // --- Approval false-positive filtering ---

  it('does not match "good" in a long message', () => {
    const signals = detectFeedbackSignals(
      "That's a good start, but I think we should also handle the edge case where the input is null.",
      assistantHistory,
    );
    expect(signals).toHaveLength(0);
  });

  it('matches "perfect" in a short message', () => {
    const signals = detectFeedbackSignals('Perfect.', assistantHistory);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('acceptance');
  });

  // --- No signal cases ---

  it('returns empty for neutral follow-up', () => {
    const signals = detectFeedbackSignals('Now add a test for the edge case.', assistantHistory);
    expect(signals).toHaveLength(0);
  });

  it('returns empty for empty message', () => {
    const signals = detectFeedbackSignals('', assistantHistory);
    expect(signals).toHaveLength(0);
  });

  it('returns empty without assistant history', () => {
    const signals = detectFeedbackSignals('No, that is wrong.', []);
    expect(signals).toHaveLength(0);
  });

  it('returns empty without any history', () => {
    const signals = detectFeedbackSignals('No, that is wrong.');
    expect(signals).toHaveLength(0);
  });

  it('returns empty for plain question', () => {
    const signals = detectFeedbackSignals('What does this function return?', assistantHistory);
    expect(signals).toHaveLength(0);
  });

  // --- Only one signal per message ---

  it('returns at most one signal per message', () => {
    // This message matches multiple correction patterns
    const signals = detectFeedbackSignals(
      "No that's wrong, I already said to stop using that, please fix it.",
      assistantHistory,
    );
    expect(signals).toHaveLength(1);
  });

  // --- Dimension inference ---

  it('infers directness dimension from "be more direct"', () => {
    const signals = detectFeedbackSignals("Too diplomatic, please fix the tone.", assistantHistory);
    expect(signals).toHaveLength(1);
    // The correction pattern matches "please fix"
    // And "diplomatic" triggers directness: -1 in dimensions
    expect(signals[0].dimensions).toHaveProperty('directness', -1);
  });
});
