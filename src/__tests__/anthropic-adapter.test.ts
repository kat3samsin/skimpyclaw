/**
 * Tests for the Anthropic provider adapter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicAdapter } from '../providers/adapters/anthropic-adapter.js';
import type { ChatMessage, ChatOptions, Config } from '../types.js';
import type { ProviderMessages } from '../providers/adapter.js';

// Mock the Anthropic client - create a single shared mock
const mockMessagesCreate = vi.fn();
const mockMessagesStream = vi.fn();
vi.mock('../providers/anthropic.js', () => ({
  getAnthropicClient: vi.fn(() => ({
    messages: {
      create: mockMessagesCreate,
      stream: mockMessagesStream,
    },
  })),
}));

// Mock utils
vi.mock('../providers/utils.js', () => ({
  buildSystemParam: vi.fn((content: string, cache: boolean) => ({ content, cache })),
  addToolCacheBreakpoint: vi.fn((defs: any[]) => defs),
  contentToText: vi.fn((content: any) => String(content)),
  stripProvider: vi.fn((model: string) => model.replace(/^[^/]+\//, '')),
  buildThinkingConfig: vi.fn(() => null),
}));

// Mock context manager
vi.mock('../providers/context-manager.js', () => ({
  compactMessages: vi.fn(async (messages: any[]) => ({
    messages,
    compacted: false,
  })),
  anthropicFormatHelper: {
    isToolResult: () => false,
    truncateToolResult: (item: any) => item,
    serialize: () => '',
    buildSummaryMessage: (s: string) => ({ role: 'user', content: [{ type: 'text', text: s }] }),
  },
}));

// Mock observability
vi.mock('../providers/observability.js', () => ({
  toCostDetails: vi.fn(() => ({ input: 0.001, output: 0.002, total: 0.003 })),
}));

// Mock usage tracking
vi.mock('../usage.js', () => ({
  buildUsageRecord: vi.fn((opts: any) => opts),
  recordUsage: vi.fn(),
}));

describe('AnthropicAdapter', () => {
  let adapter: AnthropicAdapter;
  let config: Config;
  let options: ChatOptions;

  beforeEach(async () => {
    adapter = new AnthropicAdapter();
    config = {
      gateway: { port: 18790, mode: 'local' },
      agents: { default: 'main', list: {} },
      models: { providers: {}, aliases: {}, promptCaching: true },
      channels: {
        telegram: {
          enabled: false,
          token: 'test-token',
          allowFrom: [],
        }
      },
      cron: { jobs: [] },
      heartbeat: { intervalMs: 300000, prompt: 'HEARTBEAT' },
    } as Config;
    options = {
      model: 'anthropic/claude-opus-4',
      maxTokens: 1000,
    };

    // Clear mock call history
    mockMessagesCreate.mockClear();
    mockMessagesStream.mockClear();
    const { recordUsage } = await import('../usage.js');
    vi.mocked(recordUsage).mockClear();
  });

  describe('buildMessages', () => {
    it('should extract system message and build API messages', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ];

      const result = adapter.buildMessages(messages, options, config);

      expect(result.messages).toHaveLength(2); // system excluded
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.systemParam).toBeDefined();
    });

    it('should handle missing system message', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
      ];

      const result = adapter.buildMessages(messages, options, config);

      expect(result.messages).toHaveLength(1);
    });
  });

  describe('buildToolDefs', () => {
    it('should return tool definitions with cache breakpoints when caching enabled', async () => {
      const { addToolCacheBreakpoint } = await import('../providers/utils.js');
      vi.mocked(addToolCacheBreakpoint).mockClear();

      const toolDefs = [
        { name: 'Read', description: 'Read file' },
        { name: 'Write', description: 'Write file' },
      ];

      const result = adapter.buildToolDefs(toolDefs, config);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Read');
      expect(addToolCacheBreakpoint).toHaveBeenCalled();
    });

    it('should skip cache breakpoints when promptCaching is false', async () => {
      const { addToolCacheBreakpoint } = await import('../providers/utils.js');
      vi.mocked(addToolCacheBreakpoint).mockClear();

      const noCacheConfig = {
        ...config,
        models: { ...config.models, promptCaching: false },
      } as Config;

      const toolDefs = [{ name: 'Read', description: 'Read file' }];

      adapter.buildToolDefs(toolDefs, noCacheConfig);

      expect(addToolCacheBreakpoint).not.toHaveBeenCalled();
    });
  });

  describe('call', () => {
    it('should normalize Anthropic response without tool calls', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const providerMessages = {
        messages: [{ role: 'user', content: 'Hi' }],
        systemParam: { content: 'system' },
      };

      const result = await adapter.call(providerMessages, [], options, config);

      expect(result.hasToolCalls).toBe(false);
      expect(result.textContent).toBe('Hello!');
      expect(result.usage?.inputTokens).toBe(100);
      expect(result.usage?.outputTokens).toBe(50);
    });

    it('should normalize Anthropic response with tool calls', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [
          { type: 'text', text: 'Let me read that file' },
          {
            type: 'tool_use',
            id: 'tool_123',
            name: 'Read',
            input: { file_path: 'test.txt' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 150, output_tokens: 80 },
      });

      const providerMessages = {
        messages: [{ role: 'user', content: 'Read test.txt' }],
        systemParam: { content: 'system' },
      };

      const result = await adapter.call(providerMessages, [], options, config);

      expect(result.hasToolCalls).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].id).toBe('tool_123');
      expect(result.toolCalls[0].name).toBe('Read');
      expect(result.toolCalls[0].args).toEqual({ file_path: 'test.txt' });
      expect(result.textContent).toBe('Let me read that file');
    });

    it('leaves usage undefined when Anthropic does not report it', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: 'end_turn',
        usage: {},
      });

      const result = await adapter.call(
        { messages: [{ role: 'user', content: 'Hi' }] },
        [],
        options,
        config,
      );

      expect(result.usage).toBeUndefined();
    });

    it('should handle cache metrics logging', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Cached response' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 100,
        },
      });

      const providerMessages = {
        messages: [{ role: 'user', content: 'Hi' }],
      };

      await adapter.call(providerMessages, [], options, config);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[cache]'),
      );
    });

    it('should use streaming for large xhigh thinking requests', async () => {
      const { buildThinkingConfig } = await import('../providers/utils.js');
      vi.mocked(buildThinkingConfig).mockReturnValueOnce({ budget: 32768, maxTokens: 36864 });

      const finalMessage = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Streamed response' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      });
      mockMessagesStream.mockReturnValue({ finalMessage });

      const providerMessages = {
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const result = await adapter.call(
        providerMessages,
        [],
        { ...options, thinking: 'xhigh' },
        config,
      );

      expect(mockMessagesCreate).not.toHaveBeenCalled();
      expect(mockMessagesStream).toHaveBeenCalledWith(expect.objectContaining({
        max_tokens: 36864,
        thinking: { type: 'enabled', budget_tokens: 32768 },
      }));
      expect(result.textContent).toBe('Streamed response');
    });
  });

  describe('onEmptyFinalResponse', () => {
    it('makes one text-only call and returns normalized usage', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Final answer' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 25, output_tokens: 10 },
      });
      const providerMessages = {
        messages: [{ role: 'user', content: 'Original request' }],
        systemParam: { content: 'system' },
      };

      const result = await adapter.onEmptyFinalResponse(providerMessages, [], options, config);

      expect(result.textContent).toBe('Final answer');
      expect(result.usage).toEqual(expect.objectContaining({ inputTokens: 25, outputTokens: 10 }));
      const params = mockMessagesCreate.mock.calls[0][0];
      expect(params.tools).toBeUndefined();
      expect(params.messages.at(-1).content).toContain('Do not call tools');
    });
  });

  describe('appendAssistantResponse', () => {
    it('should append raw response to messages', () => {
      const providerMessages = {
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const rawResponse = {
        content: [{ type: 'text', text: 'Hello' }],
      };

      adapter.appendAssistantResponse(providerMessages, rawResponse);

      expect(providerMessages.messages).toHaveLength(2);
      expect(providerMessages.messages[1].role).toBe('assistant');
      expect(providerMessages.messages[1].content).toBe(rawResponse.content);
    });
  });

  describe('appendToolResult', () => {
    it('should append tool result as user message', () => {
      const providerMessages: ProviderMessages = {
        messages: [{ role: 'user', content: 'Hi' }],
      };

      adapter.appendToolResult(providerMessages, 'tool_123', 'file contents', false);

      expect(providerMessages.messages).toHaveLength(2);
      expect(providerMessages.messages[1].role).toBe('user');
      expect(providerMessages.messages[1].content).toHaveLength(1);
      expect((providerMessages.messages[1].content as any)[0].type).toBe('tool_result');
      expect((providerMessages.messages[1].content as any)[0].tool_use_id).toBe('tool_123');
    });

    it('should mark error results', () => {
      const providerMessages: ProviderMessages = {
        messages: [],
      };

      adapter.appendToolResult(providerMessages, 'tool_123', 'error!', true);

      expect((providerMessages.messages[0].content as any)[0].is_error).toBe(true);
    });
  });

  describe('compactMessages', () => {
    it('should delegate to generic compactMessages with anthropicFormatHelper', async () => {
      const { compactMessages } = await import('../providers/context-manager.js');

      const providerMessages = {
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const result = await adapter.compactMessages(providerMessages, {}, 1, config);

      expect(compactMessages).toHaveBeenCalled();
      expect(result.compacted).toBe(false);
    });
  });

  describe('recordUsage', () => {
    it('should record usage with costs', async () => {
      const { recordUsage } = await import('../usage.js');

      adapter.recordUsage(
        'claude-opus-4',
        { inputTokens: 100, outputTokens: 50 },
        'api',
        'agent-1',
      );

      expect(recordUsage).toHaveBeenCalled();
    });

    it('should skip recording when tokens are zero', async () => {
      const { recordUsage } = await import('../usage.js');
      vi.mocked(recordUsage).mockClear();

      adapter.recordUsage(
        'claude-opus-4',
        { inputTokens: 0, outputTokens: 0 },
        'api',
      );

      // recordUsage should not be called when tokens are zero
      expect(recordUsage).not.toHaveBeenCalled();
    });
  });
});
