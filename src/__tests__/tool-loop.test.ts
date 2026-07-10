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
  FinalizationResponse,
} from '../providers/adapter.js';
import type { ChatMessage, ChatOptions, Config, ToolConfig } from '../types.js';

// Mock adapter for testing
class MockAdapter implements ProviderAdapter {
  readonly name = 'mock';

  isAvailable(): boolean {
    return true;
  }

  async chat(_messages: ChatMessage[], _options: ChatOptions, _config: Config): Promise<string> {
    return 'mock response';
  }

  // Track calls for assertions
  callCount = 0;
  buildMessagesCallCount = 0;
  buildToolDefsCallCount = 0;
  appendAssistantCallCount = 0;
  appendToolResultCallCount = 0;
  compactMessagesCallCount = 0;
  compactionUsageContexts: Array<{ trigger?: string; agentId?: string } | undefined> = [];
  recordUsageCallCount = 0;
  recordUsageCalls: Array<{ trigger?: string; agentId?: string }> = [];

  // Mock responses to return
  responses: NormalizedResponse[] = [];
  currentResponseIndex = 0;

  buildMessages(messages: ChatMessage[], _options: ChatOptions, _config: Config): ProviderMessages {
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
    _messages: ProviderMessages,
    _toolDefs: any[],
    _options: ChatOptions,
    _config: Config,
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
  ): Promise<FinalizationResponse | undefined>;

  async compactMessages(
    messages: ProviderMessages,
    _config: any,
    _iteration: number,
    _fullConfig?: Config,
    _abortSignal?: AbortSignal,
    usageContext?: { trigger?: string; agentId?: string },
  ): Promise<CompactionResult<any>> {
    this.compactMessagesCallCount++;
    this.compactionUsageContexts.push(usageContext);
    return {
      messages: messages.messages,
      compacted: false,
    };
  }

  recordUsage(_model: string, _usage: unknown, _trigger?: string, _agentId?: string): void {
    this.recordUsageCallCount++;
    this.recordUsageCalls.push({ trigger: _trigger, agentId: _agentId });
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

    const result = await runToolLoop(adapter, messages, options, config, toolConfig, {
      trigger: 'cron',
      agentId: 'mayora',
    });

    expect(result.response).toBe('Hello! How can I help you?');
    expect(result.toolCalls).toEqual([]);
    expect(adapter.callCount).toBe(1);
    expect(adapter.buildMessagesCallCount).toBe(1);
    expect(adapter.recordUsageCallCount).toBe(1);
    expect(adapter.recordUsageCalls).toEqual([{ trigger: 'cron', agentId: 'mayora' }]);
    expect(adapter.compactionUsageContexts).toEqual([{ trigger: 'cron', agentId: 'mayora' }]);
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

  it('stops before executing the tool call that exhausts the token budget', async () => {
    toolConfig.maxTurnTokens = 250;
    adapter.onEmptyFinalResponse = vi.fn().mockResolvedValue({
      textContent: 'Final answer from gathered results',
      usage: { inputTokens: 20, outputTokens: 5 },
      cost: { input: 0.01, output: 0.01, total: 0.02 },
    });
    adapter.responses = [
      {
        hasToolCalls: true,
        toolCalls: [{ id: 'call-1', name: 'testTool', args: { step: 1 }, rawArgs: '{"step":1}' }],
        textContent: '',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      },
      {
        hasToolCalls: true,
        toolCalls: [{ id: 'call-2', name: 'testTool', args: { step: 2 }, rawArgs: '{"step":2}' }],
        textContent: '',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      },
    ];

    const result = await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(result.response).toBe('Final answer from gathered results');
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(adapter.callCount).toBe(2);
    expect(adapter.onEmptyFinalResponse).toHaveBeenCalledTimes(1);
    expect(result.usage?.total_tokens).toBe(325);
    expect(result.cost?.total).toBe(0.02);
    expect(adapter.recordUsageCallCount).toBe(3);
    expect(adapter.appendAssistantCallCount).toBe(2);
    expect(adapter.appendToolResultCallCount).toBe(2);
  });

  it('does not execute tools when the first response exceeds the token budget', async () => {
    toolConfig.maxTurnTokens = 100;
    adapter.onEmptyFinalResponse = vi.fn().mockResolvedValue({
      textContent: 'Budget-limited answer',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    adapter.responses = [{
      hasToolCalls: true,
      toolCalls: [{ id: 'call-1', name: 'testTool', args: {}, rawArgs: '{}' }],
      textContent: '',
      usage: { inputTokens: 100, outputTokens: 50 },
      rawResponse: {},
    }];

    const result = await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(result.response).toBe('Budget-limited answer');
    expect(mockExecuteTool).not.toHaveBeenCalled();
    expect(adapter.appendAssistantCallCount).toBe(1);
    expect(adapter.appendToolResultCallCount).toBe(1);
    expect(adapter.onEmptyFinalResponse).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a tool-calling response has no usage data', async () => {
    toolConfig.maxTurnTokens = 1000;
    adapter.onEmptyFinalResponse = vi.fn().mockResolvedValue({
      textContent: 'Usage was unavailable, so the turn stopped',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    adapter.responses = [{
      hasToolCalls: true,
      toolCalls: [{ id: 'call-1', name: 'testTool', args: {}, rawArgs: '{}' }],
      textContent: '',
      usage: undefined,
      rawResponse: {},
    }];

    const result = await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(result.response).toBe('Usage was unavailable, so the turn stopped');
    expect(mockExecuteTool).not.toHaveBeenCalled();
    expect(adapter.onEmptyFinalResponse).toHaveBeenCalledTimes(1);
    expect(result.usage).toBeUndefined();
  });

  it('returns a completed text response even when it reaches the token budget', async () => {
    toolConfig.maxTurnTokens = 100;
    adapter.onEmptyFinalResponse = vi.fn().mockResolvedValue({
      textContent: 'Should not replace final text',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    adapter.responses = [{
      hasToolCalls: false,
      toolCalls: [],
      textContent: 'Already complete',
      usage: { inputTokens: 100, outputTokens: 50 },
      rawResponse: {},
    }];

    const result = await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(result.response).toBe('Already complete');
    expect(adapter.onEmptyFinalResponse).not.toHaveBeenCalled();
  });

  it('should continue past legacy maxIterations until the model returns a final answer', async () => {
    mockExecuteTool.mockImplementation(async (_name, args) => `tool result ${JSON.stringify(args)}`);
    adapter.responses = [
      ...Array.from({ length: 25 }, (_, index) => ({
        hasToolCalls: true,
        toolCalls: [
          {
            id: `call-loop-${index}`,
            name: 'testTool',
            args: { param: `value-${index}` },
            rawArgs: `{"param":"value-${index}"}`,
          },
        ],
        textContent: '',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      })),
      {
        hasToolCalls: false,
        toolCalls: [],
        textContent: 'Finished after a long tool run',
        usage: { inputTokens: 100, outputTokens: 50 },
        rawResponse: {},
      },
    ];

    const result = await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(result.response).toBe('Finished after a long tool run');
    expect(adapter.callCount).toBe(26);
    expect(adapter.compactMessagesCallCount).toBe(26);
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

  it('does not execute provider-requested tools when cancellation arrives during the request', async () => {
    const abortController = new AbortController();
    let resolveCall = (_response: NormalizedResponse) => {};
    const callResult = new Promise<NormalizedResponse>((resolve) => {
      resolveCall = resolve;
    });
    vi.spyOn(adapter, 'call').mockImplementation(() => callResult);
    const run = runToolLoop(
      adapter,
      messages,
      { ...options, abortSignal: abortController.signal },
      config,
      toolConfig,
    );

    await vi.waitFor(() => expect(adapter.call).toHaveBeenCalledTimes(1));
    abortController.abort();
    resolveCall({
      hasToolCalls: true,
      toolCalls: [{ id: 'call-after-abort', name: 'testTool', args: {}, rawArgs: '{}' }],
      textContent: '',
      usage: { inputTokens: 100, outputTokens: 50 },
      rawResponse: {},
    });

    const result = await run;
    expect(result.response).toContain('Cancelled');
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it('waits for an in-flight tool to observe cancellation and does not call the provider again', async () => {
    const { endTrace } = await import('../audit.js');
    vi.mocked(endTrace).mockClear();
    const abortController = new AbortController();
    adapter.responses = [{
      hasToolCalls: true,
      toolCalls: [{ id: 'call-1', name: 'testTool', args: {}, rawArgs: '{}' }],
      textContent: '',
      usage: { inputTokens: 100, outputTokens: 50 },
      rawResponse: {},
    }];
    mockExecuteTool.mockImplementation(
      (_name, _args, _toolConfig, context) => new Promise<string>((resolve) => {
        context.abortSignal.addEventListener('abort', () => resolve('cancelled'), { once: true });
      }),
    );

    const run = runToolLoop(
      adapter,
      messages,
      { ...options, abortSignal: abortController.signal },
      config,
      toolConfig,
    );
    await vi.waitFor(() => expect(mockExecuteTool).toHaveBeenCalledTimes(1));
    abortController.abort();

    const result = await run;
    expect(result.response).toContain('Cancelled');
    expect(adapter.callCount).toBe(1);
    expect(endTrace).toHaveBeenCalledWith('trace-123', 'error');
  });

  it('marks its trace as error when cancellation rejects during compaction', async () => {
    const { endTrace } = await import('../audit.js');
    vi.mocked(endTrace).mockClear();
    const abortController = new AbortController();
    vi.spyOn(adapter, 'compactMessages').mockImplementation(async () => {
      abortController.abort();
      throw new Error('compaction cancelled');
    });

    await expect(runToolLoop(
      adapter,
      messages,
      { ...options, abortSignal: abortController.signal },
      config,
      toolConfig,
    )).rejects.toThrow('compaction cancelled');

    expect(endTrace).toHaveBeenCalledWith('trace-123', 'error');
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
      adapter.onEmptyFinalResponse = vi.fn().mockResolvedValue({
        textContent: 'Finalized answer',
        usage: { inputTokens: 5, outputTokens: 2 },
      });
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
      adapter.onEmptyFinalResponse = vi.fn().mockResolvedValue({
        textContent: 'Should not appear',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
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
      adapter.onEmptyFinalResponse = vi.fn().mockResolvedValue({
        textContent: 'Should not appear',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
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

      expect(result.response).toBe('[Model returned empty response — please try again]');
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

    it('should return checkpoint finalization when legacy maxIterations is reached', async () => {
      const customToolConfig = { ...toolConfig, maxIterations: 2 };
      adapter.onEmptyFinalResponse = vi.fn().mockResolvedValue({
        textContent: 'Best effort final answer',
        usage: { inputTokens: 5, outputTokens: 2 },
      });
      adapter.responses = [
        {
          hasToolCalls: true,
          toolCalls: [{ id: 'call-loop-1', name: 'testTool', args: { x: 1 }, rawArgs: '{"x":1}' }],
          textContent: '',
          usage: { inputTokens: 10, outputTokens: 5 },
          rawResponse: {},
        },
        {
          hasToolCalls: true,
          toolCalls: [{ id: 'call-loop-2', name: 'testTool', args: { x: 2 }, rawArgs: '{"x":2}' }],
          textContent: '',
          usage: { inputTokens: 10, outputTokens: 5 },
          rawResponse: {},
        },
      ];

      const result = await runToolLoop(adapter, messages, options, config, customToolConfig);

      expect(result.response).toBe('Best effort final answer');
      expect(adapter.callCount).toBe(2);
      expect(adapter.onEmptyFinalResponse).toHaveBeenCalledTimes(1);
    });

    it('should continue after checkpoint finalization returns empty', async () => {
      const customToolConfig = { ...toolConfig, maxIterations: 2 };
      adapter.onEmptyFinalResponse = vi.fn().mockResolvedValue({
        textContent: '',
        usage: { inputTokens: 5, outputTokens: 2 },
      });
      adapter.responses = [
        {
          hasToolCalls: true,
          toolCalls: [{ id: 'call-loop-1', name: 'testTool', args: { x: 1 }, rawArgs: '{"x":1}' }],
          textContent: '',
          usage: { inputTokens: 10, outputTokens: 5 },
          rawResponse: {},
        },
        {
          hasToolCalls: true,
          toolCalls: [{ id: 'call-loop-2', name: 'testTool', args: { x: 2 }, rawArgs: '{"x":2}' }],
          textContent: '',
          usage: { inputTokens: 10, outputTokens: 5 },
          rawResponse: {},
        },
        {
          hasToolCalls: false,
          toolCalls: [],
          textContent: 'Final after configured limit',
          usage: { inputTokens: 10, outputTokens: 5 },
          rawResponse: {},
        },
      ];

      const result = await runToolLoop(adapter, messages, options, config, customToolConfig);

      expect(result.response).toBe('Final after configured limit');
      expect(adapter.callCount).toBe(3);
      expect(adapter.onEmptyFinalResponse).toHaveBeenCalledTimes(1);
    });

    it('should retry checkpoint finalization every legacy maxIterations interval', async () => {
      const customToolConfig = { ...toolConfig, maxIterations: 2 };
      adapter.onEmptyFinalResponse = vi.fn().mockResolvedValue({
        textContent: '',
        usage: { inputTokens: 5, outputTokens: 2 },
      });
      mockExecuteTool.mockImplementation(async (_name, args) => `tool result ${JSON.stringify(args)}`);
      adapter.responses = [
        ...Array.from({ length: 5 }, (_, index) => ({
          hasToolCalls: true,
          toolCalls: [{ id: `call-loop-${index}`, name: 'testTool', args: { x: index }, rawArgs: `{"x":${index}}` }],
          textContent: '',
          usage: { inputTokens: 10, outputTokens: 5 },
          rawResponse: {},
        })),
        {
          hasToolCalls: false,
          toolCalls: [],
          textContent: 'Final after repeated checkpoints',
          usage: { inputTokens: 10, outputTokens: 5 },
          rawResponse: {},
        },
      ];

      const result = await runToolLoop(adapter, messages, options, config, customToolConfig);

      expect(result.response).toBe('Final after repeated checkpoints');
      expect(adapter.callCount).toBe(6);
      expect(adapter.onEmptyFinalResponse).toHaveBeenCalledTimes(2);
    });

    it('does not start another iteration when checkpoint finalization exhausts the budget', async () => {
      const customToolConfig = { ...toolConfig, maxIterations: 1, maxTurnTokens: 100 };
      adapter.onEmptyFinalResponse = vi.fn().mockResolvedValue({
        textContent: '',
        usage: { inputTokens: 40, outputTokens: 10 },
      });
      adapter.responses = [{
        hasToolCalls: true,
        toolCalls: [{ id: 'call-loop-1', name: 'testTool', args: { x: 1 }, rawArgs: '{"x":1}' }],
        textContent: '',
        usage: { inputTokens: 40, outputTokens: 10 },
        rawResponse: {},
      }];

      const result = await runToolLoop(adapter, messages, options, config, customToolConfig);

      expect(result.response).toContain('Token budget exceeded');
      expect(adapter.callCount).toBe(1);
      expect(adapter.onEmptyFinalResponse).toHaveBeenCalledTimes(1);
      expect(result.usage?.total_tokens).toBe(100);
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

    it('should ignore legacy custom maxIterations from toolConfig', async () => {
      const customToolConfig = { ...toolConfig, maxIterations: 3 };
      mockExecuteTool.mockImplementation(async (_name, args) => `tool result ${JSON.stringify(args)}`);
      adapter.responses = [
        ...Array.from({ length: 5 }, (_, index) => ({
          hasToolCalls: true,
          toolCalls: [{ id: `call-x-${index}`, name: 'testTool', args: { x: index }, rawArgs: `{"x":${index}}` }],
          textContent: '',
          usage: { inputTokens: 10, outputTokens: 5 },
          rawResponse: {},
        })),
        {
          hasToolCalls: false,
          toolCalls: [],
          textContent: 'Done after custom limit',
          usage: { inputTokens: 10, outputTokens: 5 },
          rawResponse: {},
        },
      ];

      const result = await runToolLoop(adapter, messages, options, config, customToolConfig);

      expect(result.response).toBe('Done after custom limit');
      expect(adapter.callCount).toBe(6);
    });
  });
});
