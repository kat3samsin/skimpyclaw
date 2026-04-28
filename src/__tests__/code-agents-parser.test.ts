import { describe, expect, it } from 'vitest';
import { parseClaudeOutput, parseCodexOutput, parseStreamJsonForLive } from '../code-agents/parser.js';

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

  it('parses Codex stream-json without leaking raw events', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: 'Final review text.' },
      }),
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item_2', type: 'command_execution', command: 'git status', status: 'in_progress' },
      }),
    ].join('\n');

    const parsed = parseCodexOutput(stdout);
    expect(parsed).toBe('Final review text.');
    expect(parsed).not.toContain('thread.started');
    expect(parsed).not.toContain('command_execution');
  });
});
