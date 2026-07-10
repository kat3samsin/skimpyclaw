import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  estimateTokens,
  compactMessages,
  compactAnthropicMessages,
  compactOpenAIMessages,
  compactCodexMessages,
  anthropicFormatHelper,
  openaiFormatHelper,
  codexFormatHelper,
  repairCodexFunctionCallOutputs,
  serializeAnthropicMessages,
  serializeOpenAIMessages,
  serializeCodexMessages,
  resetCompactionState,
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
  resetCompactionState();
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

// Helper: build many items for compaction tests
function manyItems<T>(factory: (content: string) => T[], content: string, count = 30): T[] {
  const items: T[] = [];
  for (let i = 0; i < count; i++) {
    items.push(...factory(content));
  }
  return items;
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

// =====================================================================
// MessageFormatHelper unit tests
// =====================================================================

describe('anthropicFormatHelper', () => {
  it('isToolResult returns true for tool_result content blocks', () => {
    const msg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'result' }] };
    expect(anthropicFormatHelper.isToolResult(msg)).toBe(true);
  });

  it('isToolResult returns false for text messages', () => {
    const msg = { role: 'user', content: [{ type: 'text', text: 'hello' }] };
    expect(anthropicFormatHelper.isToolResult(msg)).toBe(false);
  });

  it('isToolResult returns false for string content', () => {
    expect(anthropicFormatHelper.isToolResult({ role: 'user', content: 'hi' })).toBe(false);
  });

  it('truncateToolResult truncates long tool_result content', () => {
    const msg = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'x'.repeat(1000) }],
    };
    const truncated = anthropicFormatHelper.truncateToolResult(msg, 100);
    expect(truncated.content[0].content).toContain('[truncated]');
    expect(truncated.content[0].content.length).toBeLessThan(200);
  });

  it('truncateToolResult leaves short content unchanged', () => {
    const msg = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'short' }],
    };
    const result = anthropicFormatHelper.truncateToolResult(msg, 500);
    expect(result).toBe(msg); // same reference (no change)
  });

  it('buildSummaryMessage returns Anthropic-format summary', () => {
    const summary = anthropicFormatHelper.buildSummaryMessage('test summary');
    expect(summary.role).toBe('user');
    expect(summary.content[0].type).toBe('text');
    expect(summary.content[0].text).toContain('[Conversation Summary]');
    expect(summary.content[0].text).toContain('test summary');
  });
});

describe('openaiFormatHelper', () => {
  it('isToolResult returns true for tool role messages', () => {
    expect(openaiFormatHelper.isToolResult({ role: 'tool', content: 'result' })).toBe(true);
  });

  it('isToolResult returns false for non-tool messages', () => {
    expect(openaiFormatHelper.isToolResult({ role: 'assistant', content: 'hi' })).toBe(false);
  });

  it('truncateToolResult truncates long content', () => {
    const msg = { role: 'tool', tool_call_id: 'tc_1', content: 'x'.repeat(1000) };
    const truncated = openaiFormatHelper.truncateToolResult(msg, 100);
    expect(truncated.content).toContain('[truncated]');
    expect(truncated.content.length).toBeLessThan(200);
  });

  it('truncateToolResult leaves short content unchanged', () => {
    const msg = { role: 'tool', tool_call_id: 'tc_1', content: 'short' };
    const result = openaiFormatHelper.truncateToolResult(msg, 500);
    expect(result).toBe(msg);
  });

  it('buildSummaryMessage returns OpenAI-format summary', () => {
    const summary = openaiFormatHelper.buildSummaryMessage('test summary');
    expect(summary.role).toBe('user');
    expect(summary.content).toContain('[Conversation Summary]');
    expect(summary.content).toContain('test summary');
  });
});

describe('codexFormatHelper', () => {
  it('isToolResult returns true for function_call_output items', () => {
    expect(codexFormatHelper.isToolResult({ type: 'function_call_output', output: 'result' })).toBe(true);
  });

  it('isToolResult returns false for function_call items', () => {
    expect(codexFormatHelper.isToolResult({ type: 'function_call', name: 'Bash' })).toBe(false);
  });

  it('isToolResult returns false for message items', () => {
    expect(codexFormatHelper.isToolResult({ type: 'message', role: 'user' })).toBe(false);
  });

  it('truncateToolResult truncates long output', () => {
    const item = { type: 'function_call_output', call_id: 'fc_1', output: 'x'.repeat(1000) };
    const truncated = codexFormatHelper.truncateToolResult(item, 100);
    expect(truncated.output).toContain('[truncated]');
    expect(truncated.output.length).toBeLessThan(200);
  });

  it('truncateToolResult leaves short output unchanged', () => {
    const item = { type: 'function_call_output', call_id: 'fc_1', output: 'short' };
    const result = codexFormatHelper.truncateToolResult(item, 500);
    expect(result).toBe(item);
  });

  it('buildSummaryMessage returns Codex-format summary', () => {
    const summary = codexFormatHelper.buildSummaryMessage('test summary');
    expect(summary.type).toBe('message');
    expect(summary.role).toBe('user');
    expect(summary.content).toContain('[Conversation Summary]');
    expect(summary.content).toContain('test summary');
  });
});

// =====================================================================
// Generic compactMessages() tests
// =====================================================================

describe('compactMessages (generic)', () => {
  it('passes through when under threshold', async () => {
    const messages = anthropicExchange('short result');
    const result = await compactMessages(messages, anthropicFormatHelper, { maxContextTokens: 100_000 });
    expect(result.messages).toBe(messages);
    expect(result.compacted).toBe(false);
  });

  it('passes through when disabled', async () => {
    const messages = manyItems(anthropicExchange, 'x'.repeat(10_000));
    const result = await compactMessages(messages, anthropicFormatHelper, { enabled: false, maxContextTokens: 1 });
    expect(result.messages).toBe(messages);
    expect(result.compacted).toBe(false);
  });

  it('uses LLM summarization with Anthropic helper', async () => {
    const messages = manyItems(anthropicExchange, 'x'.repeat(10_000));
    const result = await compactMessages(
      messages,
      anthropicFormatHelper,
      { maxContextTokens: 20_000 },
      1,
      fullConfig,
      undefined,
      { trigger: 'cron', agentId: 'mayora' },
    );

    expect(result.compacted).toBe(true);
    expect(result.method).toBe('llm');
    expect(result.summary).toBeTruthy();
    expect(result.tokensBefore).toBeGreaterThan(0);
    expect(result.tokensAfter).toBeGreaterThan(0);
    expect(result.tokensAfter!).toBeLessThan(result.tokensBefore!);
    expect(mockChat).toHaveBeenCalledOnce();
    expect(mockChat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ trigger: 'cron', agentId: 'mayora' }),
      fullConfig,
    );

    // First message should be the summary in Anthropic format
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content[0].text).toContain('[Conversation Summary]');

    // Last 8 should be preserved
    expect(result.messages.slice(-8)).toEqual(messages.slice(-8));
  });

  it('uses truncation after an already compacted context is still oversized', async () => {
    const messages = manyItems(anthropicExchange, 'x'.repeat(10_000));
    const first = await compactMessages(messages, anthropicFormatHelper, { maxContextTokens: 20_000 }, 1, fullConfig);
    expect(first.method).toBe('llm');
    first.messages.push({
      role: 'user',
      content: [{ type: 'text', text: `new oversized context ${'x'.repeat(100_000)}` }],
    });
    const tokensBeforeSecond = estimateTokens(first.messages);

    mockChat.mockClear();
    const second = await compactMessages(first.messages, anthropicFormatHelper, { maxContextTokens: 20_000 }, 2, fullConfig);

    expect(second.method).toBe('truncation');
    expect(mockChat).not.toHaveBeenCalled();
    expect(second.tokensAfter!).toBeLessThan(tokensBeforeSecond);
    expect(second.tokensAfter).toBeLessThanOrEqual(20_000);
    expect(JSON.stringify(second.messages)).toContain('new oversized context');
    expect(JSON.stringify(second.messages)).toContain('truncated for context limit');
  });

  it('uses LLM summarization with OpenAI helper', async () => {
    const messages = manyItems(openaiExchange, 'x'.repeat(10_000));
    const result = await compactMessages(messages, openaiFormatHelper, { maxContextTokens: 20_000 }, 1, fullConfig);

    expect(result.compacted).toBe(true);
    expect(result.method).toBe('llm');
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toContain('[Conversation Summary]');
  });

  it('preserves the newest request ahead of an oversized LLM summary', async () => {
    const newest = `LATEST request ${'y'.repeat(180)}`;
    const messages = [
      ...Array.from({ length: 12 }, (_, index) => ({
        role: 'user',
        content: `old ${index} ${'x'.repeat(2_000)}`,
      })),
      { role: 'user', content: newest },
    ];
    mockChat.mockResolvedValueOnce('S'.repeat(200));

    const result = await compactMessages(
      messages,
      openaiFormatHelper,
      { maxContextTokens: 100 },
      1,
      fullConfig,
    );

    expect(result.method).toBe('llm');
    expect(result.tokensAfter).toBeLessThanOrEqual(100);
    expect(result.messages.at(-1)).toEqual({ role: 'user', content: newest });
    expect(result.messages[0].content).toContain('[Conversation Summary]');
    expect(result.messages[0].content).toContain('truncated for context limit');
  });

  it('uses LLM summarization with Codex helper', async () => {
    const messages = manyItems(codexExchange, 'x'.repeat(10_000));
    const result = await compactMessages(messages, codexFormatHelper, { maxContextTokens: 20_000 }, 1, fullConfig);

    expect(result.compacted).toBe(true);
    expect(result.method).toBe('llm');
    expect(result.messages[0].type).toBe('message');
    expect(result.messages[0].content).toContain('[Conversation Summary]');
  });

  it('falls back to truncation when LLM fails (Anthropic)', async () => {
    mockChat.mockRejectedValueOnce(new Error('API error'));
    const messages = manyItems(anthropicExchange, 'x'.repeat(10_000));
    const result = await compactMessages(messages, anthropicFormatHelper, { maxContextTokens: 1_000 }, 1, fullConfig);

    expect(result.compacted).toBe(true);
    expect(result.method).toBe('truncation');

    const headMessages = result.messages.slice(0, -8);
    const toolResultMessages = headMessages.filter(
      (m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'),
    );
    for (const msg of toolResultMessages) {
      const block = msg.content.find((b: any) => b.type === 'tool_result');
      expect(block.content).toContain('[truncated]');
    }
  });

  it('falls back to truncation when LLM fails (OpenAI)', async () => {
    mockChat.mockRejectedValueOnce(new Error('API error'));
    const messages = manyItems(openaiExchange, 'x'.repeat(10_000));
    const result = await compactMessages(messages, openaiFormatHelper, { maxContextTokens: 1_000 }, 1, fullConfig);

    expect(result.method).toBe('truncation');
    const toolMessages = result.messages.slice(0, -8).filter((m: any) => m.role === 'tool');
    for (const msg of toolMessages) {
      expect(msg.content).toContain('[truncated]');
    }
  });

  it('falls back to truncation when LLM fails (Codex)', async () => {
    mockChat.mockRejectedValueOnce(new Error('API error'));
    const messages = manyItems(codexExchange, 'x'.repeat(10_000));
    const result = await compactMessages(messages, codexFormatHelper, { maxContextTokens: 1_000 }, 1, fullConfig);

    expect(result.method).toBe('truncation');
    const outputItems = result.messages.slice(0, -8).filter((item: any) => item.type === 'function_call_output');
    for (const item of outputItems) {
      expect(item.output).toContain('[truncated]');
    }
  });

  it('keeps Codex function_call_output paired when LLM compaction cuts across a call boundary', async () => {
    const items = [
      ...Array.from({ length: 12 }, (_, i) => ({
        type: 'message',
        role: 'user',
        content: `old context ${i} ${'x'.repeat(1000)}`,
      })),
      { type: 'function_call', call_id: 'fc_boundary', name: 'Bash', arguments: '{"command":"date"}' },
      { type: 'function_call_output', call_id: 'fc_boundary', output: 'Fri May 15 17:32:00 CDT 2026' },
      ...Array.from({ length: 7 }, (_, i) => ({
        type: 'message',
        role: 'user',
        content: `recent follow-up ${i}`,
      })),
    ];

    const result = await compactMessages(items, codexFormatHelper, { maxContextTokens: 1_000 }, 1, fullConfig);

    expect(result.method).toBe('llm');
    const outputIndex = result.messages.findIndex(
      (item: any) => item.type === 'function_call_output' && item.call_id === 'fc_boundary',
    );
    expect(outputIndex).toBeGreaterThan(0);
    expect(result.messages[outputIndex - 1]).toMatchObject({
      type: 'function_call',
      call_id: 'fc_boundary',
      name: 'Bash',
    });
  });

  it('drops Codex function_call_output items with no matching call', () => {
    const repaired = repairCodexFunctionCallOutputs([
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'function_call_output', call_id: 'missing_call', output: 'orphaned output' },
    ]);

    expect(repaired).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
    ]);
  });

  it('falls back to truncation without fullConfig', async () => {
    const messages = manyItems(anthropicExchange, 'x'.repeat(10_000));
    const result = await compactMessages(messages, anthropicFormatHelper, { maxContextTokens: 1_000 });

    expect(result.compacted).toBe(true);
    expect(result.method).toBe('truncation');
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('enforces the token ceiling for huge non-tool messages in every format', async () => {
    const cases = [
      {
        helper: anthropicFormatHelper,
        makeItem: (content: string) => ({ role: 'user', content: [{ type: 'text', text: content }] }),
      },
      {
        helper: openaiFormatHelper,
        makeItem: (content: string) => ({ role: 'user', content }),
      },
      {
        helper: codexFormatHelper,
        makeItem: (content: string) => ({ type: 'message', role: 'user', content }),
      },
    ];

    for (const { helper, makeItem } of cases) {
      const items = Array.from({ length: 12 }, (_, index) => (
        makeItem(`${index}: ${'x'.repeat(10_000)}${index === 11 ? ' LATEST' : ''}`)
      ));
      const original = JSON.stringify(items);
      const result = await compactMessages(items, helper, { maxContextTokens: 1_000 });

      expect(result.tokensAfter).toBeLessThanOrEqual(1_000);
      expect(JSON.stringify(result.messages)).toContain('LATEST');
      expect(JSON.stringify(result.messages)).toContain('truncated for context limit');
      expect(JSON.stringify(items)).toBe(original);
    }
  });

  it('keeps retained Codex function outputs paired while enforcing the ceiling', async () => {
    const items = [
      ...Array.from({ length: 12 }, (_, index) => ({
        type: 'message',
        role: 'user',
        content: `old ${index} ${'x'.repeat(10_000)}`,
      })),
      { type: 'function_call', call_id: 'fc_recent', name: 'Bash', arguments: '{"command":"date"}' },
      { type: 'function_call_output', call_id: 'fc_recent', output: 'y'.repeat(10_000) },
      { type: 'message', role: 'user', content: 'newest request' },
    ];

    const result = await compactMessages(items, codexFormatHelper, { maxContextTokens: 500 });

    expect(result.tokensAfter).toBeLessThanOrEqual(500);
    const outputIndex = result.messages.findIndex(
      (item: any) => item.type === 'function_call_output' && item.call_id === 'fc_recent',
    );
    expect(outputIndex).toBeGreaterThan(0);
    expect(result.messages[outputIndex - 1]).toMatchObject({
      type: 'function_call',
      call_id: 'fc_recent',
    });
    expect(result.messages.at(-1)).toMatchObject({ content: 'newest request' });
  });

  it('keeps a fitting recent tool result intact after dropping older content', async () => {
    const output = 'recent result '.repeat(30);
    const items = [
      { type: 'message', role: 'user', content: 'x'.repeat(20_000) },
      { type: 'function_call', call_id: 'fc_fit', name: 'Bash', arguments: '{"command":"date"}' },
      { type: 'function_call_output', call_id: 'fc_fit', output },
      { type: 'message', role: 'user', content: 'newest request' },
    ];

    const result = await compactMessages(items, codexFormatHelper, { maxContextTokens: 500 });

    expect(result.tokensAfter).toBeLessThanOrEqual(500);
    expect(result.messages.find((item: any) => item.type === 'function_call_output')?.output).toBe(output);
  });

  it('does not retain orphaned Anthropic or OpenAI tool results after an LLM tail cut', async () => {
    const cases = [
      {
        helper: anthropicFormatHelper,
        call: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_boundary', name: 'Bash', input: { command: 'date' } }],
        },
        result: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_boundary', content: 'result' }],
        },
        isOrphan: (items: any[]) => items.some((item) => (
          Array.isArray(item.content)
          && item.content.some((block: any) => block.type === 'tool_result')
          && !items.some((candidate) => (
            Array.isArray(candidate.content)
            && candidate.content.some((block: any) => block.type === 'tool_use')
          ))
        )),
      },
      {
        helper: openaiFormatHelper,
        call: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tool_boundary', type: 'function', function: { name: 'Bash', arguments: '{}' } }],
        },
        result: { role: 'tool', tool_call_id: 'tool_boundary', content: 'result' },
        isOrphan: (items: any[]) => items.some((item) => (
          item.role === 'tool'
          && !items.some((candidate) => candidate.tool_calls?.some((call: any) => call.id === item.tool_call_id))
        )),
      },
    ];

    for (const { helper, call, result: toolResult, isOrphan } of cases) {
      const items = [
        ...Array.from({ length: 12 }, (_, index) => ({
          role: 'user',
          content: `old ${index} ${'x'.repeat(1_000)}`,
        })),
        call,
        toolResult,
        ...Array.from({ length: 7 }, (_, index) => ({ role: 'user', content: `recent ${index}` })),
      ];

      const compacted = await compactMessages(items, helper, { maxContextTokens: 1_000 }, 1, fullConfig);
      expect(isOrphan(compacted.messages)).toBe(false);
    }
  });

  it('keeps last 8 items intact across all formats', async () => {
    for (const [factory, helper] of [
      [anthropicExchange, anthropicFormatHelper],
      [openaiExchange, openaiFormatHelper],
      [codexExchange, codexFormatHelper],
    ] as const) {
      const items = manyItems(factory as any, 'x'.repeat(10_000));
      const result = await compactMessages(items, helper, { maxContextTokens: 20_000 }, 1, fullConfig);
      expect(result.messages.slice(-8)).toEqual(items.slice(-8));
      mockChat.mockClear();
      mockChat.mockResolvedValue('Summary of the conversation.');
    }
  });

  it('does not mutate the input array', async () => {
    const messages = manyItems(anthropicExchange, 'x'.repeat(10_000));
    const originalJson = JSON.stringify(messages);
    await compactMessages(messages, anthropicFormatHelper, { maxContextTokens: 1_000 }, 1, fullConfig);
    expect(JSON.stringify(messages)).toBe(originalJson);
  });

  it('includes token counts in result', async () => {
    const messages = manyItems(anthropicExchange, 'x'.repeat(10_000));
    const result = await compactMessages(messages, anthropicFormatHelper, { maxContextTokens: 1_000 }, 1, fullConfig);
    expect(result.tokensBefore).toBeGreaterThan(1_000);
    expect(result.tokensAfter).toBeDefined();
  });

  it('preserves non-tool-result items during truncation', async () => {
    mockChat.mockRejectedValueOnce(new Error('fail'));
    const items = manyItems(codexExchange, 'x'.repeat(10_000));
    const result = await compactMessages(items, codexFormatHelper, { maxContextTokens: 1_000 }, 1, fullConfig);
    const callItems = result.messages.filter((item: any) => item.type === 'function_call');
    for (const item of callItems) {
      expect(item.name).toBe('Bash');
    }
  });

  it('works with a custom MessageFormatHelper', async () => {
    // Demonstrate that any format helper works with the generic function
    const customHelper = {
      isToolResult: (item: any) => item.kind === 'result',
      truncateToolResult: (item: any, maxChars: number) => ({
        ...item,
        data: item.data.slice(0, maxChars) + ' [truncated]',
      }),
      serialize: (items: any[]) => items.map(i => JSON.stringify(i)).join('\n'),
      buildSummaryMessage: (summary: string) => ({ kind: 'summary', data: summary }),
    };

    const items: any[] = [];
    for (let i = 0; i < 30; i++) {
      items.push({ kind: 'call', name: 'test' });
      items.push({ kind: 'result', data: 'x'.repeat(10_000) });
    }

    const result = await compactMessages(items, customHelper, { maxContextTokens: 1_000 }, 1, fullConfig);
    expect(result.compacted).toBe(true);
    expect(result.method).toBe('llm');
    expect(result.messages[0].kind).toBe('summary');
  });

  it('fails clearly when a custom format cannot fit its newest item', async () => {
    const helper = {
      isToolResult: () => false,
      truncateToolResult: (item: any) => item,
      serialize: (items: any[]) => JSON.stringify(items),
      buildSummaryMessage: (summary: string) => ({ content: summary }),
    };

    await expect(compactMessages(
      [{ content: 'x'.repeat(10_000) }],
      helper,
      { maxContextTokens: 100 },
    )).rejects.toThrow('without dropping the newest item');
  });
});

// =====================================================================
// Legacy wrapper tests (verify backward compatibility)
// =====================================================================

describe('compactAnthropicMessages (legacy wrapper)', () => {
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
    const messages = manyItems(anthropicExchange, 'x'.repeat(10_000));
    const result = await compactAnthropicMessages(messages, { maxContextTokens: 20_000 }, 1, fullConfig);

    expect(result.compacted).toBe(true);
    expect(result.method).toBe('llm');
    expect(result.summary).toBeTruthy();
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content[0].text).toContain('[Conversation Summary]');
    expect(result.messages.slice(-8)).toEqual(messages.slice(-8));
  });

  it('passes through unchanged when disabled', async () => {
    const messages = manyItems(anthropicExchange, 'x'.repeat(10_000));
    const result = await compactAnthropicMessages(messages, { enabled: false, maxContextTokens: 1 });
    expect(result.messages).toBe(messages);
    expect(result.compacted).toBe(false);
  });
});

describe('compactOpenAIMessages (legacy wrapper)', () => {
  it('passes through unchanged when under threshold', async () => {
    const messages = openaiExchange('short result');
    const result = await compactOpenAIMessages(messages, { maxContextTokens: 100_000 });
    expect(result.messages).toBe(messages);
    expect(result.compacted).toBe(false);
  });

  it('uses LLM summarization when fullConfig is provided', async () => {
    const messages = manyItems(openaiExchange, 'x'.repeat(10_000));
    const result = await compactOpenAIMessages(messages, { maxContextTokens: 20_000 }, 1, fullConfig);

    expect(result.compacted).toBe(true);
    expect(result.method).toBe('llm');
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toContain('[Conversation Summary]');
  });

  it('passes through unchanged when disabled', async () => {
    const messages = manyItems(openaiExchange, 'x'.repeat(10_000));
    const result = await compactOpenAIMessages(messages, { enabled: false, maxContextTokens: 1 });
    expect(result.messages).toBe(messages);
    expect(result.compacted).toBe(false);
  });
});

describe('compactCodexMessages (legacy wrapper)', () => {
  it('passes through unchanged when under threshold', async () => {
    const items = codexExchange('short result');
    const result = await compactCodexMessages(items, { maxContextTokens: 100_000 });
    expect(result.messages).toEqual(items);
    expect(result.compacted).toBe(false);
  });

  it('uses LLM summarization when fullConfig is provided', async () => {
    const items = manyItems(codexExchange, 'x'.repeat(10_000));
    const result = await compactCodexMessages(items, { maxContextTokens: 20_000 }, 1, fullConfig);

    expect(result.compacted).toBe(true);
    expect(result.method).toBe('llm');
    expect(result.messages[0].type).toBe('message');
    expect(result.messages[0].content).toContain('[Conversation Summary]');
  });

  it('passes through unchanged when disabled', async () => {
    const items = manyItems(codexExchange, 'x'.repeat(10_000));
    const result = await compactCodexMessages(items, { enabled: false, maxContextTokens: 1 });
    expect(result.messages).toBe(items);
    expect(result.compacted).toBe(false);
  });
});

// =====================================================================
// Serializer tests (unchanged — these test the format helpers indirectly)
// =====================================================================

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
