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
  'claude-3-5-sonnet-20241022': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'claude-3-5-haiku-20241022': { inputPerMTok: 0.8, outputPerMTok: 4.0 },
  'claude-3-opus-20240229': { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  'claude-sonnet-4-20250514': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'claude-haiku-4.5-20250110': { inputPerMTok: 0.25, outputPerMTok: 1.25 },
  'claude-opus-4.6-20250514': { inputPerMTok: 15.0, outputPerMTok: 75.0 },

  // OpenAI models (https://developers.openai.com/api/docs/pricing)
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10.0 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  'gpt-4.1': { inputPerMTok: 2.0, outputPerMTok: 8.0 },
  'gpt-4.1-mini': { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  'gpt-4.1-nano': { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  'gpt-4-turbo': { inputPerMTok: 10.0, outputPerMTok: 30.0 },
  'gpt-3.5-turbo': { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  // Codex pricing aligns to current GPT-5.2 codex rates
  'gpt-codex-5.2': { inputPerMTok: 1.75, outputPerMTok: 14.0 },
  'gpt-codex-5.3': { inputPerMTok: 1.75, outputPerMTok: 14.0 },
  'codex-5.2': { inputPerMTok: 1.75, outputPerMTok: 14.0 },
  'codex-5.3': { inputPerMTok: 1.75, outputPerMTok: 14.0 },

  // MiniMax models (https://platform.minimax.io/docs/pricing/pay-as-you-go)
  'minimax-m2.1': { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  'minimax-m2.5': { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  // Kimi/Moonshot models (https://platform.moonshot.ai/docs/pricing/chat.en-US)
  // kimi-k2.5 series - using cache miss pricing for input (non-cached)
  'kimi-k2.5': { inputPerMTok: 0.6, outputPerMTok: 3.0 },
  'kimi-for-coding': { inputPerMTok: 0.6, outputPerMTok: 3.0 }
};

/** Map of common aliases/shorthand to canonical model IDs in MODEL_PRICING */
const MODEL_ALIAS_MAP: Record<string, string> = {
  // Claude aliases
  sonnet: 'claude-sonnet-4-20250514',
  'claude-sonnet': 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-4.5-20250110',
  'claude-haiku': 'claude-haiku-4.5-20250110',
  opus: 'claude-opus-4.6-20250514',
  'claude-opus': 'claude-opus-4.6-20250514',
  'claude-3.5-sonnet': 'claude-3-5-sonnet-20241022',
  'claude-3-opus': 'claude-3-opus-20240229',

  // OpenAI aliases
  gpt4o: 'gpt-4o',
  'gpt4o-mini': 'gpt-4o-mini',
  'gpt4.1': 'gpt-4.1',
  'gpt4.1-mini': 'gpt-4.1-mini',
  'gpt4.1-nano': 'gpt-4.1-nano',
  'gpt4-turbo': 'gpt-4-turbo',
  'gpt35-turbo': 'gpt-3.5-turbo',
  'gpt-3.5': 'gpt-3.5-turbo',
  'gpt-codex': 'gpt-codex-5.3',
  codex: 'codex-5.3',

  // MiniMax aliases
  minimax: 'minimax-m2.5',

  // Kimi/Moonshot aliases
  kimi: 'kimi-k2.5'
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

  // Try direct match, then alias lookup
  const pricing =
    MODEL_PRICING[bare] ?? MODEL_PRICING[MODEL_ALIAS_MAP[bare] ?? ''];

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
