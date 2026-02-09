import { describe, expect, it } from 'vitest';
import { toAnthropicContent, toOpenAIContent } from '../multimodal.js';

describe('multimodal payload building', () => {
  it('keeps text-only content as string', () => {
    expect(toOpenAIContent('hello')).toBe('hello');
    expect(toAnthropicContent('hello')).toBe('hello');
  });

  it('builds OpenAI content parts with data URLs for images', () => {
    const content = toOpenAIContent('look', [
      { kind: 'image', id: 'tg1', mimeType: 'image/png', dataBase64: 'AAA=' },
    ]);
    expect(Array.isArray(content)).toBe(true);
    const parts = content as any[];
    expect(parts[0]).toEqual({ type: 'text', text: 'look' });
    expect(parts[1].type).toBe('image_url');
    expect(parts[1].image_url.url).toBe('data:image/png;base64,AAA=');
  });

  it('builds Anthropic content blocks with base64 image sources', () => {
    const content = toAnthropicContent('look', [
      { kind: 'image', id: 'tg1', mimeType: 'image/jpeg', dataBase64: 'BBB=' },
    ]);
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as any[];
    expect(blocks[0]).toEqual({ type: 'text', text: 'look' });
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB=' },
    });
  });
});

