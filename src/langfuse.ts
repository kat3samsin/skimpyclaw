// Langfuse tracing integration (optional) + cost tracking

import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider } from '@langfuse/tracing';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { Config } from './types.js';

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
  // Claude models
  'claude-3-5-sonnet-20241022':  { inputPerMTok: 3.00,  outputPerMTok: 15.00 },
  'claude-3-5-haiku-20241022':   { inputPerMTok: 0.80,  outputPerMTok: 4.00  },
  'claude-3-opus-20240229':      { inputPerMTok: 15.00, outputPerMTok: 75.00 },
  'claude-sonnet-4-20250514':    { inputPerMTok: 3.00,  outputPerMTok: 15.00 },
  'claude-haiku-4.5-20250110':   { inputPerMTok: 0.25,  outputPerMTok: 1.25  },
  'claude-opus-4.6-20250514':    { inputPerMTok: 15.00, outputPerMTok: 75.00 },

  // OpenAI models
  'gpt-4o':                      { inputPerMTok: 2.50,  outputPerMTok: 10.00 },
  'gpt-4o-mini':                 { inputPerMTok: 0.15,  outputPerMTok: 0.60  },
  'gpt-4-turbo':                 { inputPerMTok: 10.00, outputPerMTok: 30.00 },
  'gpt-3.5-turbo':               { inputPerMTok: 0.50,  outputPerMTok: 1.50  },
};

/** Map of common aliases/shorthand to canonical model IDs in MODEL_PRICING */
const MODEL_ALIAS_MAP: Record<string, string> = {
  // Claude aliases
  'sonnet':           'claude-sonnet-4-20250514',
  'claude-sonnet':    'claude-sonnet-4-20250514',
  'haiku':            'claude-haiku-4.5-20250110',
  'claude-haiku':     'claude-haiku-4.5-20250110',
  'opus':             'claude-opus-4.6-20250514',
  'claude-opus':      'claude-opus-4.6-20250514',
  'claude-3.5-sonnet':'claude-3-5-sonnet-20241022',
  'claude-3-opus':    'claude-3-opus-20240229',

  // OpenAI aliases
  'gpt4o':            'gpt-4o',
  'gpt4o-mini':       'gpt-4o-mini',
  'gpt4-turbo':       'gpt-4-turbo',
  'gpt35-turbo':      'gpt-3.5-turbo',
  'gpt-3.5':          'gpt-3.5-turbo',
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
  outputTokens: number,
): UsageCost {
  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-20250514" -> "claude-sonnet-4-20250514")
  const bare = model.includes('/') ? model.split('/').slice(1).join('/') : model;

  // Try direct match, then alias lookup
  const pricing = MODEL_PRICING[bare] ?? MODEL_PRICING[MODEL_ALIAS_MAP[bare] ?? ''];

  if (!pricing) {
    return { inputCost: 0, outputCost: 0, totalCost: 0 };
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMTok;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMTok;

  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
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
        exportMode: cfg.exportMode,
      }),
    ],
  });

  tracerProvider.register();
  setLangfuseTracerProvider(tracerProvider);

  enabled = true;
  langfuseConfig = cfg;

  console.log(`[langfuse] Enabled (${cfg.baseUrl || 'https://cloud.langfuse.com'})`);
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
