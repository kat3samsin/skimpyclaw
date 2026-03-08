import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatOptions, Config } from '../types.js';
import { OpenAIAdapter } from '../providers/adapters/openai-adapter.js';

const { mockGetOpenAIClient, mockRecordOpenAIUsage } = vi.hoisted(() => ({
  mockGetOpenAIClient: vi.fn(),
  mockRecordOpenAIUsage: vi.fn(),
}));

vi.mock('../providers/openai.js', () => ({
  getOpenAIClient: mockGetOpenAIClient,
  recordOpenAIUsage: mockRecordOpenAIUsage,
}));

describe('OpenAIAdapter', () => {
  let adapter: OpenAIAdapter;
  let config: Config;
  let options: ChatOptions;

  beforeEach(() => {
    adapter = new OpenAIAdapter('openrouter');
    config = {
      gateway: { port: 18790, mode: 'local' },
      agents: { default: 'main', list: {} },
      models: { providers: {}, aliases: {} },
      channels: { telegram: { enabled: false, token: 't', allowFrom: [] } },
      cron: { jobs: [] },
      heartbeat: { intervalMs: 300000, prompt: 'HEARTBEAT' },
    } as Config;
    options = { model: 'openrouter/openai/gpt-4o' };
    mockGetOpenAIClient.mockReset();
    mockRecordOpenAIUsage.mockReset();
  });

  it('has correct name with provider prefix', () => {
    expect(adapter.name).toBe('openai:openrouter');
  });

  it('disables MCP tool discovery', () => {
    expect(adapter.getToolDefinitionOptions()).toEqual({ includeMcp: false });
  });

  describe('buildMessages', () => {
    it('maps all messages including system to OpenAI format', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];

      const result = adapter.buildMessages(messages, options, config);

      // OpenAI keeps system messages in the messages array (unlike Codex/Anthropic)
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0]).toEqual({ role: 'system', content: 'System prompt' });
      expect(result.messages[1]).toEqual({ role: 'user', content: 'Hello' });
      expect(result.messages[2]).toEqual({ role: 'assistant', content: 'Hi there' });
      expect(result.systemParam).toBeUndefined();
    });
  });

  describe('buildToolDefs', () => {
    it('converts Anthropic-format tool defs to OpenAI function calling format', () => {
      const toolDefs = [
        { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
      ];

      const result = adapter.buildToolDefs(toolDefs, config);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('function');
      expect(result[0].function.name).toBe('Read');
      expect(result[0].function.description).toBe('Read a file');
      expect(result[0].function.parameters).toEqual(toolDefs[0].input_schema);
    });
  });

  describe('call', () => {
    it('returns normalized response with no tool calls', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{
          message: { content: 'Hello!', tool_calls: null },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
      mockGetOpenAIClient.mockReturnValue({ chat: { completions: { create: mockCreate } } });

      const providerMessages = {
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const result = await adapter.call(providerMessages, [], options, config);

      expect(result.hasToolCalls).toBe(false);
      expect(result.textContent).toBe('Hello!');
      expect(result.toolCalls).toHaveLength(0);
      expect(result.usage?.inputTokens).toBe(100);
      expect(result.usage?.outputTokens).toBe(20);
    });

    it('normalizes tool calls from OpenAI response', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: null,
            tool_calls: [
              { id: 'call_1', function: { name: 'Read', arguments: '{"path":"/a.ts"}' } },
              { id: 'call_2', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 200, completion_tokens: 50 },
      });
      mockGetOpenAIClient.mockReturnValue({ chat: { completions: { create: mockCreate } } });

      const providerMessages = { messages: [] };

      const result = await adapter.call(providerMessages, [], options, config);

      expect(result.hasToolCalls).toBe(true);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].id).toBe('call_1');
      expect(result.toolCalls[0].name).toBe('Read');
      expect(result.toolCalls[0].args).toEqual({ path: '/a.ts' });
      expect(result.toolCalls[0].rawArgs).toBe('{"path":"/a.ts"}');
      expect(result.toolCalls[1].name).toBe('Bash');
    });

    it('strips <think> blocks from final text responses', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{
          message: { content: '<think>reasoning here</think>\nActual answer', tool_calls: null },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      });
      mockGetOpenAIClient.mockReturnValue({ chat: { completions: { create: mockCreate } } });

      const result = await adapter.call({ messages: [] }, [], options, config);
      expect(result.textContent).toBe('Actual answer');
    });

    it('handles missing message in response', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: null, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 0 },
      });
      mockGetOpenAIClient.mockReturnValue({ chat: { completions: { create: mockCreate } } });

      const result = await adapter.call({ messages: [] }, [], options, config);

      expect(result.hasToolCalls).toBe(false);
      expect(result.textContent).toBe('');
      expect(result.toolCalls).toHaveLength(0);
    });

    it('handles malformed tool call arguments', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: null,
            tool_calls: [
              { id: 'call_1', function: { name: 'Read', arguments: 'not-json' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      });
      mockGetOpenAIClient.mockReturnValue({ chat: { completions: { create: mockCreate } } });

      const result = await adapter.call({ messages: [] }, [], options, config);

      expect(result.toolCalls[0].args).toEqual({});
      expect(result.toolCalls[0].rawArgs).toBe('not-json');
    });

    it('throws when client is not initialized', async () => {
      mockGetOpenAIClient.mockReturnValue(undefined);

      await expect(adapter.call({ messages: [] }, [], options, config))
        .rejects.toThrow('OpenAI client not initialized for provider: openrouter');
    });
  });

  describe('appendAssistantResponse', () => {
    it('appends assistant message with tool_calls from completion', () => {
      const providerMessages = { messages: [] as any[] };
      const rawResponse = {
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', function: { name: 'Read', arguments: '{}' } }],
          },
        }],
      };

      adapter.appendAssistantResponse(providerMessages, rawResponse);

      expect(providerMessages.messages).toHaveLength(1);
      expect(providerMessages.messages[0].role).toBe('assistant');
      expect(providerMessages.messages[0].tool_calls).toEqual(rawResponse.choices[0].message.tool_calls);
    });

    it('preserves reasoning_content for Kimi compatibility', () => {
      const providerMessages = { messages: [] as any[] };
      const rawResponse = {
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', function: { name: 'Read', arguments: '{}' } }],
            reasoning_content: 'thinking...',
          },
        }],
      };

      adapter.appendAssistantResponse(providerMessages, rawResponse);

      expect(providerMessages.messages[0].reasoning_content).toBe('thinking...');
    });

    it('handles missing message gracefully', () => {
      const providerMessages = { messages: [] as any[] };
      adapter.appendAssistantResponse(providerMessages, { choices: [{ message: null }] });
      expect(providerMessages.messages).toHaveLength(0);
    });
  });

  describe('appendToolResult', () => {
    it('appends tool result in OpenAI format', () => {
      const providerMessages = { messages: [] as any[] };
      adapter.appendToolResult(providerMessages, 'call_1', 'file contents here');

      expect(providerMessages.messages).toHaveLength(1);
      expect(providerMessages.messages[0]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'file contents here',
      });
    });
  });

  describe('recordUsage', () => {
    it('delegates to recordOpenAIUsage with correct params', () => {
      adapter.recordUsage('gpt-4o', { inputTokens: 100, outputTokens: 50 }, 'telegram', 'agent-1');

      expect(mockRecordOpenAIUsage).toHaveBeenCalledWith({
        model: 'gpt-4o',
        provider: 'openrouter',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        trigger: 'telegram',
        agentId: 'agent-1',
      });
    });
  });
});
