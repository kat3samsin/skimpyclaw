// Voice transcription — local Whisper CLI (free) with API fallback
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import type { VoiceConfig, VoiceProviderConfig } from './types.js';

export interface TranscriptionResult {
  text: string;
  duration?: number;
  provider: string;
}

// --- Local Whisper CLI ---

/** Detect available local transcription CLI. Priority: whisper-cli (C++) > whisper (Python). */
interface LocalWhisperInfo {
  path: string;
  type: 'cpp' | 'python';
}

function detectLocalWhisper(): LocalWhisperInfo | null {
  // Prefer whisper.cpp (much faster)
  try {
    const cppPath = execSync('which whisper-cli', { encoding: 'utf-8' }).trim();
    if (cppPath) return { path: cppPath, type: 'cpp' };
  } catch { /* not found */ }

  // Fallback to Python whisper
  try {
    const pyPath = execSync('which whisper', { encoding: 'utf-8' }).trim();
    if (pyPath) return { path: pyPath, type: 'python' };
  } catch { /* not found */ }

  return null;
}

const LOCAL_WHISPER = detectLocalWhisper();

/** Detect if ffmpeg is available for audio conversion. */
const HAS_FFMPEG = (() => {
  try {
    execSync('which ffmpeg', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
})();

/** Formats that whisper-cli can read natively.
 * Note: Discord sends Ogg/Opus files with .ogg extension, which whisper-cli
 * cannot read despite claiming Ogg support (it expects Ogg/Vorbis).
 * We force conversion to WAV for all non-WAV formats to be safe.
 */
const WHISPER_CPP_NATIVE_FORMATS = new Set(['wav']);

/**
 * Convert audio to 16kHz mono WAV for whisper-cli.
 * Telegram sends .oga (Ogg/Opus) which whisper-cli can't read despite claiming ogg support.
 * Returns the WAV path (caller must clean up) or the original path if already compatible.
 */
function convertToWav(audioPath: string): { wavPath: string; needsCleanup: boolean } {
  const ext = audioPath.split('.').pop()?.toLowerCase() || '';

  // WAV is already native — no conversion needed
  if (ext === 'wav') {
    return { wavPath: audioPath, needsCleanup: false };
  }

  // For formats whisper-cli claims to support natively, try them as-is
  // (but .oga is NOT in this list — it's Ogg/Opus, not Ogg/Vorbis)
  if (WHISPER_CPP_NATIVE_FORMATS.has(ext)) {
    return { wavPath: audioPath, needsCleanup: false };
  }

  // Need conversion — requires ffmpeg
  if (!HAS_FFMPEG) {
    throw new Error(`Audio format .${ext} requires ffmpeg for conversion, but ffmpeg is not installed`);
  }

  const wavPath = audioPath.replace(/\.[^.]+$/, '.wav');
  try {
    execSync(
      `ffmpeg -i "${audioPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}" -y`,
      { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ffmpeg conversion failed: ${msg}`);
  }

  if (!existsSync(wavPath)) {
    throw new Error(`ffmpeg conversion produced no output: ${wavPath}`);
  }

  return { wavPath, needsCleanup: true };
}

// whisper.cpp model path — use small model if available, fall back to tiny
const WHISPER_CPP_MODEL = (() => {
  const shareDir = '/opt/homebrew/share/whisper-cpp';
  for (const model of ['ggml-small.bin', 'ggml-base.bin', 'for-tests-ggml-tiny.bin']) {
    const p = join(shareDir, model);
    if (existsSync(p)) return p;
  }
  return process.env.WHISPER_CPP_MODEL || '';
})();

/**
 * Transcribe using whisper.cpp (whisper-cli).
 * Much faster than Python whisper — runs in ~1-3s for short audio.
 */
async function transcribeWithWhisperCpp(audioPath: string, cliPath: string): Promise<TranscriptionResult> {
  const startTime = Date.now();

  if (!WHISPER_CPP_MODEL) {
    throw new Error('No whisper.cpp model found. Download one to /opt/homebrew/share/whisper-cpp/');
  }

  // Convert to WAV if needed (Telegram sends .oga which whisper-cli can't read)
  const { wavPath, needsCleanup } = convertToWav(audioPath);

  const outputDir = dirname(wavPath);
  const baseName = basename(wavPath).replace(/\.[^.]+$/, '');
  const outputBase = join(outputDir, baseName);

  try {
    execSync(
      `"${cliPath}" -m "${WHISPER_CPP_MODEL}" -otxt -of "${outputBase}" -np -nt "${wavPath}"`,
      { encoding: 'utf-8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[voice] whisper-cli failed: ${msg}`);
    throw new Error(`whisper-cli failed: ${msg}`);
  } finally {
    // Clean up converted WAV if we created one
    if (needsCleanup) {
      try { unlinkSync(wavPath); } catch { /* best effort */ }
    }
  }

  const txtPath = `${outputBase}.txt`;
  // Retry a few times in case of filesystem flush delay
  let retries = 5;
  while (!existsSync(txtPath) && retries > 0) {
    await new Promise(resolve => setTimeout(resolve, 50));
    retries--;
  }
  if (!existsSync(txtPath)) {
    console.error(`[voice] whisper-cli output not found after retries: ${txtPath}`);
    try {
      console.error(`[voice] Output dir contents:`, readdirSync(outputDir));
    } catch { /* ignore */ }
    throw new Error(`whisper-cli output not found: ${txtPath}`);
  }

  const text = readFileSync(txtPath, 'utf-8').trim();
  try { unlinkSync(txtPath); } catch { /* best effort */ }

  const modelName = basename(WHISPER_CPP_MODEL).replace('ggml-', '').replace('.bin', '');
  return {
    text,
    duration: (Date.now() - startTime) / 1000,
    provider: `whisper.cpp (${modelName})`,
  };
}

/**
 * Transcribe using Python whisper CLI (openai-whisper package).
 * Slower but works as fallback.
 */
async function transcribeWithPythonWhisper(audioPath: string, cliPath: string): Promise<TranscriptionResult> {
  const startTime = Date.now();
  const outputDir = dirname(audioPath);
  const baseName = basename(audioPath).replace(/\.[^.]+$/, '');

  try {
    execSync(
      `"${cliPath}" "${audioPath}" --model turbo --output_format txt --output_dir "${outputDir}"`,
      { encoding: 'utf-8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Python whisper failed: ${msg}`);
  }

  const txtPath = join(outputDir, `${baseName}.txt`);
  if (!existsSync(txtPath)) {
    throw new Error(`Whisper output not found: ${txtPath}`);
  }

  const text = readFileSync(txtPath, 'utf-8').trim();
  try { unlinkSync(txtPath); } catch { /* best effort */ }

  return {
    text,
    duration: (Date.now() - startTime) / 1000,
    provider: 'whisper (turbo)',
  };
}

/** Transcribe using the best available local whisper. */
async function transcribeWithLocalWhisper(audioPath: string): Promise<TranscriptionResult> {
  if (!LOCAL_WHISPER) {
    throw new Error('No local whisper available');
  }

  if (LOCAL_WHISPER.type === 'cpp') {
    return transcribeWithWhisperCpp(audioPath, LOCAL_WHISPER.path);
  }
  return transcribeWithPythonWhisper(audioPath, LOCAL_WHISPER.path);
}

// --- API-based transcription ---

/**
 * Resolve the STT provider config from the voice config.
 */
function getSTTProvider(config: VoiceConfig): { name: string; provider: VoiceProviderConfig } | null {
  const providers = config.providers;
  if (!providers || Object.keys(providers).length === 0) {
    return null;
  }

  const isApiBackedSttProvider = (
    name: string,
    provider: VoiceProviderConfig | undefined
  ): provider is VoiceProviderConfig => {
    if (!provider) return false;
    const normalizedName = name.trim().toLowerCase();
    // macOS is TTS-only
    if (normalizedName === 'macos') return false;
    // Explicit stt config — always good
    if (provider.stt) return true;
    // Only OpenAI has a Whisper-compatible transcription endpoint by default.
    // Other providers (elevenlabs, etc.) need explicit stt config to be used for STT.
    if (normalizedName === 'openai' && provider.apiKey) return true;
    return false;
  };

  if (config.defaultProvider) {
    const preferredName = config.defaultProvider;
    const preferred = providers[preferredName];
    if (isApiBackedSttProvider(preferredName, preferred)) {
      return { name: config.defaultProvider, provider: preferred };
    }
  }

  for (const [name, provider] of Object.entries(providers)) {
    if (isApiBackedSttProvider(name, provider)) {
      return { name, provider };
    }
  }

  return null;
}

/**
 * Resolve the API key, supporting ${ENV_VAR} syntax.
 */
function resolveApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;
  const envMatch = apiKey.match(/^\$\{(\w+)\}$/);
  if (envMatch) {
    return process.env[envMatch[1]];
  }
  return apiKey;
}

/**
 * Transcribe audio using OpenAI-compatible Whisper API.
 */
async function transcribeWithAPI(
  audioPath: string,
  providerName: string,
  provider: VoiceProviderConfig
): Promise<TranscriptionResult> {
  const startTime = Date.now();
  const apiKey = resolveApiKey(provider.apiKey);

  if (!apiKey) {
    throw new Error(`No API key configured for voice provider "${providerName}"`);
  }

  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI({
    apiKey,
    ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
  });

  const model = provider.stt?.model || 'whisper-1';

  const response = await openai.audio.transcriptions.create({
    file: await OpenAI.toFile(readFileSync(audioPath), 'audio.ogg'),
    model,
  });

  return {
    text: response.text,
    duration: (Date.now() - startTime) / 1000,
    provider: `${providerName} (${model})`,
  };
}

// --- Main entry point ---

/**
 * Transcribe audio file to text.
 * Priority: local whisper CLI (free) → configured API provider.
 */
export async function transcribeAudio(
  audioPath: string,
  config: VoiceConfig
): Promise<TranscriptionResult> {
  if (!existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  // Try local whisper first (free, no API key needed)
  if (LOCAL_WHISPER) {
    try {
      return await transcribeWithLocalWhisper(audioPath);
    } catch (err) {
      // Check if API fallback is actually available before swallowing the error
      const sttProvider = getSTTProvider(config);
      const apiKey = sttProvider ? resolveApiKey(sttProvider.provider.apiKey) : undefined;

      if (!sttProvider || !apiKey) {
        // No API configured — throw the original local whisper error
        throw err;
      }

      console.warn('[voice] Local whisper failed, trying API fallback:', err instanceof Error ? err.message : err);
      return transcribeWithAPI(audioPath, sttProvider.name, sttProvider.provider);
    }
  }

  // No local whisper — try API provider directly
  const sttProvider = getSTTProvider(config);
  if (!sttProvider) {
    if (config.providers?.macos) {
      throw new Error('No voice transcription provider configured. "macos" is TTS-only. Install local whisper or configure an API STT provider (e.g. openai.stt).');
    }
    throw new Error('No voice transcription available. Install whisper (pip install openai-whisper) or configure an API provider.');
  }

  return transcribeWithAPI(audioPath, sttProvider.name, sttProvider.provider);
}

// --- TTS (Text-to-Speech) ---

export interface SpeechResult {
  buffer: Buffer;
  format: 'ogg' | 'mp3';
  provider: string;
}

/**
 * Resolve the TTS provider — prefers defaultProvider with tts config, otherwise finds any provider with tts.
 */
function getTTSProvider(config: VoiceConfig): { name: string; provider: VoiceProviderConfig } | null {
  const providers = config.providers;
  if (!providers || Object.keys(providers).length === 0) {
    return null;
  }

  // First: check if defaultProvider exists AND has tts config
  if (config.defaultProvider) {
    const provider = providers[config.defaultProvider];
    if (provider?.tts) {
      return { name: config.defaultProvider, provider };
    }
  }

  // Second: look for any provider with a tts sub-config
  for (const [name, provider] of Object.entries(providers)) {
    if (provider.tts) {
      return { name, provider };
    }
  }

  // Third: use defaultProvider even without tts config (might still work)
  if (config.defaultProvider) {
    const provider = providers[config.defaultProvider];
    if (provider) {
      return { name: config.defaultProvider, provider };
    }
  }

  // Last resort: use first provider
  const providerName = Object.keys(providers)[0];
  const provider = providers[providerName];
  if (!provider) return null;

  return { name: providerName, provider };
}

/**
 * Synthesize speech using macOS `say` + ffmpeg.
 * Returns OGG audio buffer.
 */
function synthesizeWithMacOS(text: string, voice: string = 'Zoe'): SpeechResult {
  if (process.platform !== 'darwin') {
    throw new Error('macOS say provider is only available on macOS.');
  }
  if (!HAS_FFMPEG) {
    throw new Error('ffmpeg is required for macOS TTS (to convert AIFF to OGG). Install: brew install ffmpeg');
  }
  const id = Date.now();
  const aiffPath = join(tmpdir(), `skimpyclaw-tts-${id}.aiff`);
  const oggPath = join(tmpdir(), `skimpyclaw-tts-${id}.ogg`);
  try {
    const safeText = text.replace(/'/g, "'\\''");
    execSync(`say -v '${voice}' -o '${aiffPath}' '${safeText}'`, { stdio: ['ignore', 'pipe', 'pipe'] });
    execSync(`ffmpeg -i '${aiffPath}' -c:a libopus '${oggPath}' -y`, { stdio: ['ignore', 'pipe', 'pipe'] });
    const buffer = readFileSync(oggPath);
    return { buffer, format: 'ogg', provider: `macos (${voice})` };
  } finally {
    try { unlinkSync(aiffPath); } catch { /* best effort */ }
    try { unlinkSync(oggPath); } catch { /* best effort */ }
  }
}

/**
 * Check if macOS TTS fallback is available.
 */
function canFallbackToMacOS(config: VoiceConfig): boolean {
  return process.platform === 'darwin' && HAS_FFMPEG && !!config.providers?.macos;
}

/**
 * Synthesize speech from text using the configured TTS provider.
 * Falls back to macOS `say` + ffmpeg if the primary provider fails and macOS is available.
 * Throws if no provider is configured or all providers fail.
 */
export async function synthesizeSpeech(text: string, config: VoiceConfig): Promise<SpeechResult> {
  const ttsProvider = getTTSProvider(config);
  if (!ttsProvider) {
    throw new Error('No TTS provider configured. Add a provider with a tts config to your voice config.');
  }

  const { name, provider } = ttsProvider;

  // macOS `say` command
  if (name === 'macos') {
    const voice = provider.tts?.voice || 'Zoe';
    return synthesizeWithMacOS(text, voice);
  }

  // ElevenLabs
  if (name === 'elevenlabs') {
    const apiKey = resolveApiKey(provider.apiKey);
    if (!apiKey) {
      if (canFallbackToMacOS(config)) {
        console.warn('[voice] No ElevenLabs API key — falling back to macOS TTS');
        return synthesizeWithMacOS(text, config.providers?.macos?.tts?.voice || 'Zoe');
      }
      throw new Error('No API key configured for ElevenLabs TTS provider.');
    }
    const voiceId = provider.tts?.voiceId;
    if (!voiceId) {
      throw new Error('ElevenLabs TTS requires tts.voiceId in the provider config.');
    }
    try {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text, model_id: provider.tts?.model || 'eleven_multilingual_v2' }),
      });
      if (!response.ok) {
        throw new Error(`ElevenLabs TTS failed: ${response.status} ${response.statusText}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return { buffer, format: 'mp3', provider: 'elevenlabs' };
    } catch (err) {
      if (canFallbackToMacOS(config)) {
        console.warn(`[voice] ElevenLabs failed, falling back to macOS TTS: ${(err as Error).message}`);
        return synthesizeWithMacOS(text, config.providers?.macos?.tts?.voice || 'Zoe');
      }
      throw err;
    }
  }

  // Default: OpenAI-compatible TTS
  const apiKey = resolveApiKey(provider.apiKey);
  if (!apiKey) {
    if (canFallbackToMacOS(config)) {
      console.warn(`[voice] No API key for "${name}" — falling back to macOS TTS`);
      return synthesizeWithMacOS(text, config.providers?.macos?.tts?.voice || 'Zoe');
    }
    throw new Error(`No API key configured for TTS provider "${name}".`);
  }
  try {
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({
      apiKey,
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
    });
    const model = provider.tts?.model || 'tts-1';
    const voice = (provider.tts?.voice || 'nova') as Parameters<typeof openai.audio.speech.create>[0]['voice'];
    const mp3Response = await openai.audio.speech.create({
      model,
      voice,
      input: text,
      response_format: 'opus',
    });
    const buffer = Buffer.from(await mp3Response.arrayBuffer());
    return { buffer, format: 'ogg', provider: `${name} (${model})` };
  } catch (err) {
    if (canFallbackToMacOS(config)) {
      console.warn(`[voice] ${name} TTS failed, falling back to macOS TTS: ${(err as Error).message}`);
      return synthesizeWithMacOS(text, config.providers?.macos?.tts?.voice || 'Zoe');
    }
    throw err;
  }
}

/**
 * Check if TTS dependencies are available (ffmpeg for macOS say provider).
 */
export function checkTTSDependencies(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (process.platform === 'darwin' && !HAS_FFMPEG) {
    missing.push('ffmpeg is required for macOS TTS. Install: brew install ffmpeg');
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Check if voice transcription is available.
 */
export function checkVoiceDependencies(config: VoiceConfig): { ok: boolean; missing: string[]; localWhisper: boolean } {
  const missing: string[] = [];
  const hasLocalWhisper = !!LOCAL_WHISPER;

  if (hasLocalWhisper) {
    // Local whisper available — no API needed
    return { ok: true, missing: [], localWhisper: true };
  }

  // Check for API fallback
  const sttProvider = getSTTProvider(config);
  if (!sttProvider) {
    missing.push('No local whisper CLI and no API providers configured. Install: pip install openai-whisper');
    return { ok: false, missing, localWhisper: false };
  }

  const apiKey = resolveApiKey(sttProvider.provider.apiKey);
  if (!apiKey) {
    missing.push(`No local whisper and no API key for "${sttProvider.name}" (set ${sttProvider.provider.apiKey} env var)`);
  }

  return {
    ok: missing.length === 0,
    missing,
    localWhisper: false,
  };
}
