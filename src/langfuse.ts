// Langfuse tracing integration (optional) + cost tracking

import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider } from '@langfuse/tracing';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { Config } from './types.js';
import { isSecretKey, redactSecretText } from './security.js';

const DATA_URI_BASE64_RE =
  /data:([a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*(?:;[a-zA-Z0-9!#$&^_.+-]+=[^;,\s]+)*);base64,([a-zA-Z0-9+/_=-]+)/gi;

function estimateBase64Bytes(base64Data: string): number {
  const compact = base64Data.replace(/\s/g, '');
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function sanitizeLangfuseString(value: string): string {
  return redactSecretText(value).replace(DATA_URI_BASE64_RE, (_match, mimeType: string, base64Data: string) => {
    const byteLength = estimateBase64Bytes(base64Data);
    return `[redacted data URI: ${mimeType}, approx ${byteLength} bytes]`;
  });
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Remove secrets and inline base64 media from Langfuse observability payloads only.
 *
 * SkimpyClaw still sends the original provider/tool payloads to their normal
 * destinations; this copy prevents Langfuse from receiving secret-shaped text
 * or inline data:*;base64 media in trace and observation input/output/metadata.
 */
export function sanitizeLangfusePayload<T>(payload: T): T {
  if (typeof payload === 'string') {
    return sanitizeLangfuseString(payload) as T;
  }

  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizeLangfusePayload(item)) as T;
  }

  if (!isPlainObject(payload)) {
    return payload;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    sanitized[key] = isSecretKey(key) ? '[REDACTED]' : sanitizeLangfusePayload(value);
  }
  return sanitized as T;
}

/** Per-million-token pricing for a model */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Cost breakdown returned by calculateUsageCost */
export interface UsageCost {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

/** Pricing data for known models (USD per million tokens) */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude models — base IDs (prefix matching handles dated variants like -20251001)
  'claude-3-5-sonnet': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'claude-3-5-haiku': { inputPerMTok: 0.8, outputPerMTok: 4.0 },
  'claude-3-opus': { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  'claude-sonnet-4-5': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'claude-sonnet-4': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'claude-haiku-4-5': { inputPerMTok: 0.25, outputPerMTok: 1.25 },
  'claude-haiku-4': { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  'claude-opus-4': { inputPerMTok: 15.0, outputPerMTok: 75.0 },

  // Codex pricing
  'gpt-5.1-codex': { inputPerMTok: 1.25, outputPerMTok: 10.0 },
  'gpt-5.2-codex': { inputPerMTok: 1.75, outputPerMTok: 14.0 },
  'gpt-5.3-codex': { inputPerMTok: 1.75, outputPerMTok: 14.0 },
  'gpt-5.5': { inputPerMTok: 5.0, outputPerMTok: 30.0 },
  // Sol requests use Priority processing (Codex Fast), so track Priority rates.
  'gpt-5.6-sol': { inputPerMTok: 10.0, outputPerMTok: 60.0 },
  'codex-5.1': { inputPerMTok: 1.25, outputPerMTok: 10.0 },
  'codex-5.2': { inputPerMTok: 1.75, outputPerMTok: 14.0 },
  'codex-5.3': { inputPerMTok: 1.75, outputPerMTok: 14.0 },
};

/** Map of common aliases/shorthand to canonical model IDs in MODEL_PRICING */
const MODEL_ALIAS_MAP: Record<string, string> = {
  // Claude aliases → base keys in MODEL_PRICING (prefix matching handles dated variants)
  sonnet: 'claude-sonnet-4-5',
  'claude-sonnet': 'claude-sonnet-4-5',
  haiku: 'claude-haiku-4-5',
  'claude-haiku': 'claude-haiku-4-5',
  opus: 'claude-opus-4',
  'claude-opus': 'claude-opus-4',
  'claude-3.5-sonnet': 'claude-3-5-sonnet',
  'claude-3-opus': 'claude-3-opus',

  'gpt-codex': 'gpt-5.3-codex',
  'codex5.1': 'gpt-5.1-codex',
  'codex5.2': 'gpt-5.2-codex',
  'codex5.3': 'gpt-5.3-codex',
  'codex5.5': 'gpt-5.5',
  'codex5.6': 'gpt-5.6-sol',
  'gpt-5.6': 'gpt-5.6-sol',
  codex: 'gpt-5.6-sol',
};

/**
 * Calculate the USD cost of a model invocation based on token usage.
 *
 * Resolves model aliases and strips provider prefixes (e.g. "anthropic/claude-sonnet-4-20250514").
 * Returns zero costs if the model is not found in the pricing map.
 */
export function calculateUsageCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): UsageCost {
  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-20250514" -> "claude-sonnet-4-20250514")
  const bare = model.includes('/')
    ? model.split('/').slice(1).join('/')
    : model;

  // Try direct match, then alias lookup, then prefix matching
  // Prefix matching handles dated variants like "claude-haiku-4-5-YYYYMMDD" → "claude-haiku-4-5"
  let pricing =
    MODEL_PRICING[bare] ?? MODEL_PRICING[MODEL_ALIAS_MAP[bare] ?? ''];

  if (!pricing) {
    // Prefix match: find longest pricing key that the model ID starts with
    let bestKey = '';
    for (const key of Object.keys(MODEL_PRICING)) {
      if (bare.startsWith(key) && key.length > bestKey.length) {
        bestKey = key;
      }
    }
    if (bestKey) pricing = MODEL_PRICING[bestKey];
  }

  if (!pricing) {
    return { inputCost: 0, outputCost: 0, totalCost: 0 };
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMTok;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMTok;

  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost
  };
}

export interface LangfuseConfig {
  enabled?: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  environment?: string;
  release?: string;
  exportMode?: 'immediate' | 'batched';
}

let enabled = false;
let tracerProvider: NodeTracerProvider | null = null;
let langfuseConfig: LangfuseConfig | null = null;

export function initLangfuse(config: Config): void {
  const cfg = config.langfuse as LangfuseConfig | undefined;
  if (!cfg?.enabled) return;

  tracerProvider = new NodeTracerProvider({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: cfg.publicKey,
        secretKey: cfg.secretKey,
        baseUrl: cfg.baseUrl,
        environment: cfg.environment,
        release: cfg.release,
        exportMode: cfg.exportMode
      })
    ]
  });

  tracerProvider.register();
  setLangfuseTracerProvider(tracerProvider);

  enabled = true;
  langfuseConfig = cfg;

  console.log(
    `[langfuse] Enabled (${cfg.baseUrl || 'https://cloud.langfuse.com'})`
  );
}

export function isLangfuseEnabled(): boolean {
  return enabled;
}

export function getLangfuseConfig(): LangfuseConfig | null {
  return langfuseConfig;
}

export async function shutdownLangfuse(): Promise<void> {
  if (!tracerProvider) return;
  try {
    await tracerProvider.shutdown();
  } catch (err) {
    console.warn('[langfuse] Shutdown failed:', err);
  }
}
