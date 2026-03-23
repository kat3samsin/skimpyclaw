/**
 * Discord attachment processing — extensible framework for extracting text
 * content from user-uploaded files (txt, pdf, etc.) and injecting it into
 * the model context.
 */

import type { Attachment} from 'discord.js';
import { PDFParse } from 'pdf-parse';

// ── Constants ────────────────────────────────────────────────────────

/** Maximum attachment size in bytes (2 MB) */
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

/** Maximum extracted text length in characters (100 KB) */
export const MAX_TEXT_CHARS = 100_000;

/** Fetch timeout in milliseconds */
const FETCH_TIMEOUT_MS = 15_000;

// ── Types ────────────────────────────────────────────────────────────

export interface AttachmentResult {
  /** Whether extraction succeeded */
  ok: boolean;
  /** Extracted text (present when ok=true) */
  text?: string;
  /** Human-readable error (present when ok=false) */
  error?: string;
  /** Original filename */
  filename: string;
}

/** Handler for a specific file type */
export interface AttachmentHandler {
  /** File extensions this handler supports (lowercase, without dot) */
  extensions: string[];
  /** MIME type prefixes this handler supports */
  mimeTypes: string[];
  /** Extract text from the attachment buffer */
  extract(buffer: Buffer, filename: string): Promise<string>;
}

// ── Built-in handlers ────────────────────────────────────────────────

const textHandler: AttachmentHandler = {
  extensions: ['txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml', 'log', 'ini', 'cfg', 'conf', 'toml', 'env', 'sh', 'bash', 'zsh', 'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'sql', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp'],
  mimeTypes: ['text/'],
  extract: async (buffer: Buffer) => buffer.toString('utf-8'),
};

const pdfHandler: AttachmentHandler = {
  extensions: ['pdf'],
  mimeTypes: ['application/pdf'],
  extract: async (buffer: Buffer, filename: string) => {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const text = result.text?.trim();
      if (!text) {
        throw new Error(`PDF "${filename}" contains no extractable text (may be image-only).`);
      }
      return text;
    } finally {
      await parser.destroy().catch(() => {});
    }
  },
};

// ── Registry ─────────────────────────────────────────────────────────

const handlers: AttachmentHandler[] = [textHandler, pdfHandler];

/**
 * Register a custom attachment handler. Handlers added later take priority
 * over earlier ones when extensions overlap.
 */
export function registerHandler(handler: AttachmentHandler): void {
  handlers.push(handler);
}

/** List supported file extensions across all registered handlers. */
export function supportedExtensions(): string[] {
  const exts = new Set<string>();
  for (const h of handlers) {
    for (const ext of h.extensions) exts.add(ext);
  }
  return [...exts].sort();
}

function findHandler(filename: string, contentType: string | null): AttachmentHandler | undefined {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  // Search in reverse so later-registered handlers win
  for (let i = handlers.length - 1; i >= 0; i--) {
    const h = handlers[i];
    if (h.extensions.includes(ext)) return h;
    if (contentType && h.mimeTypes.some(prefix => contentType.startsWith(prefix))) return h;
  }
  return undefined;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Check if a Discord attachment is a "document" type we can extract text from
 * (i.e. not an image or audio, which have their own handling paths).
 */
export function isDocumentAttachment(attachment: Attachment): boolean {
  const contentType = attachment.contentType ?? '';
  if (contentType.startsWith('image/') || contentType.startsWith('audio/') || contentType.startsWith('voice/')) {
    return false;
  }
  const filename = attachment.name ?? 'unknown';
  return findHandler(filename, contentType) !== undefined;
}

/**
 * Process a Discord attachment: fetch, validate, extract text.
 * Returns a result object — never throws.
 */
export async function processAttachment(attachment: Attachment): Promise<AttachmentResult> {
  const filename = attachment.name ?? 'unknown';

  try {
    // Size check
    if (attachment.size > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        error: `File "${filename}" is too large (${(attachment.size / 1024 / 1024).toFixed(1)} MB). Maximum is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
        filename,
      };
    }

    // Find handler
    const handler = findHandler(filename, attachment.contentType ?? null);
    if (!handler) {
      return {
        ok: false,
        error: `Unsupported file type: "${filename}". Supported extensions: ${supportedExtensions().map(e => `.${e}`).join(', ')}`,
        filename,
      };
    }

    // Fetch with timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let buffer: Buffer;
    try {
      const response = await fetch(attachment.url, { signal: controller.signal });
      if (!response.ok) {
        return { ok: false, error: `Failed to download "${filename}" (HTTP ${response.status}).`, filename };
      }
      buffer = Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }

    // Extract text
    let text = await handler.extract(buffer, filename);

    // Truncate if needed
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS) + `\n\n[... truncated at ${MAX_TEXT_CHARS.toLocaleString()} characters]`;
    }

    return { ok: true, text, filename };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: `Error processing "${filename}": ${msg}`, filename };
  }
}

/**
 * Process multiple attachments, returning results for each.
 */
export async function processAttachments(attachments: Attachment[]): Promise<AttachmentResult[]> {
  return Promise.all(attachments.map(processAttachment));
}
