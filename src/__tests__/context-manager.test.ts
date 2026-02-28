import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  compactAnthropicMessages,
  compactCodexMessages,
} from '../providers/context-manager.js';

// Helper: build an Anthropic-style tool exchange (assistant + user pair)
function anthropicExchange(toolResult: string) {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Using a tool.' },
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: toolResult }],
    },
  ];
}

// Helper: build a Codex-style function call exchange
function codexExchange(output: string) {
  return [
    { type: 'function_call', call_id: 'fc_1', name: 'Bash', arguments: '{}' },
    { type: 'function_call_output', call_id: 'fc_1', output },
  ];
}

describe('estimateTokens', () => {
  it('returns a positive number for non-empty data', () => {
    expect(estimateTokens([{ role: 'user', content: 'hello' }])).toBeGreaterThan(0);
  });

  it('returns a small number for empty array', () => {
    expect(estimateTokens([])).toBeLessThan(5);
  });

  it('grows with more content', () => {
    const small = estimateTokens([{ content: 'hi' }]);
    const large = estimateTokens([{ content: 'x'.repeat(10_000) }]);
    expect(large).toBeGreaterThan(small);
  });
});

describe('compactAnthropicMessages', () => {
  it('passes through unchanged when under threshold', () => {
    const messages = anthropicExchange('short result');
    const result = compactAnthropicMessages(messages, { maxContextTokens: 100_000 });
    expect(result).toEqual(messages);
  });

  it('returns same reference when no compaction needed', () => {
    const messages = anthropicExchange('short result');
    const result = compactAnthropicMessages(messages, { maxContextTokens: 100_000 });
    expect(result).toBe(messages);
  });

  it('truncates old tool_result content when over threshold', () => {
    const longResult = 'x'.repeat(10_000);
    // Build many exchanges to exceed threshold
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...anthropicExchange(longResult));
    }

    const result = compactAnthropicMessages(messages, { maxContextTokens: 1_000 });

    // Head messages should have truncated tool results
    const headMessages = result.slice(0, -8);
    const toolResultMessages = headMessages.filter(
      m => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'),
    );
    for (const msg of toolResultMessages) {
      const block = msg.content.find((b: any) => b.type === 'tool_result');
      expect(block.content).toContain('[truncated]');
      expect(block.content.length).toBeLessThan(longResult.length);
    }
  });

  it('keeps last 8 messages intact when compacting', () => {
    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...anthropicExchange(longResult));
    }

    const result = compactAnthropicMessages(messages, { maxContextTokens: 1_000 });

    // Last 8 messages should be untouched
    const tail = result.slice(-8);
    const originalTail = messages.slice(-8);
    expect(tail).toEqual(originalTail);
  });

  it('does not mutate the input array', () => {
    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...anthropicExchange(longResult));
    }
    const originalJson = JSON.stringify(messages);

    compactAnthropicMessages(messages, { maxContextTokens: 1_000 });

    expect(JSON.stringify(messages)).toBe(originalJson);
  });

  it('preserves non-tool_result blocks unchanged', () => {
    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...anthropicExchange(longResult));
    }

    const result = compactAnthropicMessages(messages, { maxContextTokens: 1_000 });

    // Assistant messages (tool_use blocks) should be untouched
    const assistantMessages = result.filter(m => m.role === 'assistant');
    for (const msg of assistantMessages) {
      const toolUse = msg.content.find((b: any) => b.type === 'tool_use');
      expect(toolUse).toBeDefined();
      expect(toolUse.name).toBe('Bash');
    }
  });

  it('passes through unchanged when disabled', () => {
    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...anthropicExchange(longResult));
    }

    const result = compactAnthropicMessages(messages, { enabled: false, maxContextTokens: 1 });
    expect(result).toBe(messages);
  });
});

describe('compactCodexMessages', () => {
  it('passes through unchanged when under threshold', () => {
    const items = codexExchange('short result');
    const result = compactCodexMessages(items, { maxContextTokens: 100_000 });
    expect(result).toEqual(items);
  });

  it('truncates old function_call_output when over threshold', () => {
    const longOutput = 'x'.repeat(10_000);
    const items: any[] = [];
    for (let i = 0; i < 30; i++) {
      items.push(...codexExchange(longOutput));
    }

    const result = compactCodexMessages(items, { maxContextTokens: 1_000 });

    const headItems = result.slice(0, -8);
    const outputItems = headItems.filter((item: any) => item.type === 'function_call_output');
    for (const item of outputItems) {
      expect(item.output).toContain('[truncated]');
      expect(item.output.length).toBeLessThan(longOutput.length);
    }
  });

  it('keeps last 8 items intact when compacting', () => {
    const longOutput = 'x'.repeat(10_000);
    const items: any[] = [];
    for (let i = 0; i < 30; i++) {
      items.push(...codexExchange(longOutput));
    }

    const result = compactCodexMessages(items, { maxContextTokens: 1_000 });

    const tail = result.slice(-8);
    const originalTail = items.slice(-8);
    expect(tail).toEqual(originalTail);
  });

  it('does not mutate the input array', () => {
    const longOutput = 'x'.repeat(10_000);
    const items: any[] = [];
    for (let i = 0; i < 30; i++) {
      items.push(...codexExchange(longOutput));
    }
    const originalJson = JSON.stringify(items);

    compactCodexMessages(items, { maxContextTokens: 1_000 });

    expect(JSON.stringify(items)).toBe(originalJson);
  });

  it('preserves function_call items (not just outputs) unchanged', () => {
    const longOutput = 'x'.repeat(10_000);
    const items: any[] = [];
    for (let i = 0; i < 30; i++) {
      items.push(...codexExchange(longOutput));
    }

    const result = compactCodexMessages(items, { maxContextTokens: 1_000 });

    const callItems = result.filter((item: any) => item.type === 'function_call');
    for (const item of callItems) {
      expect(item.name).toBe('Bash');
    }
  });

  it('passes through unchanged when disabled', () => {
    const longOutput = 'x'.repeat(10_000);
    const items: any[] = [];
    for (let i = 0; i < 30; i++) {
      items.push(...codexExchange(longOutput));
    }

    const result = compactCodexMessages(items, { enabled: false, maxContextTokens: 1 });
    expect(result).toBe(items);
  });
});
