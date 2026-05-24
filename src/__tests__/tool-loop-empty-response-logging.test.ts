import { describe, expect, it, vi, afterEach } from 'vitest';
import { runToolLoop } from '../providers/tool-loop.js';
import type { ProviderAdapter, ProviderMessages, NormalizedResponse, CompactionResult } from '../providers/adapter.js';
import type { ChatMessage, ChatOptions, Config, ToolConfig } from '../types.js';

const { mockExecuteTool } = vi.hoisted(() => ({
  mockExecuteTool: vi.fn().mockResolvedValue('tool result'),
}));

vi.mock('../tools.js', () => ({
  getToolDefinitions: vi.fn().mockResolvedValue([
    { name: 'testTool', description: 'A test tool' },
  ]),
  executeTool: mockExecuteTool,
}));

vi.mock('../audit.js', () => ({
  startTrace: vi.fn().mockReturnValue('trace-empty-response'),
  addEvent: vi.fn(),
  endTrace: vi.fn().mockResolvedValue(undefined),
}));

class LoggingAdapter implements ProviderAdapter {
  readonly name = 'mock';
  responses: NormalizedResponse[] = [];
  private responseIndex = 0;

  isAvailable(): boolean {
    return true;
  }

  async chat(): Promise<string> {
    return 'mock response';
  }

  buildMessages(messages: ChatMessage[]): ProviderMessages {
    return { messages };
  }

  buildToolDefs(toolDefs: any[]): any[] {
    return toolDefs;
  }

  async call(): Promise<NormalizedResponse> {
    return this.responses[this.responseIndex++] || {
      hasToolCalls: false,
      toolCalls: [],
      textContent: 'default response',
      usage: { inputTokens: 1, outputTokens: 1 },
      rawResponse: {},
    };
  }

  appendAssistantResponse(messages: ProviderMessages, rawResponse: unknown): void {
    messages.messages.push({ role: 'assistant', raw: rawResponse });
  }

  appendToolResult(messages: ProviderMessages, toolCallId: string, result: string, isError?: boolean): void {
    messages.messages.push({ role: 'tool', toolCallId, result, isError });
  }

  async compactMessages(messages: ProviderMessages): Promise<CompactionResult<any>> {
    return { messages: messages.messages, compacted: false };
  }

  recordUsage(): void {}
}

const createMessages = (): ChatMessage[] => [
  { role: 'user', content: 'Do the thing' },
];

const options: ChatOptions = {
  model: 'test-model',
  maxTokens: 1000,
};

const config = {
  gateway: { port: 18790, mode: 'local' },
  agents: { default: 'main', list: {} },
  models: { providers: {}, aliases: {} },
  channels: {
    telegram: {
      enabled: false,
      token: 'test-token',
      allowFrom: [],
    },
  },
  cron: { jobs: [] },
  heartbeat: { intervalMs: 300000, prompt: 'HEARTBEAT' },
} as Config;

const toolConfig: ToolConfig = {
  enabled: true,
  allowedPaths: ['/tmp'],
  maxIterations: 20,
};

describe('runToolLoop empty response logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockExecuteTool.mockReset();
    mockExecuteTool.mockResolvedValue('tool result');
  });

  it('does not warn when empty final text follows successful tool use', async () => {
    const adapter = new LoggingAdapter();
    adapter.responses = [
      {
        hasToolCalls: true,
        toolCalls: [{ id: 'call-1', name: 'testTool', args: {}, rawArgs: '{}' }],
        textContent: '',
        usage: { inputTokens: 10, outputTokens: 1 },
        rawResponse: {},
      },
      {
        hasToolCalls: false,
        toolCalls: [],
        textContent: '',
        usage: { inputTokens: 10, outputTokens: 1 },
        rawResponse: { stop_reason: 'end_turn', content: [{ type: 'thinking' }] },
      },
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runToolLoop(adapter, createMessages(), options, config, toolConfig);

    expect(result.response).toBe('[Completed with 1 tool calls, no text response]');
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('empty text response'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('empty text response after 1 tool calls'));
  });

  it('still warns when the model returns empty text without any tool use', async () => {
    const adapter = new LoggingAdapter();
    adapter.responses = [
      {
        hasToolCalls: false,
        toolCalls: [],
        textContent: '',
        usage: { inputTokens: 10, outputTokens: 1 },
        rawResponse: { stop_reason: 'end_turn', content: [] },
      },
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runToolLoop(adapter, createMessages(), options, config, toolConfig);

    expect(result.response).toBe('[Model returned empty response — please try again]');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('empty text response'));
  });
});
