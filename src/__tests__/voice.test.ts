import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VoiceConfig } from '../types.js';

// Hoist mock variables so they're available when vi.mock factories run
const { mockAudioSpeechCreate } = vi.hoisted(() => ({
  mockAudioSpeechCreate: vi.fn(),
}));

// Mock openai — use a class so `new OpenAI()` works correctly in ESM mocking context
vi.mock('openai', () => ({
  default: class MockOpenAI {
    audio = {
      speech: {
        create: (...args: unknown[]) => mockAudioSpeechCreate(...args),
      },
      transcriptions: { create: vi.fn() },
    };
  },
}));

// Mock child_process — execSync used by macOS say provider
vi.mock('child_process', () => ({
  execSync: vi.fn(() => Buffer.from('')),
}));

// Mock fs to avoid actual disk I/O
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => Buffer.from('fake-audio-data')),
    unlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

// Mock global fetch for ElevenLabs tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocks are set up
const { synthesizeSpeech, checkTTSDependencies, checkVoiceDependencies } = await import('../voice.js');

// --- Config helpers ---

const baseVoiceConfig: VoiceConfig = {
  enabled: true,
  providers: {},
  channels: {},
};

// --- Tests ---

describe('synthesizeSpeech', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when no providers configured', async () => {
    const config: VoiceConfig = { ...baseVoiceConfig, providers: {} };
    await expect(synthesizeSpeech('hello', config)).rejects.toThrow('No TTS provider configured');
  });

  it('throws when provider has no apiKey for OpenAI path', async () => {
    const config: VoiceConfig = {
      ...baseVoiceConfig,
      providers: { openai: { tts: {} } }, // tts present but no apiKey
    };
    await expect(synthesizeSpeech('hello', config)).rejects.toThrow(
      'No API key configured for TTS provider'
    );
  });

  it('returns SpeechResult for OpenAI provider', async () => {
    const fakeBuffer = Buffer.from('fake-opus-audio');
    mockAudioSpeechCreate.mockResolvedValueOnce({
      arrayBuffer: async () => fakeBuffer,
    });

    const config: VoiceConfig = {
      ...baseVoiceConfig,
      defaultProvider: 'openai',
      providers: {
        openai: {
          apiKey: 'test-key',
          tts: { model: 'tts-1', voice: 'nova' },
        },
      },
    };

    const result = await synthesizeSpeech('Hello world', config);
    expect(result.format).toBe('ogg');
    expect(result.provider).toContain('openai');
    expect(mockAudioSpeechCreate).toHaveBeenCalledWith(
      expect.objectContaining({ input: 'Hello world', model: 'tts-1', voice: 'nova' })
    );
  });

  it('defaults to nova voice and tts-1 model for OpenAI when not specified', async () => {
    const fakeBuffer = Buffer.from('fake-audio');
    mockAudioSpeechCreate.mockResolvedValueOnce({
      arrayBuffer: async () => fakeBuffer,
    });

    const config: VoiceConfig = {
      ...baseVoiceConfig,
      providers: { openai: { apiKey: 'test-key', tts: {} } },
    };

    await synthesizeSpeech('test', config);
    expect(mockAudioSpeechCreate).toHaveBeenCalledWith(
      expect.objectContaining({ voice: 'nova', model: 'tts-1' })
    );
  });

  it('returns SpeechResult for ElevenLabs provider', async () => {
    const fakeBuffer = Buffer.from('fake-mp3-audio');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => fakeBuffer,
    });

    const config: VoiceConfig = {
      ...baseVoiceConfig,
      providers: {
        elevenlabs: {
          apiKey: 'el-key',
          tts: { voiceId: 'voice-abc123' },
        },
      },
    };

    const result = await synthesizeSpeech('Hello ElevenLabs', config);
    expect(result.format).toBe('mp3');
    expect(result.provider).toBe('elevenlabs');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/text-to-speech/voice-abc123',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'xi-api-key': 'el-key' }),
      })
    );
  });

  it('throws for ElevenLabs when no voiceId configured', async () => {
    const config: VoiceConfig = {
      ...baseVoiceConfig,
      providers: {
        elevenlabs: {
          apiKey: 'el-key',
          tts: {}, // no voiceId
        },
      },
    };
    await expect(synthesizeSpeech('test', config)).rejects.toThrow('voiceId');
  });

  it('throws for ElevenLabs when no apiKey configured', async () => {
    const config: VoiceConfig = {
      ...baseVoiceConfig,
      providers: {
        elevenlabs: {
          tts: { voiceId: 'voice-abc' },
        },
      },
    };
    await expect(synthesizeSpeech('test', config)).rejects.toThrow('No API key configured for ElevenLabs');
  });

  it('throws for ElevenLabs when API returns error status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    const config: VoiceConfig = {
      ...baseVoiceConfig,
      providers: {
        elevenlabs: {
          apiKey: 'bad-key',
          tts: { voiceId: 'voice-abc' },
        },
      },
    };
    await expect(synthesizeSpeech('test', config)).rejects.toThrow('ElevenLabs TTS failed: 401');
  });

  it('picks provider with tts config over default provider without one', async () => {
    const fakeBuffer = Buffer.from('fake-mp3');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => fakeBuffer,
    });

    const config: VoiceConfig = {
      ...baseVoiceConfig,
      defaultProvider: 'openai', // openai has no tts sub-config
      providers: {
        openai: { apiKey: 'openai-key' }, // no tts — should be skipped
        elevenlabs: { apiKey: 'el-key', tts: { voiceId: 'voice-xyz' } }, // has tts
      },
    };

    const result = await synthesizeSpeech('test', config);
    expect(result.provider).toBe('elevenlabs');
  });

  it('macOS provider throws on non-darwin platform', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    try {
      const config: VoiceConfig = {
        ...baseVoiceConfig,
        providers: { macos: { tts: { voice: 'Zoe' } } },
      };
      await expect(synthesizeSpeech('test', config)).rejects.toThrow(
        'macOS say provider is only available on macOS'
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('resolves API key from environment variable syntax', async () => {
    const fakeBuffer = Buffer.from('fake-audio');
    mockAudioSpeechCreate.mockResolvedValueOnce({
      arrayBuffer: async () => fakeBuffer,
    });

    process.env['TEST_TTS_KEY'] = 'resolved-from-env';
    const config: VoiceConfig = {
      ...baseVoiceConfig,
      providers: { openai: { apiKey: '${TEST_TTS_KEY}', tts: { model: 'tts-1' } } },
    };

    const result = await synthesizeSpeech('test', config);
    expect(result.format).toBe('ogg');
    delete process.env['TEST_TTS_KEY'];
  });
});

describe('checkTTSDependencies', () => {
  it('returns ok on non-darwin platform (no ffmpeg check needed)', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const result = checkTTSDependencies();
      expect(result.ok).toBe(true);
      expect(result.missing).toHaveLength(0);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});

describe('checkVoiceDependencies', () => {
  it('ignores macos provider for STT and uses API-backed provider', () => {
    const config: VoiceConfig = {
      ...baseVoiceConfig,
      defaultProvider: 'macos',
      providers: {
        macos: { tts: { voice: 'Samantha' } },
        openai: { apiKey: 'openai-key', stt: { model: 'whisper-1' } },
      },
    };

    const result = checkVoiceDependencies(config);
    expect(result.ok).toBe(true);
    expect(result.localWhisper).toBe(false);
    expect(result.missing).toHaveLength(0);
  });

  it('reports missing STT provider when only macos provider is configured', () => {
    const config: VoiceConfig = {
      ...baseVoiceConfig,
      defaultProvider: 'macos',
      providers: {
        macos: { tts: { voice: 'Samantha' } },
      },
    };

    const result = checkVoiceDependencies(config);
    expect(result.ok).toBe(false);
    expect(result.missing[0]).toContain('No local whisper CLI and no API providers configured');
  });
});
