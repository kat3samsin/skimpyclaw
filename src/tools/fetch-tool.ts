// Fetch tool — lightweight HTTP requests and web search without browser overhead

import type { ToolConfig } from '../types.js';

export interface FetchInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const MAX_RESPONSE_CHARS = 50_000;
const TIMEOUT_MS = 30_000;

/**
 * Strip HTML tags and decode common entities. Returns plain text.
 */
function htmlToText(html: string): string {
  return html
    // Remove script/style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Convert block elements to newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function executeFetch(input: FetchInput, _config: ToolConfig): Promise<string> {
  const { url, method = 'GET', headers = {}, body } = input;

  if (!url) return 'Error: url is required';

  try {
    new URL(url);
  } catch {
    return `Error: Invalid URL: ${url}`;
  }

  try {
    const defaultHeaders: Record<string, string> = {
      'User-Agent': 'SkimpyClaw/1.0',
    };

    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers: { ...defaultHeaders, ...headers },
      body: body || undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });

    const status = `${response.status} ${response.statusText}`;
    const contentType = response.headers.get('content-type') || '';
    let responseBody: string;

    if (contentType.includes('json')) {
      const text = await response.text();
      try {
        responseBody = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        responseBody = text;
      }
    } else if (contentType.includes('html')) {
      const html = await response.text();
      responseBody = htmlToText(html);
    } else {
      responseBody = await response.text();
    }

    if (responseBody.length > MAX_RESPONSE_CHARS) {
      responseBody = responseBody.slice(0, MAX_RESPONSE_CHARS) + `\n\n[Truncated: ${responseBody.length} chars total]`;
    }

    return `HTTP ${status}\n\n${responseBody}`;
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return `Error: Request timed out after ${TIMEOUT_MS / 1000}s`;
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
