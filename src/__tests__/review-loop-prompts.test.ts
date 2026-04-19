import { describe, it, expect } from 'vitest';
import {
  buildPlannerPrompt,
  buildDevPrompt,
  buildReviewerPrompt,
  parsePlannerOutput,
  parseReviewerOutput,
} from '../code-agents/review-loop-prompts.js';
import type { WorkItemState, ReviewFinding } from '../code-agents/review-loop-types.js';

function baseState(): WorkItemState {
  return {
    id: 'RL-010',
    title: 'X',
    prompt: 'Fix the login redirect.',
    workdir: '/repo',
    baseRef: 'HEAD',
    plannerModel: 'claude-opus',
    devModel: 'skimpyclaw',
    reviewerModel: 'claude-sonnet',
    maxIterations: 5,
    iteration: 0,
    status: 'planning',
    findings: [],
    chatMessages: [],
    timeline: [],
    createdAt: '2026-04-14T00:00:00Z',
    updatedAt: '2026-04-14T00:00:00Z',
  };
}

describe('review-loop-prompts', () => {
  it('buildPlannerPrompt includes prompt, chat, and findings', () => {
    const s = baseState();
    s.chatMessages = [
      { id: 'm-1', role: 'user', content: 'Prefer minimal diff.', createdAt: '2026-04-14T00:01Z' },
    ];
    s.findings = [
      { id: 'f-1-0', severity: 'medium', summary: 'X', status: 'open', iterationRaised: 1 },
    ];
    const p = buildPlannerPrompt(s);
    expect(p).toContain('Fix the login redirect.');
    expect(p).toContain('Prefer minimal diff.');
    expect(p).toContain('f-1-0');
    expect(p).toContain('JSON object');
  });

  it('buildDevPrompt includes only the current task and open findings', () => {
    const s = baseState();
    const task = 'Rewrite auth/login.ts to use the new helper.';
    const findings: ReviewFinding[] = [
      { id: 'f-1-0', severity: 'high', summary: 'missing null check', file: 'auth/login.ts', line: 42, status: 'open', iterationRaised: 1 },
    ];
    const p = buildDevPrompt(s, task, findings);
    expect(p).toContain('auth/login.ts');
    expect(p).toContain('missing null check');
    expect(p).toContain('Rewrite auth/login.ts');
  });

  it('buildReviewerPrompt includes diff and instructions', () => {
    const s = baseState();
    const p = buildReviewerPrompt(s, '+++ b/foo\n+new line', ['foo']);
    expect(p).toContain('+new line');
    expect(p).toContain('"verdict"');
    expect(p).toContain('foo');
  });

  it('parsePlannerOutput extracts JSON from fenced block', () => {
    const raw = 'thinking...\n```json\n{"status":"awaiting_approval","summary":"s","plan":"p"}\n```';
    const out = parsePlannerOutput(raw);
    expect(out).toEqual({ status: 'awaiting_approval', summary: 's', plan: 'p', next_dev_task: undefined, blocked_reason: undefined, resolved_finding_ids: undefined });
  });

  it('parsePlannerOutput extracts JSON from raw object', () => {
    const raw = '{"status":"blocked","summary":"s","plan":"p","blocked_reason":"stuck"}';
    const out = parsePlannerOutput(raw);
    expect(out?.status).toBe('blocked');
    expect(out?.blocked_reason).toBe('stuck');
  });

  it('parsePlannerOutput returns null on invalid JSON', () => {
    expect(parsePlannerOutput('nope')).toBeNull();
  });

  it('parsePlannerOutput returns null when required fields missing', () => {
    expect(parsePlannerOutput('{"status":"awaiting_approval"}')).toBeNull();
  });

  it('parseReviewerOutput approved with empty findings', () => {
    const out = parseReviewerOutput('{"verdict":"approved","findings":[]}');
    expect(out).toEqual({ verdict: 'approved', findings: [], note: undefined });
  });

  it('parseReviewerOutput changes_requested with findings', () => {
    const raw = '```json\n{"verdict":"changes_requested","findings":[{"severity":"low","summary":"nit"}]}\n```';
    const out = parseReviewerOutput(raw);
    expect(out?.findings).toHaveLength(1);
    expect(out?.findings[0]!.severity).toBe('low');
  });

  it('parseReviewerOutput rejects invalid severity', () => {
    expect(parseReviewerOutput('{"verdict":"changes_requested","findings":[{"severity":"xxx","summary":"s"}]}')).toBeNull();
  });

  it('parsePlannerOutput prefers ```json fence over earlier bare fence', () => {
    const raw = 'first look at this example:\n```bash\necho hi\n```\nNow the output:\n```json\n{"status":"awaiting_approval","summary":"s","plan":"P"}\n```';
    const out = parsePlannerOutput(raw);
    expect(out?.status).toBe('awaiting_approval');
    expect(out?.plan).toBe('P');
  });

  it('parsePlannerOutput falls back to bare fence when no json fence', () => {
    const raw = '```\n{"status":"awaiting_approval","summary":"s","plan":"P"}\n```';
    const out = parsePlannerOutput(raw);
    expect(out?.plan).toBe('P');
  });

  it('parsePlannerOutput handles nested ```json fence inside plan field', () => {
    const inner = JSON.stringify({
      status: 'revising',
      summary: 's',
      plan: '## Fix\n```json\n{"foo":1}\n```\n\ndone',
      next_dev_task: 'do it',
    });
    const raw = 'Here it is:\n```json\n' + inner + '\n```';
    const out = parsePlannerOutput(raw);
    expect(out?.status).toBe('revising');
    expect(out?.next_dev_task).toBe('do it');
    expect(out?.plan).toContain('```json');
  });
});
