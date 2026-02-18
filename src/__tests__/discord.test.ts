import { describe, it, expect } from 'vitest';
import { isAudioAttachment, getAudioExtension } from '../discord.js';

// Minimal fake attachment type for testing
interface FakeAttachment {
  contentType?: string | null;
  name?: string | null;
  url: string;
}

describe('isAudioAttachment', () => {
  it('returns true for audio/ogg contentType', () => {
    const a: FakeAttachment = { contentType: 'audio/ogg', url: 'https://example.com/file.ogg' };
    expect(isAudioAttachment(a)).toBe(true);
  });

  it('returns true for audio/mpeg contentType', () => {
    const a: FakeAttachment = { contentType: 'audio/mpeg', url: 'https://example.com/file.mp3' };
    expect(isAudioAttachment(a)).toBe(true);
  });

  it('returns true for audio/wav contentType', () => {
    const a: FakeAttachment = { contentType: 'audio/wav', url: 'https://example.com/file.wav' };
    expect(isAudioAttachment(a)).toBe(true);
  });

  it('returns true when contentType is missing but URL has .ogg extension', () => {
    const a: FakeAttachment = { contentType: null, url: 'https://example.com/voice.ogg' };
    expect(isAudioAttachment(a)).toBe(true);
  });

  it('returns true when contentType is missing but URL has .opus extension', () => {
    const a: FakeAttachment = { contentType: null, url: 'https://example.com/voice.opus' };
    expect(isAudioAttachment(a)).toBe(true);
  });

  it('returns true when contentType is missing but URL has .mp3 extension', () => {
    const a: FakeAttachment = { contentType: null, url: 'https://example.com/clip.mp3' };
    expect(isAudioAttachment(a)).toBe(true);
  });

  it('returns true when contentType is missing but URL has .m4a extension', () => {
    const a: FakeAttachment = { contentType: null, url: 'https://cdn.discord.com/voice.m4a?ex=123' };
    expect(isAudioAttachment(a)).toBe(true);
  });

  it('returns true when contentType is missing but URL has .webm extension', () => {
    const a: FakeAttachment = { contentType: null, url: 'https://cdn.discord.com/voice.webm' };
    expect(isAudioAttachment(a)).toBe(true);
  });

  it('returns true when contentType is missing but URL has .flac extension', () => {
    const a: FakeAttachment = { contentType: null, url: 'https://cdn.discord.com/voice.flac' };
    expect(isAudioAttachment(a)).toBe(true);
  });

  it('returns true when contentType is missing but URL has .aac extension', () => {
    const a: FakeAttachment = { contentType: null, url: 'https://cdn.discord.com/voice.aac' };
    expect(isAudioAttachment(a)).toBe(true);
  });

  it('returns true when contentType is missing but URL has .oga extension', () => {
    const a: FakeAttachment = { contentType: null, url: 'https://cdn.discord.com/voice.oga' };
    expect(isAudioAttachment(a)).toBe(true);
  });

  it('returns false for image contentType', () => {
    const a: FakeAttachment = { contentType: 'image/png', url: 'https://example.com/img.png' };
    expect(isAudioAttachment(a)).toBe(false);
  });

  it('returns false for text/plain contentType', () => {
    const a: FakeAttachment = { contentType: 'text/plain', url: 'https://example.com/file.txt' };
    expect(isAudioAttachment(a)).toBe(false);
  });

  it('returns false when contentType is missing and URL has no audio extension', () => {
    const a: FakeAttachment = { contentType: null, url: 'https://example.com/file.png' };
    expect(isAudioAttachment(a)).toBe(false);
  });

  it('returns false when contentType is missing and URL has no recognizable extension', () => {
    const a: FakeAttachment = { contentType: null, url: 'https://example.com/file' };
    expect(isAudioAttachment(a)).toBe(false);
  });
});

describe('getAudioExtension', () => {
  it('returns the extension from the URL for known audio formats', () => {
    const a: FakeAttachment = { contentType: 'audio/ogg', url: 'https://cdn.discord.com/voice.ogg?ex=123&is=456' };
    expect(getAudioExtension(a)).toBe('ogg');
  });

  it('returns ogg for audio/ogg when URL has no path extension', () => {
    const a: FakeAttachment = { contentType: 'audio/ogg', url: 'https://cdn.discord.com/attachment' };
    expect(getAudioExtension(a)).toBe('ogg');
  });

  it('returns mp3 for audio/mpeg', () => {
    const a: FakeAttachment = { contentType: 'audio/mpeg', url: 'https://cdn.discord.com/attachment' };
    expect(getAudioExtension(a)).toBe('mp3');
  });

  it('returns wav for audio/wav', () => {
    const a: FakeAttachment = { contentType: 'audio/wav', url: 'https://cdn.discord.com/attachment' };
    expect(getAudioExtension(a)).toBe('wav');
  });

  it('returns m4a for audio/mp4', () => {
    const a: FakeAttachment = { contentType: 'audio/mp4', url: 'https://cdn.discord.com/attachment' };
    expect(getAudioExtension(a)).toBe('m4a');
  });

  it('returns webm for audio/webm', () => {
    const a: FakeAttachment = { contentType: 'audio/webm', url: 'https://cdn.discord.com/attachment' };
    expect(getAudioExtension(a)).toBe('webm');
  });

  it('returns flac for audio/flac', () => {
    const a: FakeAttachment = { contentType: 'audio/flac', url: 'https://cdn.discord.com/attachment' };
    expect(getAudioExtension(a)).toBe('flac');
  });

  it('returns aac for audio/aac', () => {
    const a: FakeAttachment = { contentType: 'audio/aac', url: 'https://cdn.discord.com/attachment' };
    expect(getAudioExtension(a)).toBe('aac');
  });

  it('falls back to URL extension when contentType not recognized', () => {
    const a: FakeAttachment = { contentType: null, url: 'https://cdn.discord.com/voice.opus' };
    expect(getAudioExtension(a)).toBe('opus');
  });

  it('returns ogg as default when nothing can be determined', () => {
    const a: FakeAttachment = { contentType: null, url: 'https://cdn.discord.com/attachment' };
    expect(getAudioExtension(a)).toBe('ogg');
  });
});
