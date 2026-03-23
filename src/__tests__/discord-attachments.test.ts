import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Attachment } from 'discord.js';

// Mock pdf-parse before importing the module under test
const mockGetText = vi.fn();
const mockDestroy = vi.fn();

vi.mock('pdf-parse', () => {
  const MockPDFParse = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.getText = mockGetText;
    this.destroy = mockDestroy;
  });
  return { PDFParse: MockPDFParse };
});

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  isDocumentAttachment,
  processAttachment,
  processAttachments,
  supportedExtensions,
  registerHandler,
  MAX_ATTACHMENT_BYTES,
  MAX_TEXT_CHARS,
} from '../channels/discord/attachments.js';

function fakeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    name: 'test.txt',
    url: 'https://cdn.discordapp.com/attachments/123/456/test.txt',
    contentType: 'text/plain',
    size: 100,
    ...overrides,
  } as unknown as Attachment;
}

function mockFetchOk(content: Buffer | string): void {
  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  mockFetch.mockResolvedValueOnce({
    ok: true,
    arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── isDocumentAttachment ──────────────────────────────────────────

describe('isDocumentAttachment', () => {
  it('returns true for .txt files', () => {
    expect(isDocumentAttachment(fakeAttachment({ name: 'notes.txt', contentType: 'text/plain' }))).toBe(true);
  });

  it('returns true for .pdf files', () => {
    expect(isDocumentAttachment(fakeAttachment({ name: 'report.pdf', contentType: 'application/pdf' }))).toBe(true);
  });

  it('returns true for .md files', () => {
    expect(isDocumentAttachment(fakeAttachment({ name: 'README.md', contentType: 'text/markdown' }))).toBe(true);
  });

  it('returns true for .json files', () => {
    expect(isDocumentAttachment(fakeAttachment({ name: 'data.json', contentType: 'application/json' }))).toBe(true);
  });

  it('returns true for source code files', () => {
    expect(isDocumentAttachment(fakeAttachment({ name: 'app.py', contentType: 'text/x-python' }))).toBe(true);
    expect(isDocumentAttachment(fakeAttachment({ name: 'index.ts', contentType: 'text/typescript' }))).toBe(true);
  });

  it('returns false for image files', () => {
    expect(isDocumentAttachment(fakeAttachment({ name: 'photo.jpg', contentType: 'image/jpeg' }))).toBe(false);
  });

  it('returns false for audio files', () => {
    expect(isDocumentAttachment(fakeAttachment({ name: 'voice.ogg', contentType: 'audio/ogg' }))).toBe(false);
  });

  it('returns false for unsupported types', () => {
    expect(isDocumentAttachment(fakeAttachment({ name: 'archive.zip', contentType: 'application/zip' }))).toBe(false);
  });

  it('returns false for null content type with unsupported extension', () => {
    expect(isDocumentAttachment(fakeAttachment({ name: 'file.xyz', contentType: null as unknown as string }))).toBe(false);
  });
});

// ── processAttachment — text files ────────────────────────────────

describe('processAttachment — text files', () => {
  it('extracts text from a .txt attachment', async () => {
    const att = fakeAttachment({ name: 'hello.txt', contentType: 'text/plain', size: 50 });
    mockFetchOk('Hello, world!');

    const result = await processAttachment(att);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Hello, world!');
    expect(result.filename).toBe('hello.txt');
  });

  it('extracts text from a .md attachment', async () => {
    const att = fakeAttachment({ name: 'README.md', contentType: 'text/markdown', size: 30 });
    mockFetchOk('# Title\n\nSome content');

    const result = await processAttachment(att);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('# Title');
  });

  it('truncates text exceeding MAX_TEXT_CHARS', async () => {
    const att = fakeAttachment({ name: 'big.txt', contentType: 'text/plain', size: 200 });
    const bigText = 'A'.repeat(MAX_TEXT_CHARS + 500);
    mockFetchOk(bigText);

    const result = await processAttachment(att);
    expect(result.ok).toBe(true);
    expect(result.text!.length).toBeLessThan(bigText.length);
    expect(result.text).toContain('[... truncated at');
  });
});

// ── processAttachment — PDF files ─────────────────────────────────

describe('processAttachment — PDF files', () => {
  it('extracts text from a PDF', async () => {
    const att = fakeAttachment({ name: 'report.pdf', contentType: 'application/pdf', size: 500 });
    mockFetchOk(Buffer.from('fake pdf content'));
    mockGetText.mockResolvedValueOnce({ text: 'Extracted PDF text', pages: [], total: 1 });
    mockDestroy.mockResolvedValueOnce(undefined);

    const result = await processAttachment(att);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Extracted PDF text');
  });

  it('returns error for image-only PDF', async () => {
    const att = fakeAttachment({ name: 'scan.pdf', contentType: 'application/pdf', size: 500 });
    mockFetchOk(Buffer.from('fake'));
    mockGetText.mockResolvedValueOnce({ text: '', pages: [], total: 1 });
    mockDestroy.mockResolvedValueOnce(undefined);

    const result = await processAttachment(att);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no extractable text');
  });

  it('handles pdf-parse failure gracefully', async () => {
    const att = fakeAttachment({ name: 'corrupt.pdf', contentType: 'application/pdf', size: 500 });
    mockFetchOk(Buffer.from('not a real pdf'));
    mockGetText.mockRejectedValueOnce(new Error('Invalid PDF structure'));
    mockDestroy.mockResolvedValueOnce(undefined);

    const result = await processAttachment(att);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid PDF structure');
  });
});

// ── processAttachment — validation ────────────────────────────────

describe('processAttachment — validation', () => {
  it('rejects files exceeding MAX_ATTACHMENT_BYTES', async () => {
    const att = fakeAttachment({ name: 'huge.txt', contentType: 'text/plain', size: MAX_ATTACHMENT_BYTES + 1 });

    const result = await processAttachment(att);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('too large');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects unsupported file types', async () => {
    const att = fakeAttachment({ name: 'archive.zip', contentType: 'application/zip', size: 100 });

    const result = await processAttachment(att);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unsupported file type');
    expect(result.error).toContain('Supported extensions');
  });

  it('handles fetch failure gracefully', async () => {
    const att = fakeAttachment({ name: 'file.txt', contentType: 'text/plain', size: 100 });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await processAttachment(att);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 404');
  });

  it('handles network errors gracefully', async () => {
    const att = fakeAttachment({ name: 'file.txt', contentType: 'text/plain', size: 100 });
    mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

    const result = await processAttachment(att);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Network timeout');
  });

  it('handles missing filename gracefully', async () => {
    const att = fakeAttachment({ name: undefined as unknown as string, contentType: 'text/plain', size: 100 });

    const result = await processAttachment(att);
    expect(result.filename).toBe('unknown');
  });
});

// ── processAttachments (batch) ────────────────────────────────────

describe('processAttachments', () => {
  it('processes multiple attachments concurrently', async () => {
    const att1 = fakeAttachment({ name: 'a.txt', contentType: 'text/plain', size: 10 });
    const att2 = fakeAttachment({ name: 'b.txt', contentType: 'text/plain', size: 10 });
    mockFetchOk('File A');
    mockFetchOk('File B');

    const results = await processAttachments([att1, att2]);
    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(true);
    expect(results[0].text).toBe('File A');
    expect(results[1].ok).toBe(true);
    expect(results[1].text).toBe('File B');
  });

  it('returns mixed results when some fail', async () => {
    const att1 = fakeAttachment({ name: 'ok.txt', contentType: 'text/plain', size: 10 });
    const att2 = fakeAttachment({ name: 'huge.txt', contentType: 'text/plain', size: MAX_ATTACHMENT_BYTES + 1 });
    mockFetchOk('Good file');

    const results = await processAttachments([att1, att2]);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toContain('too large');
  });
});

// ── supportedExtensions ───────────────────────────────────────────

describe('supportedExtensions', () => {
  it('includes txt and pdf', () => {
    const exts = supportedExtensions();
    expect(exts).toContain('txt');
    expect(exts).toContain('pdf');
    expect(exts).toContain('md');
  });

  it('returns sorted list', () => {
    const exts = supportedExtensions();
    const sorted = [...exts].sort();
    expect(exts).toEqual(sorted);
  });
});

// ── registerHandler ───────────────────────────────────────────────

describe('registerHandler', () => {
  it('allows registering custom handlers', async () => {
    registerHandler({
      extensions: ['custom'],
      mimeTypes: ['application/x-custom'],
      extract: async (buffer) => `CUSTOM: ${buffer.toString('utf-8')}`,
    });

    const att = fakeAttachment({ name: 'data.custom', contentType: 'application/x-custom', size: 10 });
    mockFetchOk('raw data');

    const result = await processAttachment(att);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('CUSTOM: raw data');
  });
});
