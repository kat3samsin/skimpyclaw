import { describe, expect, it } from 'vitest';
import { parseClaudeOutput, parseStreamJsonForLive } from '../code-agents/parser.js';

describe('code-agents parser', () => {
  it('parses newer Claude stream item.completed agent_message events', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: 'I will inspect the repo and report findings.' },
      }),
      JSON.stringify({ type: 'result', result: 'Final answer: done.' }),
    ].join('\n');

    const parsed = parseClaudeOutput(stdout);
    expect(parsed.text).toContain('I will inspect the repo and report findings.');
    expect(parsed.text).toContain('Final answer: done.');
    expect(parsed.text).not.toContain('thread.started');
  });

  it('builds readable live output from mixed legacy/new stream events', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Legacy format message' }] },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'New format message' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'tool_use', name: 'Read', input: { file_path: 'src/agent.ts' } },
      }),
    ].join('\n');

    const live = parseStreamJsonForLive(stdout);
    expect(live).toContain('Legacy format message');
    expect(live).toContain('New format message');
    expect(live).toContain('[Read]');
  });
});
