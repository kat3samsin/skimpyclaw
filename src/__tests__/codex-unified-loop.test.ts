import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatOptions, Config, ToolConfig } from '../types.js';
import { runToolLoop } from '../providers/tool-loop.js';
import { CodexAdapter } from '../providers/adapters/codex-adapter.js';

const { mockCodexFetch, mockParseCodexSSE, mockExecuteTool, mockGetToolDefinitions } = vi.hoisted(() => ({
  mockCodexFetch: vi.fn(),
  mockParseCodexSSE: vi.fn(),
  mockExecuteTool: vi.fn(),
  mockGetToolDefinitions: vi.fn(),
}));

vi.mock('../providers/codex.js', () => ({
  codexFetch: mockCodexFetch,
  parseCodexSSE: mockParseCodexSSE,
  recordCodexUsage: vi.fn(),
}));

vi.mock('../tools.js', () => ({
  getToolDefinitions: mockGetToolDefinitions,
  executeTool: mockExecuteTool,
}));

vi.mock('../audit.js', () => ({
  startTrace: vi.fn().mockReturnValue('trace-1'),
  addEvent: vi.fn(),
  endTrace: vi.fn().mockResolvedValue(undefined),
}));

describe('Codex unified tool loop', () => {
  const adapter = new CodexAdapter();
  let messages: ChatMessage[];
  let options: ChatOptions;
  let config: Config;
  let toolConfig: ToolConfig;

  beforeEach(() => {
    messages = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Do the thing' },
    ];
    options = { model: 'codex/gpt-5.3-codex' };
    config = {
      gateway: { port: 18790, mode: 'local' },
      agents: { default: 'main', list: {} },
      models: { providers: {}, aliases: {} },
      channels: { telegram: { enabled: false, token: 't', allowFrom: [] } },
      cron: { jobs: [] },
      heartbeat: { intervalMs: 300000, prompt: 'HEARTBEAT' },
    } as Config;
    toolConfig = { enabled: true, allowedPaths: ['/tmp'], maxIterations: 4 };

    mockCodexFetch.mockReset();
    mockParseCodexSSE.mockReset();
    mockExecuteTool.mockReset();
    mockGetToolDefinitions.mockReset();

    mockGetToolDefinitions.mockResolvedValue([{ name: 'Read', description: 'Read', input_schema: { type: 'object' } }]);
    mockExecuteTool.mockResolvedValue('tool output');
  });

  it('runs a normal tool-call cycle and returns final assistant response', async () => {
    mockCodexFetch.mockResolvedValueOnce('sse-1').mockResolvedValueOnce('sse-2');
    mockParseCodexSSE
      .mockReturnValueOnce({
        outputText: '',
        functionCalls: [{ callId: 'fc_1', name: 'Read', arguments: '{"path":"a.txt"}' }],
        response: {
          usage: { input_tokens: 10, output_tokens: 5 },
          output: [{ type: 'function_call', call_id: 'fc_1', name: 'Read', arguments: '{"path":"a.txt"}' }],
        },
      })
      .mockReturnValueOnce({
        outputText: 'Final answer',
        functionCalls: [],
        response: { usage: { input_tokens: 8, output_tokens: 4 }, output: [] },
      });

    const result = await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(result.response).toBe('Final answer');
    expect(result.toolCalls).toHaveLength(1);
    expect(mockExecuteTool).toHaveBeenCalledWith('Read', { path: 'a.txt' }, toolConfig, undefined);
  });

  it('terminates immediately when first response has no tool calls', async () => {
    mockCodexFetch.mockResolvedValueOnce('sse-1');
    mockParseCodexSSE.mockReturnValueOnce({
      outputText: 'Done',
      functionCalls: [],
      response: { usage: { input_tokens: 3, output_tokens: 2 }, output: [] },
    });

    const result = await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(result.response).toBe('Done');
    expect(result.toolCalls).toEqual([]);
    expect(mockCodexFetch).toHaveBeenCalledTimes(1);
  });

  it('uses legacy maxIterations as a finalization checkpoint', async () => {
    toolConfig.maxIterations = 2;

    mockCodexFetch.mockResolvedValue('sse-loop');
    mockParseCodexSSE
      .mockReturnValueOnce({
        outputText: '',
        functionCalls: [{ callId: 'fc_loop_1', name: 'Read', arguments: '{"path":"a.txt"}' }],
        response: {
          usage: { input_tokens: 10, output_tokens: 5 },
          output: [{ type: 'function_call', call_id: 'fc_loop_1', name: 'Read', arguments: '{"path":"a.txt"}' }],
        },
      })
      .mockReturnValueOnce({
        outputText: '',
        functionCalls: [{ callId: 'fc_loop_2', name: 'Read', arguments: '{"path":"b.txt"}' }],
        response: {
          usage: { input_tokens: 10, output_tokens: 5 },
          output: [{ type: 'function_call', call_id: 'fc_loop_2', name: 'Read', arguments: '{"path":"b.txt"}' }],
        },
      })
      .mockReturnValueOnce({
        outputText: 'Done after configured limit',
        functionCalls: [],
        response: { usage: { input_tokens: 3, output_tokens: 2 }, output: [] },
      });

    const result = await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(result.response).toBe('Done after configured limit');
    expect(mockCodexFetch).toHaveBeenCalledTimes(3);
    expect(mockCodexFetch.mock.calls[2][0].tools).toBeUndefined();
    expect(result.usage?.total_tokens).toBe(35);
  });

  it('requests tool definitions with MCP enabled for Codex', async () => {
    mockCodexFetch.mockResolvedValueOnce('sse-1');
    mockParseCodexSSE.mockReturnValueOnce({
      outputText: 'Done',
      functionCalls: [],
      response: { usage: { input_tokens: 1, output_tokens: 1 }, output: [] },
    });

    await runToolLoop(adapter, messages, options, config, toolConfig);

    expect(mockGetToolDefinitions).toHaveBeenCalledWith(
      toolConfig,
      expect.objectContaining({ includeMcp: true }),
    );
  });
});
