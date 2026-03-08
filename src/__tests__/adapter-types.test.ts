/**
 * Compile-time validation tests for adapter interfaces.
 */

import { describe, it, expect } from 'vitest';
import type {
  ProviderAdapter,
  NormalizedResponse,
  NormalizedToolCall,
  ProviderMessages,
  CompactionResult,
} from '../providers/adapter.js';
import { buildToolLogEntry, logIteration } from '../providers/loop-utils.js';

describe('ProviderAdapter interface', () => {
  it('should define correct structure for NormalizedResponse', () => {
    const response: NormalizedResponse = {
      hasToolCalls: false,
      toolCalls: [],
      textContent: 'test response',
      usage: { inputTokens: 100, outputTokens: 50 },
      rawResponse: {},
    };
    expect(response.hasToolCalls).toBe(false);
    expect(response.textContent).toBe('test response');
  });

  it('should define correct structure for NormalizedToolCall', () => {
    const toolCall: NormalizedToolCall = {
      id: 'call_123',
      name: 'testTool',
      args: { param: 'value' },
      rawArgs: '{"param":"value"}',
    };
    expect(toolCall.name).toBe('testTool');
    expect(toolCall.args.param).toBe('value');
  });

  it('should define correct structure for ProviderMessages', () => {
    const messages: ProviderMessages = {
      messages: [{ role: 'user', content: 'test' }],
      systemParam: 'system prompt',
    };
    expect(messages.messages).toHaveLength(1);
    expect(messages.systemParam).toBe('system prompt');
  });

  it('should define correct structure for CompactionResult', () => {
    const result: CompactionResult<any> = {
      messages: [],
      compacted: true,
      method: 'llm',
    };
    expect(result.compacted).toBe(true);
    expect(result.method).toBe('llm');
  });
});

describe('loop-utils', () => {
  it('buildToolLogEntry should format tool calls correctly', () => {
    const log = buildToolLogEntry('Read', 'file.txt', 'file contents here');
    expect(log).toContain('Read');
    expect(log).toContain('file.txt');
    expect(log).toContain('file contents here');
  });

  it('buildToolLogEntry should truncate long inputs and outputs', () => {
    const longInput = 'a'.repeat(200);
    const longOutput = 'b'.repeat(300);
    const log = buildToolLogEntry('Write', longInput, longOutput);
    expect(log.length).toBeLessThan(320);
    expect(log).toContain('...');
  });

  it('logIteration should not throw', () => {
    expect(() => logIteration('test', 0, 10, 'model-id')).not.toThrow();
  });
});
