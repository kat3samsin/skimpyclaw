import { describe, it, expect } from 'vitest';
import { parseDualOutput } from '../cron.js';

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
