// Multimodal helpers: convert ChatMessage + ImageAttachment into provider-specific payload formats.

import type { ChatMessage, ImageAttachment } from './types.js';

export function stripImageData(images: ImageAttachment[] | undefined): ImageAttachment[] | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map(({ dataBase64, ...rest }) => rest);
}

export function hasImageData(images: ImageAttachment[] | undefined): boolean {
  return Boolean(images?.some((img) => img.kind === 'image' && !!img.dataBase64));
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export function toOpenAIChatMessages(
  messages: ChatMessage[]
): Array<{ role: 'system' | 'user' | 'assistant'; content: string | OpenAIContentPart[] }> {
  return messages.map((m) => ({
    role: m.role,
    content: toOpenAIContent(m.content, m.attachments),
  }));
}

export function toOpenAIContent(text: string, images?: ImageAttachment[]): string | OpenAIContentPart[] {
  const usable = (images || []).filter((img) => img.kind === 'image' && !!img.dataBase64);
  if (usable.length === 0) return text;

  const parts: OpenAIContentPart[] = [];
  if (text.trim()) parts.push({ type: 'text', text });

  for (const img of usable) {
    // Use data URL to avoid hosting/URL expiry issues.
    const url = `data:${img.mimeType};base64,${img.dataBase64}`;
    parts.push({ type: 'image_url', image_url: { url, detail: 'auto' } });
  }

  return parts;
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: AnthropicMediaType; data: string } };

type AnthropicMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function coerceAnthropicMediaType(mimeType: string): AnthropicMediaType {
  switch (mimeType) {
    case 'image/jpeg':
    case 'image/png':
    case 'image/gif':
    case 'image/webp':
      return mimeType;
    default:
      return 'image/jpeg';
  }
}

export function toAnthropicMessages(messages: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }> {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: toAnthropicContent(m.content, m.attachments),
    }));
}

export function toAnthropicContent(text: string, images?: ImageAttachment[]): string | AnthropicContentBlock[] {
  const usable = (images || []).filter((img) => img.kind === 'image' && !!img.dataBase64);
  if (usable.length === 0) return text;

  const blocks: AnthropicContentBlock[] = [];
  if (text.trim()) blocks.push({ type: 'text', text });

  for (const img of usable) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: coerceAnthropicMediaType(img.mimeType), data: img.dataBase64! },
    });
  }

  return blocks;
}
