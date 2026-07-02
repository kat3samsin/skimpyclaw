import { describe, expect, it } from 'vitest';
import { calculateUsageCost, sanitizeLangfusePayload } from '../langfuse.js';

describe('calculateUsageCost', () => {
  it('resolves codex provider model names', () => {
    const cost = calculateUsageCost('codex/codex-5.3', 1_000_000, 1_000_000);

    expect(cost.inputCost).toBe(1.75);
    expect(cost.outputCost).toBe(14);
    expect(cost.totalCost).toBe(15.75);
  });

  it('resolves codex5.3 alias pricing', () => {
    const cost = calculateUsageCost('codex5.3', 1_000_000, 1_000_000);

    expect(cost.inputCost).toBe(1.75);
    expect(cost.outputCost).toBe(14);
    expect(cost.totalCost).toBe(15.75);
  });

  it('resolves codex5.5 alias pricing', () => {
    const cost = calculateUsageCost('codex5.5', 1_000_000, 1_000_000);

    expect(cost.inputCost).toBe(5);
    expect(cost.outputCost).toBe(30);
    expect(cost.totalCost).toBe(35);
  });

  it('resolves codex5.1 model pricing', () => {
    const cost = calculateUsageCost('codex/gpt-5.1-codex', 1_000_000, 1_000_000);

    expect(cost.inputCost).toBe(1.25);
    expect(cost.outputCost).toBe(10);
    expect(cost.totalCost).toBe(11.25);
  });
});

describe('sanitizeLangfusePayload', () => {
  it('replaces base64 data URIs with compact media placeholders', () => {
    const sanitized = sanitizeLangfusePayload('data:image/png;base64,aGVsbG8=');

    expect(sanitized).toBe('[redacted data URI: image/png, approx 5 bytes]');
  });

  it('preserves surrounding text while removing embedded base64 media', () => {
    const sanitized = sanitizeLangfusePayload(
      'before data:image/jpeg;base64,Zm9vYmFy after'
    );

    expect(sanitized).toBe(
      'before [redacted data URI: image/jpeg, approx 6 bytes] after'
    );
    expect(sanitized).not.toContain('data:image/jpeg;base64');
    expect(sanitized).not.toContain('Zm9vYmFy');
  });

  it('sanitizes nested arrays and objects without mutating the original payload', () => {
    const original = {
      input: [
        { type: 'text', text: 'keep me' },
        { image_url: { url: 'data:image/webp;base64,AAAA' } },
      ],
      metadata: {
        preview: 'data:application/pdf;base64,AAECAw==',
      },
    };

    const sanitized = sanitizeLangfusePayload(original);

    expect(sanitized).toEqual({
      input: [
        { type: 'text', text: 'keep me' },
        { image_url: { url: '[redacted data URI: image/webp, approx 3 bytes]' } },
      ],
      metadata: {
        preview: '[redacted data URI: application/pdf, approx 4 bytes]',
      },
    });
    expect(original).toEqual({
      input: [
        { type: 'text', text: 'keep me' },
        { image_url: { url: 'data:image/webp;base64,AAAA' } },
      ],
      metadata: {
        preview: 'data:application/pdf;base64,AAECAw==',
      },
    });
  });

  it('leaves non-media strings unchanged', () => {
    const payload = {
      token: 'YWJjZA==',
      url: 'https://example.com/image.png',
    };

    expect(sanitizeLangfusePayload(payload)).toEqual(payload);
  });
});
