import { describe, it, expect } from 'vitest';
import { toOpenAITools } from '../agent.js';

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
