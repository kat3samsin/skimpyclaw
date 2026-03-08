/**
 * Tests for the unified tool loop orchestrator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runToolLoop } from '../providers/tool-loop.js';
import type {
  ProviderAdapter,
  ProviderMessages,
  NormalizedResponse,
  CompactionResult,
} from '../providers/adapter.js';
import type { ChatMessage, ChatOptions, Config, ToolConfig } from '../types.js';

// Mock adapter for testing
class MockAdapter implements ProviderAdapter {
  readonly name = 'mock';

  // Track calls for assertions
  callCount = 0;
  buildMessagesCallCount = 0;
  buildToolDefsCallCount = 0;
  appendAssistantCallCount = 0;
  appendToolResultCallCount = 0;
  compactMessagesCallCount = 0;
  recordUsageCallCount = 0;

  // Mock responses to return
  responses: NormalizedResponse[] = [];
  currentResponseIndex = 0;

  buildMessages(messages: ChatMessage[], options: ChatOptions, config: Config): ProviderMessages {
    this.buildMessagesCallCount++;
    return {
      messages: messages.filter(m => m.role !== 'system'),
      systemParam: messages.find(m => m.role === 'system')?.content,
    };
  }

  buildToolDefs(toolDefs: any[], _config: Config): any[] {
    this.buildToolDefsCallCount++;
    return toolDefs;
  }

  async call(
    messages: ProviderMessages,
    toolDefs: any[],
    options: ChatOptions,
    config: Config,
  ): Promise<NormalizedResponse> {
    this.callCount++;
    const response = this.responses[this.currentResponseIndex] || {
      hasToolCalls: false,
      toolCalls: [],
      textContent: 'default response',
      usage: { inputTokens: 100, outputTokens: 50 },
      rawResponse: {},
    };
    this.currentResponseIndex++;
    return response;
  }

  appendAssistantResponse(messages: ProviderMessages, rawResponse: unknown): void {
    this.appendAssistantCallCount++;
    messages.messages.push({ role: 'assistant', raw: rawResponse });
  }

  appendToolResult(messages: ProviderMessages, toolCallId: string, result: string, isError?: boolean): void {
    this.appendToolResultCallCount++;
    messages.messages.push({ role: 'tool', toolCallId, result, isError });
  }

  appendToolResults?(messages: ProviderMessages, results: { toolCallId: string; result: string; isError?: boolean }[]): void;

  onEmptyFinalResponse?(
    providerMessages: ProviderMessages,
    toolDefs: any[],
    options: ChatOptions,
    config: Config,
  ): Promise<string | undefined>;

  async compactMessages(
    messages: ProviderMessages,
    config: any,
    iteration: number,
    fullConfig?: Config,
  ): Promise<CompactionResult<any>> {
    this.compactMessagesCallCount++;
    return {
      messages: messages.messages,
      compacted: false,
    };
  }

  recordUsage(model: string, usage: unknown, trigger?: string, agentId?: string): void {
    this.recordUsageCallCount++;
  }
}

// Mock tool execution
const { mockExecuteTool } = vi.hoisted(() => ({
  mockExecuteTool: vi.fn().mockResolvedValue('tool result'),
}));
vi.mock('../tools.js', () => ({
  getToolDefinitions: vi.fn().mockResolvedValue([
    { name: 'testTool', description: 'A test tool' },
  ]),
  executeTool: mockExecuteTool,
}));

// Mock audit functions
vi.mock('../audit.js', () => ({
  startTrace: vi.fn().mockReturnValue('trace-123'),
  addEvent: vi.fn(),
  endTrace: vi.fn().mockResolvedValue(undefined),
}));

describe('runToolLoop', () => {
  let adapter: MockAdapter;
  let messages: ChatMessage[];
  let options: ChatOptions;
  let config: Config;
  let toolConfig: ToolConfig;

  beforeEach(() => {
    mockExecuteTool.mockReset();
    mockExecuteTool.mockResolvedValue('tool result');
    adapter = new MockAdapter();
    messages = [
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'user', content: 'Hello' },
    ];
    options = {
      model: 'test-model',
      maxTokens: 1000,
    };
    config = {
      gateway: { port: 18790, mode: 'local' },
      agents: { default: 'main', list: {} },
      models: { providers: {}, aliases: {} },
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
    toolConfig = {
      enabled: true,
      allowedPaths: ['/tmp'],
      maxIterations: 20,
    };
  });

  it('should complete in one iteration when model returns text without tool calls', async () => {
    adapter.responses = [
      {
        hasToolCalls: false,
        toolCalls: [],
        textContent: 'Hello! How can I help you?',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      },
    ];

    const result = await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(result.response).toBe('Hello! How can I help you?');
    expect(result.toolCalls).toEqual([]);
    expect(adapter.callCount).toBe(1);
    expect(adapter.buildMessagesCallCount).toBe(1);
    expect(adapter.recordUsageCallCount).toBe(1);
  });

  it('should handle tool calls and continue iteration', async () => {
    adapter.responses = [
      {
        hasToolCalls: true,
        toolCalls: [
          {
            id: 'call-1',
            name: 'testTool',
            args: { param: 'value' },
            rawArgs: '{"param":"value"}',
          },
        ],
        textContent: '',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: { content: 'response1' },
      },
      {
        hasToolCalls: false,
        toolCalls: [],
        textContent: 'Done!',
        usage: { inputTokens: 150, outputTokens: 30 },
        rawResponse: {},
      },
    ];

    const result = await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(result.response).toBe('Done!');
    expect(result.toolCalls).toHaveLength(1);
    expect(adapter.callCount).toBe(2);
    expect(adapter.appendAssistantCallCount).toBe(1);
    expect(adapter.appendToolResultCallCount).toBe(1);
  });

  it('should stop at max iterations', async () => {
    // Return tool calls every time
    adapter.responses = Array(25).fill({
      hasToolCalls: true,
      toolCalls: [
        {
          id: 'call-loop',
          name: 'testTool',
          args: { param: 'value' },
          rawArgs: '{"param":"value"}',
        },
      ],
      textContent: '',
      usage: { inputTokens: 100, outputTokens: 50 },
      rawResponse: {},
    });

    const result = await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(result.response).toContain('maximum iterations');
    expect(adapter.callCount).toBe(20); // maxIterations default
  });

  it('should handle abort signal', async () => {
    const abortController = new AbortController();
    const toolContext = {
      abortSignal: abortController.signal,
    };

    // Set up multiple responses to give abort time to trigger
    adapter.responses = [
      {
        hasToolCalls: true,
        toolCalls: [{ id: 'call-1', name: 'testTool', args: {}, rawArgs: '{}' }],
        textContent: '',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      },
      {
        hasToolCalls: true,
        toolCalls: [{ id: 'call-2', name: 'testTool', args: {}, rawArgs: '{}' }],
        textContent: '',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      },
    ];

    // Abort immediately
    abortController.abort();

    const result = await runToolLoop(adapter, messages, options, config, toolConfig, toolContext);

    expect(result.response).toContain('Cancelled');
  });

  it('should call compactMessages on each iteration', async () => {
    adapter.responses = [
      {
        hasToolCalls: true,
        toolCalls: [{ id: 'call-1', name: 'testTool', args: {}, rawArgs: '{}' }],
        textContent: '',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      },
      {
        hasToolCalls: false,
        toolCalls: [],
        textContent: 'Done',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      },
    ];

    await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(adapter.compactMessagesCallCount).toBe(2);
  });

  it('should recover from tool execution errors and feed error back to model', async () => {
    mockExecuteTool.mockRejectedValueOnce(new Error('file not found'));

    adapter.responses = [
      {
        hasToolCalls: true,
        toolCalls: [{ id: 'call-err', name: 'testTool', args: { path: '/missing' }, rawArgs: '{"path":"/missing"}' }],
        textContent: '',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      },
      {
        hasToolCalls: false,
        toolCalls: [],
        textContent: 'Recovered from error',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      },
    ];

    const result = await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(result.response).toBe('Recovered from error');
    expect(adapter.appendToolResultCallCount).toBe(1);
    expect(adapter.callCount).toBe(2);
    // Tool log should contain the error
    expect(result.toolCalls.some(t => t.includes('ERROR'))).toBe(true);
  });

  it('should call endTrace when the loop completes and it created the trace', async () => {
    const { endTrace } = await import('../audit.js');
    vi.mocked(endTrace).mockClear();

    adapter.responses = [
      {
        hasToolCalls: false,
        toolCalls: [],
        textContent: 'Done',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      },
    ];

    await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(endTrace).toHaveBeenCalledWith('trace-123', 'ok');
  });

  it('should batch multiple tool results via appendToolResults when adapter supports it', async () => {
    // Add batch support to the mock adapter
    const batchedResults: any[] = [];
    adapter.appendToolResults = (msgs, results) => {
      batchedResults.push(...results);
      msgs.messages.push({ role: 'user', content: results });
    };

    adapter.responses = [
      {
        hasToolCalls: true,
        toolCalls: [
          { id: 'call-1', name: 'testTool', args: { a: 1 }, rawArgs: '{"a":1}' },
          { id: 'call-2', name: 'testTool', args: { b: 2 }, rawArgs: '{"b":2}' },
        ],
        textContent: '',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      },
      {
        hasToolCalls: false,
        toolCalls: [],
        textContent: 'Done with both',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      },
    ];

    const result = await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(result.response).toBe('Done with both');
    expect(batchedResults).toHaveLength(2);
    expect(batchedResults[0].toolCallId).toBe('call-1');
    expect(batchedResults[1].toolCallId).toBe('call-2');
    // appendToolResult should NOT have been called (batching was used instead)
    expect(adapter.appendToolResultCallCount).toBe(0);
  });

  it('should provide fallback response when model returns empty text after tool use', async () => {
    adapter.responses = [
      {
        hasToolCalls: true,
        toolCalls: [{ id: 'call-1', name: 'testTool', args: {}, rawArgs: '{}' }],
        textContent: '',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      },
      {
        hasToolCalls: false,
        toolCalls: [],
        textContent: '', // Empty response
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      },
    ];

    const result = await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(result.response).toContain('Completed with 1 tool calls');
  });

  describe('onEmptyFinalResponse hook', () => {
    it('should call onEmptyFinalResponse when final text is empty after tool use', async () => {
      adapter.onEmptyFinalResponse = vi.fn().mockResolvedValue('Finalized answer');
      adapter.responses = [
        {
          hasToolCalls: true,
          toolCalls: [{ id: 'call-1', name: 'testTool', args: {}, rawArgs: '{}' }],
          textContent: '',
          usage: { inputTokens: 100, outputTokens: 50 },
          rawResponse: {},
        },
        {
          hasToolCalls: false,
          toolCalls: [],
          textContent: '', // Empty — triggers finalization hook
          usage: { inputTokens: 100, outputTokens: 50 },
          rawResponse: {},
        },
      ];

      const result = await runToolLoop(adapter, messages, options, config, toolConfig);

      expect(result.response).toBe('Finalized answer');
      expect(adapter.onEmptyFinalResponse).toHaveBeenCalledTimes(1);
    });

    it('should NOT call onEmptyFinalResponse when final text is non-empty', async () => {
      adapter.onEmptyFinalResponse = vi.fn().mockResolvedValue('Should not appear');
      adapter.responses = [
        {
          hasToolCalls: true,
          toolCalls: [{ id: 'call-1', name: 'testTool', args: {}, rawArgs: '{}' }],
          textContent: '',
          usage: { inputTokens: 100, outputTokens: 50 },
          rawResponse: {},
        },
        {
          hasToolCalls: false,
          toolCalls: [],
          textContent: 'Got a real answer',
          usage: { inputTokens: 100, outputTokens: 50 },
          rawResponse: {},
        },
      ];

      const result = await runToolLoop(adapter, messages, options, config, toolConfig);

      expect(result.response).toBe('Got a real answer');
      expect(adapter.onEmptyFinalResponse).not.toHaveBeenCalled();
    });

    it('should NOT call onEmptyFinalResponse when no tool calls were made', async () => {
      adapter.onEmptyFinalResponse = vi.fn().mockResolvedValue('Should not appear');
      adapter.responses = [
        {
          hasToolCalls: false,
          toolCalls: [],
          textContent: '', // Empty but no tool calls — no finalization
          usage: { inputTokens: 100, outputTokens: 50 },
          rawResponse: {},
        },
      ];

      const result = await runToolLoop(adapter, messages, options, config, toolConfig);

      expect(result.response).toBe('');
      expect(adapter.onEmptyFinalResponse).not.toHaveBeenCalled();
    });

    it('should fall back to default message when onEmptyFinalResponse returns undefined', async () => {
      adapter.onEmptyFinalResponse = vi.fn().mockResolvedValue(undefined);
      adapter.responses = [
        {
          hasToolCalls: true,
          toolCalls: [{ id: 'call-1', name: 'testTool', args: {}, rawArgs: '{}' }],
          textContent: '',
          usage: { inputTokens: 100, outputTokens: 50 },
          rawResponse: {},
        },
        {
          hasToolCalls: false,
          toolCalls: [],
          textContent: '',
          usage: { inputTokens: 100, outputTokens: 50 },
          rawResponse: {},
        },
      ];

      const result = await runToolLoop(adapter, messages, options, config, toolConfig);

      expect(result.response).toContain('Completed with 1 tool calls');
      expect(adapter.onEmptyFinalResponse).toHaveBeenCalledTimes(1);
    });

    it('should fall back to default message when onEmptyFinalResponse throws', async () => {
      adapter.onEmptyFinalResponse = vi.fn().mockRejectedValue(new Error('finalize failed'));
      adapter.responses = [
        {
          hasToolCalls: true,
          toolCalls: [{ id: 'call-1', name: 'testTool', args: {}, rawArgs: '{}' }],
          textContent: '',
          usage: { inputTokens: 100, outputTokens: 50 },
          rawResponse: {},
        },
        {
          hasToolCalls: false,
          toolCalls: [],
          textContent: '',
          usage: { inputTokens: 100, outputTokens: 50 },
          rawResponse: {},
        },
      ];

      const result = await runToolLoop(adapter, messages, options, config, toolConfig);

      expect(result.response).toContain('Completed with 1 tool calls');
      expect(adapter.onEmptyFinalResponse).toHaveBeenCalledTimes(1);
    });
  });

  describe('Codex-specific behavior through unified loop', () => {
    it('should accumulate usage across iterations', async () => {
      adapter.responses = [
        {
          hasToolCalls: true,
          toolCalls: [{ id: 'call-1', name: 'testTool', args: {}, rawArgs: '{}' }],
          textContent: '',
          usage: { inputTokens: 100, outputTokens: 50 },
          cost: { input: 0.001, output: 0.002, total: 0.003 },
          rawResponse: {},
        },
        {
          hasToolCalls: false,
          toolCalls: [],
          textContent: 'Done',
          usage: { inputTokens: 200, outputTokens: 80 },
          cost: { input: 0.002, output: 0.004, total: 0.006 },
          rawResponse: {},
        },
      ];

      const result = await runToolLoop(adapter, messages, options, config, toolConfig);

      expect(result.usage?.prompt_tokens).toBe(300);
      expect(result.usage?.completion_tokens).toBe(130);
      expect(result.usage?.total_tokens).toBe(430);
      expect(result.cost?.total).toBeCloseTo(0.009);
    });

    it('should respect custom maxIterations from toolConfig', async () => {
      const customToolConfig = { ...toolConfig, maxIterations: 3 };
      adapter.responses = Array(5).fill({
        hasToolCalls: true,
        toolCalls: [{ id: 'call-x', name: 'testTool', args: { x: 1 }, rawArgs: '{"x":1}' }],
        textContent: '',
        usage: { inputTokens: 10, outputTokens: 5 },
        rawResponse: {},
      });

      const result = await runToolLoop(adapter, messages, options, config, customToolConfig);

      expect(result.response).toContain('maximum iterations');
      expect(adapter.callCount).toBe(3);
    });
  });
});
