import { describe, it, expect } from 'vitest';
import { parseDualOutput, validatePrReviewOutput } from '../cron.js';

describe('parseDualOutput', () => {
  it('returns full response as text when no delimiters present', () => {
    const response = 'Hello, this is a regular response with no delimiters.';
    const result = parseDualOutput(response);
    expect(result.voice).toBeNull();
    expect(result.text).toBe(response);
  });

  it('parses voice and text portions correctly', () => {
    const response = `Some preamble
---VOICE---
Good morning Katrina. You have three meetings today.
---TEXT---
## Morning Briefing

- **9am** standup
- **11am** [PR review](https://github.com/...)
- **2pm** 1:1 with manager`;

    const result = parseDualOutput(response);
    expect(result.voice).toBe('Good morning Katrina. You have three meetings today.');
    expect(result.text).toContain('## Morning Briefing');
    expect(result.text).toContain('[PR review]');
  });

  it('returns null voice when voice section is empty', () => {
    const response = `---VOICE---
---TEXT---
Some text content here.`;

    const result = parseDualOutput(response);
    expect(result.voice).toBeNull();
    expect(result.text).toBe('Some text content here.');
  });

  it('handles only VOICE marker without TEXT marker', () => {
    const response = `---VOICE---
Just voice content here, no text marker.`;

    const result = parseDualOutput(response);
    expect(result.voice).toBeNull();
    expect(result.text).toBe(response);
  });

  it('handles only TEXT marker without VOICE marker', () => {
    const response = `---TEXT---
Just text content here, no voice marker.`;

    const result = parseDualOutput(response);
    expect(result.voice).toBeNull();
    expect(result.text).toBe(response);
  });

  it('handles multiline voice content', () => {
    const response = `---VOICE---
Good morning Katrina.
You have three meetings today.
The first one is at nine.
---TEXT---
Full detailed text here.`;

    const result = parseDualOutput(response);
    expect(result.voice).toBe(
      'Good morning Katrina.\nYou have three meetings today.\nThe first one is at nine.'
    );
    expect(result.text).toBe('Full detailed text here.');
  });

  it('falls back to full response if text portion is empty', () => {
    const fullResponse = `---VOICE---
Voice content here
---TEXT---`;

    const result = parseDualOutput(fullResponse);
    expect(result.voice).toBe('Voice content here');
    expect(result.text).toBe(fullResponse);
  });
});

describe('validatePrReviewOutput', () => {
  it('returns null for NO_CANDIDATES result', () => {
    const output = 'No PRs found.\n[PR_REVIEW_RESULT: NO_CANDIDATES]';
    expect(validatePrReviewOutput(output)).toBeNull();
  });

  it('returns null when candidates were reviewed with code_with_agent', () => {
    const output = 'Reviewed 3 PRs.\n[PR_REVIEW_RESULT: CANDIDATES=3 CODE_AGENT_CALLS=3 BLOCKED=0]';
    expect(validatePrReviewOutput(output)).toBeNull();
  });

  it('returns null when all candidates are blocked', () => {
    const output = 'All blocked.\n[PR_REVIEW_RESULT: CANDIDATES=2 CODE_AGENT_CALLS=0 BLOCKED=2]';
    expect(validatePrReviewOutput(output)).toBeNull();
  });

  it('returns alert when candidates exist but no code_with_agent calls', () => {
    const output = 'Inline review.\n[PR_REVIEW_RESULT: CANDIDATES=3 CODE_AGENT_CALLS=0 BLOCKED=0]';
    const result = validatePrReviewOutput(output);
    expect(result).not.toBeNull();
    expect(result).toContain('code_with_agent was never called');
    expect(result).toContain('3 PR candidate');
  });

  it('returns alert when result line is missing entirely', () => {
    const output = 'The agent just rambled about PRs without following the prompt.';
    const result = validatePrReviewOutput(output);
    expect(result).not.toBeNull();
    expect(result).toContain('Missing [PR_REVIEW_RESULT]');
  });

  it('returns null when some candidates reviewed and some blocked', () => {
    const output = '[PR_REVIEW_RESULT: CANDIDATES=4 CODE_AGENT_CALLS=2 BLOCKED=2]';
    expect(validatePrReviewOutput(output)).toBeNull();
  });

  it('returns alert when partially blocked but zero calls', () => {
    const output = '[PR_REVIEW_RESULT: CANDIDATES=3 CODE_AGENT_CALLS=0 BLOCKED=1]';
    const result = validatePrReviewOutput(output);
    expect(result).not.toBeNull();
    expect(result).toContain('code_with_agent was never called');
  });
});

describe('cron job tool injection', () => {
  it('isCronJob field exists on ExecuteToolContext', () => {
    // Verify the field is part of the type (compile-time check via assignment)
    const ctx: import('../tools/execute-context.js').ExecuteToolContext = {
      isCronJob: true,
    };
    expect(ctx.isCronJob).toBe(true);
  });

  it('isCronJob defaults to undefined when not set', () => {
    const ctx: import('../tools/execute-context.js').ExecuteToolContext = {};
    expect(ctx.isCronJob).toBeUndefined();
  });
});
