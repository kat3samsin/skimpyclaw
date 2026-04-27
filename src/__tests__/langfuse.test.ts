import { describe, expect, it } from 'vitest';
import { calculateUsageCost } from '../langfuse.js';

describe('calculateUsageCost', () => {
  it('uses updated OpenAI pricing for gpt-4o', () => {
    const cost = calculateUsageCost('openai/gpt-4o', 1_000_000, 1_000_000);

    expect(cost.inputCost).toBe(2.5);
    expect(cost.outputCost).toBe(10);
    expect(cost.totalCost).toBe(12.5);
  });

  it('uses updated OpenAI pricing for gpt-4o-mini', () => {
    const cost = calculateUsageCost('gpt-4o-mini', 1_000_000, 1_000_000);

    expect(cost.inputCost).toBe(0.15);
    expect(cost.outputCost).toBe(0.6);
    expect(cost.totalCost).toBe(0.75);
  });

  it('resolves codex provider model names', () => {
    const cost = calculateUsageCost('codex/codex-5.3', 1_000_000, 1_000_000);

    expect(cost.inputCost).toBe(1.75);
    expect(cost.outputCost).toBe(14);
    expect(cost.totalCost).toBe(15.75);
  });

  it('resolves codex5.3 alias pricing', () => {
    const cost = calculateUsageCost('codex5.3', 1_000_000, 1_000_000);

    expect(cost.inputCost).toBe(1.75);
    expect(cost.outputCost).toBe(14);
    expect(cost.totalCost).toBe(15.75);
  });

  it('resolves codex5.5 alias pricing', () => {
    const cost = calculateUsageCost('codex5.5', 1_000_000, 1_000_000);

    expect(cost.inputCost).toBe(5);
    expect(cost.outputCost).toBe(30);
    expect(cost.totalCost).toBe(35);
  });

  it('resolves codex5.1 model pricing', () => {
    const cost = calculateUsageCost('codex/gpt-5.1-codex', 1_000_000, 1_000_000);

    expect(cost.inputCost).toBe(1.25);
    expect(cost.outputCost).toBe(10);
    expect(cost.totalCost).toBe(11.25);
  });

  it('resolves minimax alias case correctly', () => {
    const cost = calculateUsageCost('minimax', 1_000_000, 1_000_000);

    expect(cost.inputCost).toBe(0.3);
    expect(cost.outputCost).toBe(1.2);
    expect(cost.totalCost).toBe(1.5);
  });
});
