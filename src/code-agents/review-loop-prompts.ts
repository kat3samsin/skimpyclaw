import type {
  WorkItemState,
  ReviewFinding,
  PlannerOutput,
  ReviewerOutput,
  FindingSeverity,
} from './review-loop-types.js';

const VALID_SEVERITIES: FindingSeverity[] = ['low', 'medium', 'high'];

export function buildPlannerPrompt(state: WorkItemState): string {
  const chat = state.chatMessages.length
    ? state.chatMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')
    : '(none)';
  const findings = state.findings.length
    ? state.findings.map(f => `- [${f.id}] (${f.severity}) ${f.summary}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : ''} [${f.status}]`).join('\n')
    : '(none)';
  return [
    'You are the PLANNER for an iterative review loop. You decompose the user goal into one concrete dev task per iteration, or declare the work blocked.',
    '',
    `ORIGINAL GOAL:\n${state.prompt}`,
    '',
    `ITERATION: ${state.iteration} of ${state.maxIterations}`,
    '',
    `USER CHAT HISTORY:\n${chat}`,
    '',
    `OPEN FINDINGS:\n${findings}`,
    '',
    state.currentPlan ? `PREVIOUS PLAN:\n${state.currentPlan}\n` : '',
    'Return ONLY a JSON object matching this shape (no prose outside the JSON):',
    '```json',
    '{',
    '  "status": "awaiting_approval" | "revising" | "blocked",',
    '  "summary": "one-paragraph state summary",',
    '  "plan": "markdown plan shown to the user",',
    '  "next_dev_task": "concrete task for the dev agent (required when status=revising)",',
    '  "blocked_reason": "why the work cannot proceed (required when status=blocked)",',
    '  "resolved_finding_ids": ["f-1-0"]',
    '}',
    '```',
    'Rules:',
    '- Use "awaiting_approval" on the very first plan or after substantive user chat changes the plan.',
    '- Use "revising" to issue a dev task in response to reviewer findings.',
    '- Use "blocked" if you cannot make progress (conflicting findings, external dependency, etc.).',
  ].join('\n');
}

export function buildDevPrompt(state: WorkItemState, task: string, findings: ReviewFinding[]): string {
  const findingsBlock = findings.length
    ? findings.map(f => `- [${f.id}] (${f.severity}) ${f.summary}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : ''}`).join('\n')
    : '(no open findings — this is the initial implementation)';
  return [
    'You are the DEV agent for an iterative review loop.',
    '',
    `ORIGINAL GOAL:\n${state.prompt}`,
    '',
    `YOUR TASK FOR THIS ITERATION (${state.iteration + 1} of ${state.maxIterations}):\n${task}`,
    '',
    `OPEN REVIEWER FINDINGS:\n${findingsBlock}`,
    '',
    `WORKDIR: ${state.workdir}`,
    '',
    'Constraints:',
    '- Modify code and tests.',
    '- Do NOT change unrelated files.',
    '- When done, ensure the repo builds and tests pass.',
    '- Report the list of files you changed in your final message.',
  ].join('\n');
}

export function buildReviewerPrompt(state: WorkItemState, diff: string, changedFiles: string[]): string {
  const filesList = changedFiles.length ? changedFiles.join('\n') : '(none)';
  return [
    'You are the REVIEWER for an iterative review loop. You review ONLY the delta shown below — do not re-litigate code outside this diff.',
    '',
    `ORIGINAL GOAL:\n${state.prompt}`,
    '',
    `CHANGED FILES:\n${filesList}`,
    '',
    `DIFF:\n${diff}`,
    '',
    'Return ONLY a JSON object matching this shape (no prose outside the JSON):',
    '```json',
    '{',
    '  "verdict": "approved" | "changes_requested",',
    '  "findings": [',
    '    { "severity": "low" | "medium" | "high", "summary": "...", "file": "path", "line": 42 }',
    '  ],',
    '  "note": "optional overall comment"',
    '}',
    '```',
    'If you have no findings, return verdict="approved" with findings=[].',
    'Do not suggest fixes — only describe the problem, file, and line.',
  ].join('\n');
}

function extractJsonBlock(raw: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) return fence[1]!.trim();
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function parsePlannerOutput(raw: string): PlannerOutput | null {
  const block = extractJsonBlock(raw);
  if (!block) return null;
  let obj: any;
  try { obj = JSON.parse(block); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!['awaiting_approval', 'revising', 'blocked'].includes(obj.status)) return null;
  if (typeof obj.summary !== 'string' || typeof obj.plan !== 'string') return null;
  if (obj.status === 'revising' && typeof obj.next_dev_task !== 'string') return null;
  if (obj.status === 'blocked' && typeof obj.blocked_reason !== 'string') return null;
  return {
    status: obj.status,
    summary: obj.summary,
    plan: obj.plan,
    next_dev_task: typeof obj.next_dev_task === 'string' ? obj.next_dev_task : undefined,
    blocked_reason: typeof obj.blocked_reason === 'string' ? obj.blocked_reason : undefined,
    resolved_finding_ids: Array.isArray(obj.resolved_finding_ids)
      ? obj.resolved_finding_ids.filter((x: unknown) => typeof x === 'string')
      : undefined,
  };
}

export function parseReviewerOutput(raw: string): ReviewerOutput | null {
  const block = extractJsonBlock(raw);
  if (!block) return null;
  let obj: any;
  try { obj = JSON.parse(block); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!['approved', 'changes_requested'].includes(obj.verdict)) return null;
  if (!Array.isArray(obj.findings)) return null;
  const findings: ReviewerOutput['findings'] = [];
  for (const f of obj.findings) {
    if (!f || typeof f !== 'object') return null;
    if (!VALID_SEVERITIES.includes(f.severity)) return null;
    if (typeof f.summary !== 'string') return null;
    findings.push({
      severity: f.severity,
      summary: f.summary,
      file: typeof f.file === 'string' ? f.file : undefined,
      line: typeof f.line === 'number' ? f.line : undefined,
    });
  }
  return {
    verdict: obj.verdict,
    findings,
    note: typeof obj.note === 'string' ? obj.note : undefined,
  };
}
