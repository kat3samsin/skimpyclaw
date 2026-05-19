import { describe, expect, it, vi } from 'vitest';
import { parseCodexSSE } from '../providers/codex.js';

describe('parseCodexSSE', () => {
  it('does not warn for tool-call-only responses', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sse = [
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","call_id":"call_1","name":"Read","arguments":"{\\"path\\":\\"a.txt\\"}"}],"usage":{"input_tokens":10,"output_tokens":2}}}',
      'data: [DONE]',
    ].join('\n');

    const parsed = parseCodexSSE(sse);

    expect(parsed.outputText).toBe('');
    expect(parsed.functionCalls).toEqual([
      { callId: 'call_1', name: 'Read', arguments: '{"path":"a.txt"}' },
    ]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
