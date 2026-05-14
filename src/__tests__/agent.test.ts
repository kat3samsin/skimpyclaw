import { describe, it, expect, beforeEach } from 'vitest';
import { toOpenAITools, buildSystemParam, addToolCacheBreakpoint, setUsingOAuth, formatMemoryEntry } from '../agent.js';

describe('toOpenAITools', () => {
  it('converts Anthropic tool format to OpenAI function format', () => {
    const anthropicTools = [
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Path to file' },
          },
          required: ['file_path'],
        },
      },
    ];

    const result = toOpenAITools(anthropicTools);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'function',
      function: {
        name: 'Read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Path to file' },
          },
          required: ['file_path'],
        },
      },
    });
  });

  it('converts multiple tools', () => {
    const tools = [
      { name: 'Read', description: 'Read', input_schema: { type: 'object', properties: {} } },
      { name: 'Write', description: 'Write', input_schema: { type: 'object', properties: {} } },
      { name: 'Bash', description: 'Bash', input_schema: { type: 'object', properties: {} } },
    ];

    const result = toOpenAITools(tools);

    expect(result).toHaveLength(3);
    expect(result.every((t: any) => t.type === 'function')).toBe(true);
    expect(result.map((t: any) => t.function.name)).toEqual(['Read', 'Write', 'Bash']);
  });

  it('preserves input_schema as parameters unchanged', () => {
    const schema = {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['command'],
    };

    const result = toOpenAITools([{ name: 'Bash', description: 'Run command', input_schema: schema }]);

    expect(result[0].function.parameters).toBe(schema); // same reference, not deep-copied
  });

  it('handles empty array', () => {
    expect(toOpenAITools([])).toEqual([]);
  });
});

describe('buildSystemParam', () => {
  beforeEach(() => {
    setUsingOAuth(false);
  });

  it('returns undefined for empty content', () => {
    expect(buildSystemParam(undefined)).toBeUndefined();
    expect(buildSystemParam(undefined, true)).toBeUndefined();
  });

  it('returns plain string when caching disabled and not OAuth', () => {
    const result = buildSystemParam('Hello system');
    expect(result).toBe('Hello system');
  });

  it('returns plain string when caching explicitly disabled', () => {
    const result = buildSystemParam('Hello system', false);
    expect(result).toBe('Hello system');
  });

  it('returns array with cache_control when caching enabled (API key mode)', () => {
    const result = buildSystemParam('Hello system', true) as any[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'text',
      text: 'Hello system',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('returns 3-block array with cache_control on last block (OAuth mode)', () => {
    setUsingOAuth(true);
    const result = buildSystemParam('My prompt', true) as any[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    // First two blocks: no cache_control
    expect(result[0].cache_control).toBeUndefined();
    expect(result[1].cache_control).toBeUndefined();
    // Last block: has cache_control
    expect(result[2].cache_control).toEqual({ type: 'ephemeral' });
    expect(result[2].text).toBe('My prompt');
  });

  it('returns 3-block array without cache_control when caching disabled (OAuth mode)', () => {
    setUsingOAuth(true);
    const result = buildSystemParam('My prompt', false) as any[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    expect(result[0].cache_control).toBeUndefined();
    expect(result[1].cache_control).toBeUndefined();
    expect(result[2].cache_control).toBeUndefined();
  });
});

describe('addToolCacheBreakpoint', () => {
  it('adds cache_control to the last tool definition', () => {
    const tools = [
      { name: 'Read', description: 'Read' },
      { name: 'Write', description: 'Write' },
      { name: 'Bash', description: 'Bash' },
    ];

    addToolCacheBreakpoint(tools);

    expect((tools[0] as any).cache_control).toBeUndefined();
    expect((tools[1] as any).cache_control).toBeUndefined();
    expect((tools[2] as any).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('handles single tool', () => {
    const tools = [{ name: 'Read', description: 'Read' }];
    addToolCacheBreakpoint(tools);
    expect((tools[0] as any).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('handles empty array without error', () => {
    const tools: any[] = [];
    expect(() => addToolCacheBreakpoint(tools)).not.toThrow();
  });
});

describe('formatMemoryEntry', () => {
  it('truncates oversized user and assistant content before writing memory logs', () => {
    const entry = formatMemoryEntry('u'.repeat(25_000), 'a'.repeat(25_000), []);

    expect(entry).toContain('**User:**');
    expect(entry).toContain('**Assistant:**');
    expect(entry).toContain('[truncated 5000 chars]');
    expect(entry.length).toBeLessThan(41_000);
  });

  it('caps large tool-call lists in memory logs', () => {
    const tools = Array.from({ length: 55 }, (_, i) => `Tool ${i} ${'x'.repeat(2_000)}`);
    const entry = formatMemoryEntry('user', 'assistant', tools);

    expect(entry).toContain('**Tools used (55):**');
    expect(entry).toContain('[truncated 5 additional tool calls]');
    expect(entry).toContain('[truncated 1007 chars]');
  });

  it('redacts token-shaped secrets before writing memory logs', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const entry = formatMemoryEntry(`user ${token}`, `assistant sk-${'b'.repeat(24)}`, []);

    expect(entry).not.toContain(token);
    expect(entry).not.toContain(`sk-${'b'.repeat(24)}`);
    expect(entry).toContain('[REDACTED_SECRET]');
  });
});
