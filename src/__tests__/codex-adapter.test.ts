import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatOptions, Config } from '../types.js';
import { CodexAdapter } from '../providers/adapters/codex-adapter.js';

const { mockCodexFetch, mockParseCodexSSE, mockRecordCodexUsage } = vi.hoisted(() => ({
  mockCodexFetch: vi.fn(),
  mockParseCodexSSE: vi.fn(),
  mockRecordCodexUsage: vi.fn(),
}));

vi.mock('../providers/codex.js', () => ({
  codexFetch: mockCodexFetch,
  parseCodexSSE: mockParseCodexSSE,
  recordCodexUsage: mockRecordCodexUsage,
}));

describe('CodexAdapter', () => {
  let adapter: CodexAdapter;
  let config: Config;
  let options: ChatOptions;

  beforeEach(() => {
    adapter = new CodexAdapter();
    config = {
      gateway: { port: 18790, mode: 'local' },
      agents: { default: 'main', list: {} },
      models: { providers: {}, aliases: {} },
      channels: { telegram: { enabled: false, token: 't', allowFrom: [] } },
      cron: { jobs: [] },
      heartbeat: { intervalMs: 300000, prompt: 'HEARTBEAT' },
    } as Config;
    options = { model: 'codex/gpt-5.5' };
    mockCodexFetch.mockReset();
    mockParseCodexSSE.mockReset();
  });

  it('builds Codex messages and extracts system instructions', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];

    const result = adapter.buildMessages(messages, options, config);

    expect(result.systemParam).toBe('System prompt');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].type).toBe('message');
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content[0].type).toBe('input_text');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[1].content[0].type).toBe('output_text');
  });

  it('normalizes function calls when arguments are missing', async () => {
    mockCodexFetch.mockResolvedValue('sse');
    mockParseCodexSSE.mockReturnValue({
      outputText: '',
      functionCalls: [{ callId: 'fc_1', name: 'Read', arguments: undefined }],
      response: { usage: { input_tokens: 10, output_tokens: 5 }, output: [] },
    });

    const providerMessages = {
      messages: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }],
      systemParam: 'sys',
    };

    const result = await adapter.call(providerMessages, [], options, config);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe('fc_1');
    expect(result.toolCalls[0].rawArgs).toBe('{}');
    expect(result.toolCalls[0].args).toEqual({});
  });

  it('appends assistant output items and function_call_output results', () => {
    const providerMessages = { messages: [] as any[] };
    adapter.appendAssistantResponse(providerMessages, {
      output: [
        { type: 'function_call', call_id: 'fc_1', name: 'Read', arguments: '{}' },
      ],
    });
    adapter.appendToolResult(providerMessages, 'fc_1', 'ok');

    expect(providerMessages.messages).toHaveLength(2);
    expect(providerMessages.messages[0].type).toBe('function_call');
    expect(providerMessages.messages[1]).toEqual({
      type: 'function_call_output',
      call_id: 'fc_1',
      output: 'ok',
    });
  });

  it('enables MCP tool discovery for Codex', () => {
    expect(adapter.getToolDefinitionOptions()).toEqual({ includeMcp: true });
  });

  it('passes xhigh thinking through as Codex reasoning effort', async () => {
    mockCodexFetch.mockResolvedValue('sse');
    mockParseCodexSSE.mockReturnValue({
      outputText: 'ok',
      functionCalls: [],
      response: { usage: { input_tokens: 10, output_tokens: 5 } },
    });

    await adapter.chat(
      [{ role: 'user', content: 'Use deeper reasoning' }],
      { ...options, thinking: 'xhigh' },
      config,
    );

    expect(mockCodexFetch).toHaveBeenCalledWith(expect.objectContaining({
      reasoning: { effort: 'xhigh', summary: 'auto' },
    }));
  });

  it('keeps Codex reasoning at medium by default', async () => {
    mockCodexFetch.mockResolvedValue('sse');
    mockParseCodexSSE.mockReturnValue({
      outputText: 'ok',
      functionCalls: [],
      response: { usage: { input_tokens: 10, output_tokens: 5 } },
    });

    await adapter.call({ messages: [], systemParam: 'sys' }, [], options, config);

    expect(mockCodexFetch).toHaveBeenCalledWith(expect.objectContaining({
      reasoning: { effort: 'medium', summary: 'auto' },
    }));
  });

  it('removes orphan function_call_output items before calling Codex', async () => {
    mockCodexFetch.mockResolvedValue('sse');
    mockParseCodexSSE.mockReturnValue({
      outputText: 'ok',
      functionCalls: [],
      response: { usage: { input_tokens: 10, output_tokens: 5 } },
    });

    const userMessage = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'set book status' }] };
    const providerMessages = {
      messages: [
        userMessage,
        { type: 'function_call_output', call_id: 'call_missing', output: 'tool result without matching call' },
      ],
      systemParam: 'sys',
    };

    await adapter.call(providerMessages, [], options, config);

    expect(mockCodexFetch).toHaveBeenCalledWith(expect.objectContaining({
      input: [userMessage],
    }));
    expect(providerMessages.messages).toEqual([userMessage]);
  });

  it('normalizes Codex text items before calling Codex with role-specific content types', async () => {
    mockCodexFetch.mockResolvedValue('sse');
    mockParseCodexSSE.mockReturnValue({
      outputText: 'ok',
      functionCalls: [],
      response: { usage: { input_tokens: 10, output_tokens: 5 } },
    });

    const providerMessages = {
      messages: [
        { type: 'message', role: 'user', content: 'hi' },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'output_text', text: 'previous user text' }],
        },
        { type: 'output_text', text: 'previous assistant text' },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'input_text', text: 'previous message item' }],
        },
      ],
      systemParam: 'sys',
    };

    await adapter.call(providerMessages, [], options, config);

    const body = mockCodexFetch.mock.calls[0][0];
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'previous user text' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'previous assistant text' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'previous message item' }],
      },
    ]);
    expect(providerMessages.messages).toEqual(body.input);
  });

  describe('onEmptyFinalResponse', () => {
    it('makes a finalization API call and returns text', async () => {
      mockCodexFetch.mockResolvedValue('sse-finalize');
      mockParseCodexSSE.mockReturnValue({
        outputText: 'Here is the final answer.',
        functionCalls: [],
        response: { usage: { input_tokens: 50, output_tokens: 20 } },
      });

      const providerMessages = {
        messages: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'test' }] },
          { type: 'function_call_output', call_id: 'fc_1', output: 'result data' },
        ],
        systemParam: 'System prompt',
      };

      const result = await adapter.onEmptyFinalResponse(providerMessages, [], options, config);

      expect(result).toBe('Here is the final answer.');
      expect(mockCodexFetch).toHaveBeenCalledTimes(1);
      // Should NOT include tools in the finalization body
      const body = mockCodexFetch.mock.calls[0][0];
      expect(body.tools).toBeUndefined();
      // Should include the nudge message
      const lastInput = body.input[body.input.length - 1];
      expect(lastInput.role).toBe('user');
      expect(lastInput.content[0].text).toContain('final answer');
    });

    it('returns undefined when finalization yields empty text', async () => {
      mockCodexFetch.mockResolvedValue('sse-empty');
      mockParseCodexSSE.mockReturnValue({
        outputText: '',
        functionCalls: [],
        response: { usage: { input_tokens: 10, output_tokens: 0 } },
      });

      const providerMessages = {
        messages: [],
        systemParam: 'sys',
      };

      const result = await adapter.onEmptyFinalResponse(providerMessages, [], options, config);
      expect(result).toBeUndefined();
    });
  });

  describe('call – response normalization', () => {
    it('returns textContent from outputText when no tool calls', async () => {
      mockCodexFetch.mockResolvedValue('sse');
      mockParseCodexSSE.mockReturnValue({
        outputText: 'Just text',
        functionCalls: [],
        response: { usage: { input_tokens: 100, output_tokens: 50 } },
      });

      const providerMessages = {
        messages: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        systemParam: 'sys',
      };

      const result = await adapter.call(providerMessages, [], options, config);

      expect(result.hasToolCalls).toBe(false);
      expect(result.textContent).toBe('Just text');
      expect(result.toolCalls).toHaveLength(0);
      expect(result.usage?.inputTokens).toBe(100);
      expect(result.usage?.outputTokens).toBe(50);
    });

    it('parses multiple function calls correctly', async () => {
      mockCodexFetch.mockResolvedValue('sse');
      mockParseCodexSSE.mockReturnValue({
        outputText: '',
        functionCalls: [
          { callId: 'fc_1', name: 'Read', arguments: '{"path":"/a.ts"}' },
          { callId: 'fc_2', name: 'Bash', arguments: '{"command":"ls"}' },
        ],
        response: { usage: { input_tokens: 200, output_tokens: 100 } },
      });

      const providerMessages = { messages: [], systemParam: 'sys' };
      const result = await adapter.call(providerMessages, [], options, config);

      expect(result.hasToolCalls).toBe(true);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].name).toBe('Read');
      expect(result.toolCalls[0].args).toEqual({ path: '/a.ts' });
      expect(result.toolCalls[1].name).toBe('Bash');
    });
  });
});
