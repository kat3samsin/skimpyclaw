import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  estimateTokens,
  compactAnthropicMessages,
  compactOpenAIMessages,
  compactCodexMessages,
  serializeAnthropicMessages,
  serializeOpenAIMessages,
  serializeCodexMessages,
} from '../providers/context-manager.js';

// Mock the chat function used for LLM summarization
vi.mock('../providers/index.js', () => ({
  chat: vi.fn().mockResolvedValue('Summary of the conversation: the user asked to list files and the assistant ran ls.'),
}));

import { chat } from '../providers/index.js';
const mockChat = vi.mocked(chat);

// Minimal config for LLM compaction
const fullConfig: any = {
  models: {
    providers: { anthropic: { apiKey: 'test' } },
    aliases: {},
  },
};

beforeEach(() => {
  mockChat.mockClear();
  mockChat.mockResolvedValue('Summary of the conversation: the user asked to list files and the assistant ran ls.');
});

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

// Helper: build an OpenAI-style tool exchange (assistant + tool result)
function openaiExchange(toolResult: string) {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'Bash', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'tc_1', content: toolResult },
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
  it('passes through unchanged when under threshold', async () => {
    const messages = anthropicExchange('short result');
    const result = await compactAnthropicMessages(messages, { maxContextTokens: 100_000 });
    expect(result.messages).toEqual(messages);
    expect(result.compacted).toBe(false);
  });

  it('returns same reference when no compaction needed', async () => {
    const messages = anthropicExchange('short result');
    const result = await compactAnthropicMessages(messages, { maxContextTokens: 100_000 });
    expect(result.messages).toBe(messages);
  });

  it('uses LLM summarization when fullConfig is provided', async () => {
    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...anthropicExchange(longResult));
    }

    const result = await compactAnthropicMessages(messages, { maxContextTokens: 1_000 }, 1, fullConfig);

    expect(result.compacted).toBe(true);
    expect(result.method).toBe('llm');
    expect(result.summary).toBeTruthy();
    expect(result.tokensBefore).toBeGreaterThan(0);
    expect(result.tokensAfter).toBeGreaterThan(0);
    expect(result.tokensAfter!).toBeLessThan(result.tokensBefore!);
    expect(mockChat).toHaveBeenCalledOnce();

    // First message should be the summary
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content[0].text).toContain('[Conversation Summary]');

    // Last 8 should be preserved
    expect(result.messages.slice(-8)).toEqual(messages.slice(-8));
  });

  it('falls back to truncation when LLM fails', async () => {
    mockChat.mockRejectedValueOnce(new Error('API error'));

    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...anthropicExchange(longResult));
    }

    const result = await compactAnthropicMessages(messages, { maxContextTokens: 1_000 }, 1, fullConfig);

    expect(result.compacted).toBe(true);
    expect(result.method).toBe('truncation');

    // Head messages should have truncated tool results
    const headMessages = result.messages.slice(0, -8);
    const toolResultMessages = headMessages.filter(
      (m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'),
    );
    for (const msg of toolResultMessages) {
      const block = msg.content.find((b: any) => b.type === 'tool_result');
      expect(block.content).toContain('[truncated]');
      expect(block.content.length).toBeLessThan(longResult.length);
    }
  });

  it('falls back to truncation without fullConfig', async () => {
    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...anthropicExchange(longResult));
    }

    const result = await compactAnthropicMessages(messages, { maxContextTokens: 1_000 });

    expect(result.compacted).toBe(true);
    expect(result.method).toBe('truncation');
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('keeps last 8 messages intact when compacting', async () => {
    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...anthropicExchange(longResult));
    }

    const result = await compactAnthropicMessages(messages, { maxContextTokens: 1_000 }, 1, fullConfig);

    // Last 8 messages should be untouched
    const tail = result.messages.slice(-8);
    const originalTail = messages.slice(-8);
    expect(tail).toEqual(originalTail);
  });

  it('does not mutate the input array', async () => {
    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...anthropicExchange(longResult));
    }
    const originalJson = JSON.stringify(messages);

    await compactAnthropicMessages(messages, { maxContextTokens: 1_000 }, 1, fullConfig);

    expect(JSON.stringify(messages)).toBe(originalJson);
  });

  it('passes through unchanged when disabled', async () => {
    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...anthropicExchange(longResult));
    }

    const result = await compactAnthropicMessages(messages, { enabled: false, maxContextTokens: 1 });
    expect(result.messages).toBe(messages);
    expect(result.compacted).toBe(false);
  });

  it('includes token counts in result', async () => {
    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...anthropicExchange(longResult));
    }

    const result = await compactAnthropicMessages(messages, { maxContextTokens: 1_000 }, 1, fullConfig);
    expect(result.tokensBefore).toBeGreaterThan(1_000);
    expect(result.tokensAfter).toBeDefined();
  });
});

describe('compactOpenAIMessages', () => {
  it('passes through unchanged when under threshold', async () => {
    const messages = openaiExchange('short result');
    const result = await compactOpenAIMessages(messages, { maxContextTokens: 100_000 });
    expect(result.messages).toBe(messages);
    expect(result.compacted).toBe(false);
  });

  it('uses LLM summarization when fullConfig is provided', async () => {
    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...openaiExchange(longResult));
    }

    const result = await compactOpenAIMessages(messages, { maxContextTokens: 1_000 }, 1, fullConfig);

    expect(result.compacted).toBe(true);
    expect(result.method).toBe('llm');
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toContain('[Conversation Summary]');
  });

  it('falls back to truncation when LLM fails', async () => {
    mockChat.mockRejectedValueOnce(new Error('API error'));

    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...openaiExchange(longResult));
    }

    const result = await compactOpenAIMessages(messages, { maxContextTokens: 1_000 }, 1, fullConfig);
    expect(result.method).toBe('truncation');

    const headItems = result.messages.slice(0, -8);
    const toolMessages = headItems.filter((m: any) => m.role === 'tool');
    for (const msg of toolMessages) {
      expect(msg.content).toContain('[truncated]');
    }
  });

  it('keeps last 8 messages intact', async () => {
    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...openaiExchange(longResult));
    }

    const result = await compactOpenAIMessages(messages, { maxContextTokens: 1_000 }, 1, fullConfig);
    expect(result.messages.slice(-8)).toEqual(messages.slice(-8));
  });

  it('does not mutate the input array', async () => {
    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...openaiExchange(longResult));
    }
    const original = JSON.stringify(messages);
    await compactOpenAIMessages(messages, { maxContextTokens: 1_000 }, 1, fullConfig);
    expect(JSON.stringify(messages)).toBe(original);
  });

  it('passes through unchanged when disabled', async () => {
    const longResult = 'x'.repeat(10_000);
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...openaiExchange(longResult));
    }
    const result = await compactOpenAIMessages(messages, { enabled: false, maxContextTokens: 1 });
    expect(result.messages).toBe(messages);
    expect(result.compacted).toBe(false);
  });
});

describe('compactCodexMessages', () => {
  it('passes through unchanged when under threshold', async () => {
    const items = codexExchange('short result');
    const result = await compactCodexMessages(items, { maxContextTokens: 100_000 });
    expect(result.messages).toEqual(items);
    expect(result.compacted).toBe(false);
  });

  it('uses LLM summarization when fullConfig is provided', async () => {
    const longOutput = 'x'.repeat(10_000);
    const items: any[] = [];
    for (let i = 0; i < 30; i++) {
      items.push(...codexExchange(longOutput));
    }

    const result = await compactCodexMessages(items, { maxContextTokens: 1_000 }, 1, fullConfig);

    expect(result.compacted).toBe(true);
    expect(result.method).toBe('llm');
    expect(result.messages[0].type).toBe('message');
    expect(result.messages[0].content).toContain('[Conversation Summary]');
  });

  it('falls back to truncation when LLM fails', async () => {
    mockChat.mockRejectedValueOnce(new Error('API error'));

    const longOutput = 'x'.repeat(10_000);
    const items: any[] = [];
    for (let i = 0; i < 30; i++) {
      items.push(...codexExchange(longOutput));
    }

    const result = await compactCodexMessages(items, { maxContextTokens: 1_000 }, 1, fullConfig);
    expect(result.method).toBe('truncation');

    const headItems = result.messages.slice(0, -8);
    const outputItems = headItems.filter((item: any) => item.type === 'function_call_output');
    for (const item of outputItems) {
      expect(item.output).toContain('[truncated]');
    }
  });

  it('keeps last 8 items intact when compacting', async () => {
    const longOutput = 'x'.repeat(10_000);
    const items: any[] = [];
    for (let i = 0; i < 30; i++) {
      items.push(...codexExchange(longOutput));
    }

    const result = await compactCodexMessages(items, { maxContextTokens: 1_000 }, 1, fullConfig);
    expect(result.messages.slice(-8)).toEqual(items.slice(-8));
  });

  it('does not mutate the input array', async () => {
    const longOutput = 'x'.repeat(10_000);
    const items: any[] = [];
    for (let i = 0; i < 30; i++) {
      items.push(...codexExchange(longOutput));
    }
    const originalJson = JSON.stringify(items);
    await compactCodexMessages(items, { maxContextTokens: 1_000 }, 1, fullConfig);
    expect(JSON.stringify(items)).toBe(originalJson);
  });

  it('preserves function_call items unchanged', async () => {
    mockChat.mockRejectedValueOnce(new Error('fail')); // force truncation
    const longOutput = 'x'.repeat(10_000);
    const items: any[] = [];
    for (let i = 0; i < 30; i++) {
      items.push(...codexExchange(longOutput));
    }

    const result = await compactCodexMessages(items, { maxContextTokens: 1_000 }, 1, fullConfig);
    const callItems = result.messages.filter((item: any) => item.type === 'function_call');
    for (const item of callItems) {
      expect(item.name).toBe('Bash');
    }
  });

  it('passes through unchanged when disabled', async () => {
    const longOutput = 'x'.repeat(10_000);
    const items: any[] = [];
    for (let i = 0; i < 30; i++) {
      items.push(...codexExchange(longOutput));
    }
    const result = await compactCodexMessages(items, { enabled: false, maxContextTokens: 1 });
    expect(result.messages).toBe(items);
    expect(result.compacted).toBe(false);
  });
});

describe('serializers', () => {
  it('serializeAnthropicMessages produces readable transcript', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'List files' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file1.ts\nfile2.ts' }] },
    ];
    const transcript = serializeAnthropicMessages(messages);
    expect(transcript).toContain('[User]: List files');
    expect(transcript).toContain('[Assistant]: Let me check.');
    expect(transcript).toContain('[Assistant Tool Call: Bash]');
    expect(transcript).toContain('[Tool Result]: file1.ts');
  });

  it('serializeOpenAIMessages produces readable transcript', () => {
    const messages = [
      { role: 'user', content: 'List files' },
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }],
      },
      { role: 'tool', tool_call_id: 'tc_1', content: 'file1.ts\nfile2.ts' },
    ];
    const transcript = serializeOpenAIMessages(messages);
    expect(transcript).toContain('[User]: List files');
    expect(transcript).toContain('[Assistant]: Let me check.');
    expect(transcript).toContain('[Assistant Tool Call: Bash]');
    expect(transcript).toContain('[Tool Result (tc_1)]: file1.ts');
  });

  it('serializeCodexMessages produces readable transcript', () => {
    const items = [
      { type: 'message', role: 'user', content: 'List files' },
      { type: 'function_call', call_id: 'fc_1', name: 'Bash', arguments: '{"command":"ls"}' },
      { type: 'function_call_output', call_id: 'fc_1', output: 'file1.ts\nfile2.ts' },
    ];
    const transcript = serializeCodexMessages(items);
    expect(transcript).toContain('[User]: List files');
    expect(transcript).toContain('[Assistant Tool Call: Bash]');
    expect(transcript).toContain('[Tool Result]: file1.ts');
  });

  it('truncates long tool inputs and results in serialization', () => {
    const longContent = 'x'.repeat(2000);
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'ReadFile', input: longContent },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: longContent }] },
    ];
    const transcript = serializeAnthropicMessages(messages);
    // Tool input should be truncated to ~500 + ...
    expect(transcript).toContain('...');
    // Tool result should be truncated to ~1000 + ...
    const lines = transcript.split('\n');
    for (const line of lines) {
      expect(line.length).toBeLessThan(2500);
    }
  });
});
