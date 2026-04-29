// Content Format Conversions for Different Providers

import type { ContentBlock } from '../types.js';

/**
 * Convert content array to OpenAI vision-compatible format.
 * Preserves images as data URIs for multimodal model formats.
 */
export function toOpenAIContent(content: string | ContentBlock[]): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (typeof content === 'string') return content;

  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      });
    }
  }
  return parts;
}

/**
 * Convert content blocks to Codex Responses API format.
 * Supports images via `input_image` type for multimodal models (e.g. gpt-5.2-chat).
 */
export function toCodexContent(content: string | ContentBlock[], defaultType: string): any[] {
  if (typeof content === 'string') {
    return [{ type: defaultType, text: content }];
  }

  const parts: any[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: defaultType, text: block.text });
    } else if (block.type === 'image') {
      parts.push({
        type: 'input_image',
        image_url: `data:${block.source.media_type};base64,${block.source.data}`,
      });
    }
  }
  return parts.length > 0 ? parts : [{ type: defaultType, text: '' }];
}

/**
 * Convert Anthropic tool definitions to OpenAI/Codex function format for Responses API.
 */
export function toCodexToolDefinitions(tools: any[]): any[] {
  return tools.map(t => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.input_schema && t.input_schema.type ? t.input_schema : { type: 'object', properties: {} },
  }));
}
