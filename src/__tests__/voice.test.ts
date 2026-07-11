import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { VoiceConfig } from '../types.js';

// Hoist mock variables so they're available when vi.mock factories run
const { mockAudioSpeechCreate } = vi.hoisted(() => ({
  mockAudioSpeechCreate: vi.fn(),
}));
const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));
const { mockChmodSync, mockMkdirSync, mockUnlinkSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockChmodSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
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

// Keep executable discovery synchronous, but mock long-running child processes.
vi.mock('child_process', () => ({
  execSync: vi.fn(() => Buffer.from('')),
  spawn: (...args: any[]) => (mockSpawn as any)(...args),
}));

// Mock fs to avoid actual disk I/O
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    chmodSync: mockChmodSync,
    mkdirSync: mockMkdirSync,
    readFileSync: vi.fn(() => Buffer.from('fake-audio-data')),
    unlinkSync: mockUnlinkSync,
    writeFileSync: mockWriteFileSync,
    readdirSync: vi.fn(() => []),
  };
});

// Mock global fetch for ElevenLabs tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocks are set up
const { synthesizeSpeech, checkTTSDependencies, checkVoiceDependencies, writeTemporaryVoiceFile } = await import('../voice.js');

// --- Config helpers ---

const baseVoiceConfig: VoiceConfig = {
  enabled: true,
  providers: {},
  channels: {},
};

it('stores temporary voice input with owner-only permissions', () => {
  const buffer = Buffer.from('voice');
  const path = writeTemporaryVoiceFile('discord-voice', '../ogg', buffer);
  const dir = path.slice(0, path.lastIndexOf('/'));

  expect(path).toMatch(/discord-voice-[0-9a-f-]+\.ogg$/);
  expect(mockMkdirSync).toHaveBeenCalledWith(dir, { recursive: true, mode: 0o700 });
  expect(mockChmodSync).toHaveBeenCalledWith(dir, 0o700);
  expect(mockWriteFileSync).toHaveBeenCalledWith(path, buffer, { mode: 0o600 });
  expect(mockChmodSync).toHaveBeenCalledWith(path, 0o600);
});

function createVoiceChild(options: {
  autoClose?: boolean;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  pid?: number;
} = {}): any {
  const child = new EventEmitter() as any;
  child.pid = options.pid ?? 1234;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  if (options.autoClose !== false) {
    queueMicrotask(() => {
      if (options.stdout) child.stdout.emit('data', Buffer.from(options.stdout));
      if (options.stderr) child.stderr.emit('data', Buffer.from(options.stderr));
      child.emit('close', options.code ?? 0, options.signal ?? null);
    });
  }
  return child;
}

// --- Tests ---

describe('synthesizeSpeech', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() => createVoiceChild());
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

  it('uses non-shell args for macOS say + ffmpeg', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const config: VoiceConfig = {
        ...baseVoiceConfig,
        providers: { macos: { tts: { voice: "Bad'Voice; rm -rf /" } } },
      };
      const result = await synthesizeSpeech("hello'; say hacked", config);
      expect(result.format).toBe('ogg');
      expect(mockSpawn).toHaveBeenNthCalledWith(
        1,
        'say',
        ['-v', "Bad'Voice; rm -rf /", '-o', expect.stringContaining('.aiff'), "hello'; say hacked"],
        expect.any(Object),
      );
      expect(mockSpawn).toHaveBeenNthCalledWith(
        2,
        'ffmpeg',
        ['-i', expect.stringContaining('.aiff'), '-c:a', 'libopus', expect.stringContaining('.ogg'), '-y'],
        expect.any(Object),
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('keeps the event loop responsive while macOS synthesis is running', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const sayChild = createVoiceChild({ autoClose: false });
    mockSpawn.mockImplementationOnce(() => sayChild);
    try {
      const config: VoiceConfig = {
        ...baseVoiceConfig,
        providers: { macos: { tts: { voice: 'Zoe' } } },
      };
      const synthesis = synthesizeSpeech('delayed speech', config);
      let timerFired = false;

      await new Promise<void>((resolve) => {
        setTimeout(() => {
          timerFired = true;
          resolve();
        }, 0);
      });

      expect(timerFired).toBe(true);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      sayChild.emit('close', 0, null);
      await expect(synthesis).resolves.toMatchObject({ format: 'ogg' });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('escalates a timed out macOS process group before rejecting', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.useFakeTimers();
    const sayChild = createVoiceChild({ autoClose: false, pid: 2468 });
    mockSpawn.mockImplementationOnce(() => sayChild);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM') {
        queueMicrotask(() => sayChild.emit('close', null, 'SIGTERM'));
      }
      return true;
    });
    try {
      const config: VoiceConfig = {
        ...baseVoiceConfig,
        providers: { macos: { tts: { voice: 'Zoe' } } },
      };
      const synthesis = synthesizeSpeech('timeout speech', config);
      const rejection = expect(synthesis).rejects.toThrow(
        'macOS say failed: say timed out after 120000ms',
      );

      await vi.advanceTimersByTimeAsync(120_000);
      expect(killSpy.mock.calls.filter(([, signal]) => signal === 'SIGTERM')).toHaveLength(1);
      expect(killSpy.mock.calls.some(([, signal]) => signal === 'SIGKILL')).toBe(false);

      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
      expect(killSpy.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('bounds process output in macOS synthesis failures and cleans up', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const noisyError = `${'x'.repeat(70 * 1024)}bad voice`;
    mockSpawn.mockImplementationOnce(() => createVoiceChild({ code: 1, stderr: noisyError }));
    try {
      const config: VoiceConfig = {
        ...baseVoiceConfig,
        providers: { macos: { tts: { voice: 'Zoe' } } },
      };

      const error = (await synthesizeSpeech('failure speech', config).catch(err => err as Error)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('bad voice');
      expect(error.message.length).toBeLessThanOrEqual(64 * 1024 + 32);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockUnlinkSync).toHaveBeenCalledTimes(2);
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

describe('transcription provider messaging', () => {
  it('explains that macos is TTS-only when no STT provider exists', async () => {
    const { transcribeAudio } = await import('../voice.js');
    const config: VoiceConfig = {
      ...baseVoiceConfig,
      providers: {
        macos: { tts: { voice: 'Samantha' } },
      },
    };

    await expect(transcribeAudio('/tmp/fake-audio.ogg', config)).rejects.toThrow(
      'macos" is TTS-only'
    );
  });
});
