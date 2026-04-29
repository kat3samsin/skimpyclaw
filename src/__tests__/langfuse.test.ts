import { describe, expect, it } from 'vitest';
import { calculateUsageCost } from '../langfuse.js';

describe('calculateUsageCost', () => {
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
});
