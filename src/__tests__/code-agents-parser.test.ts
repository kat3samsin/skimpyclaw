import { describe, expect, it, vi } from 'vitest';
import {
  CodeAgentOutputCollector,
  MAX_STREAM_EVENT_CHARS,
  parseClaudeOutput,
  parseCodexOutput,
  parseStreamJsonForLive,
} from '../code-agents/parser.js';

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

  it('incrementally preserves final output and Claude usage across fragmented chunks', () => {
    const rawText = [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Hello from the coding agent 🦞' },
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }),
      JSON.stringify({ type: 'result', result: 'Finished', total_cost_usd: 0.01 }),
    ].join('\n');
    const raw = Buffer.from(rawText);
    const collector = new CodeAgentOutputCollector();

    for (let offset = 0; offset < raw.length; offset += 7) {
      collector.push(raw.subarray(offset, offset + 7));
    }
    collector.finish();

    expect(collector.getLiveOutput()).toBe(parseStreamJsonForLive(rawText));
    expect(collector.getClaudeOutput()).toEqual(parseClaudeOutput(rawText));
    expect(collector.getCodexOutput()).toBe(parseCodexOutput(rawText));
    expect(collector.getClaudeOutput()).toMatchObject({
      text: 'Hello from the coding agent 🦞\nFinished',
      totalCost: 0.01,
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  it('parses each completed event once while retaining bounded previews', () => {
    const lines = Array.from({ length: 200 }, (_, index) => JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: `${index}: ${'x'.repeat(80)}` },
    }));
    const parseSpy = vi.spyOn(JSON, 'parse');
    const collector = new CodeAgentOutputCollector();

    for (const line of lines) {
      collector.push(`${line}\n`);
      collector.getLiveOutput();
    }
    collector.finish();

    expect(parseSpy).toHaveBeenCalledTimes(lines.length);
    const liveOutput = collector.getLiveOutput();
    const claudeOutput = collector.getClaudeOutput().text;
    const codexOutput = collector.getCodexOutput();
    expect(liveOutput.length).toBeLessThanOrEqual(5_000);
    expect(liveOutput).toContain('199:');
    expect(claudeOutput.length).toBeLessThanOrEqual(5_000);
    expect(claudeOutput).toMatch(/^0:/);
    expect(codexOutput.length).toBeLessThanOrEqual(5_000);
    expect(codexOutput).toMatch(/^0:/);
    parseSpy.mockRestore();
  });

  it('caps an unterminated oversized event before a newline arrives', () => {
    const collector = new CodeAgentOutputCollector();

    collector.push('x'.repeat(MAX_STREAM_EVENT_CHARS * 2));

    expect((collector as unknown as { lineBuffer: string }).lineBuffer.length)
      .toBe(MAX_STREAM_EVENT_CHARS);
    collector.push('\n');
    collector.finish();
    expect(collector.getLiveOutput()).toContain('oversized stream event omitted');
  });
});
