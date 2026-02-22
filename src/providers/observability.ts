// Observability Helpers for Providers

import type { calculateUsageCost as CalculateUsageCost, isLangfuseEnabled as IsLangfuseEnabled } from '../langfuse.js';

// Lazy imports to avoid circular dependencies
let calculateUsageCostFn: typeof CalculateUsageCost | undefined;
let isLangfuseEnabledFn: typeof IsLangfuseEnabled | undefined;

export function setLangfuseHelpers(
  calcCost: typeof CalculateUsageCost,
  isEnabled: typeof IsLangfuseEnabled
): void {
  calculateUsageCostFn = calcCost;
  isLangfuseEnabledFn = isEnabled;
}

/** Build Langfuse costDetails from model + token usage. Returns undefined if no pricing data. */
export function toCostDetails(
  model: string,
  usage: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } | null | undefined
): { input: number; output: number; total: number } | undefined {
  if (!calculateUsageCostFn) return undefined;
  
  // Support both OpenAI (prompt_tokens/completion_tokens) and Anthropic (input_tokens/output_tokens)
  const inputTok = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const outputTok = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  if (!inputTok && !outputTok) return undefined;
  const cost = calculateUsageCostFn(model, inputTok, outputTok);
  if (cost.totalCost === 0) return undefined;
  return { input: cost.inputCost, output: cost.outputCost, total: cost.totalCost };
}

/** Normalize Anthropic usage (input_tokens/output_tokens) to Langfuse format */
export function toAnthropicUsageDetails(usage: any): Record<string, number> | undefined {
  if (!usage) return undefined;
  const details: Record<string, number> = {};

  // Map Anthropic fields to standard names Langfuse expects
  if (typeof usage.input_tokens === 'number') {
    details.prompt_tokens = usage.input_tokens;
    details.input_tokens = usage.input_tokens;
  }
  if (typeof usage.output_tokens === 'number') {
    details.completion_tokens = usage.output_tokens;
    details.output_tokens = usage.output_tokens;
  }
  if (details.prompt_tokens != null && details.completion_tokens != null) {
    details.total_tokens = details.prompt_tokens + details.completion_tokens;
  }

  // Include cache details if present
  if (typeof usage.cache_creation_input_tokens === 'number') {
    details.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  }
  if (typeof usage.cache_read_input_tokens === 'number') {
    details.cache_read_input_tokens = usage.cache_read_input_tokens;
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

/** Convert OpenAI usage to Langfuse format */
export function toUsageDetails(usage: any | null | undefined): Record<string, number> | undefined {
  if (!usage) return undefined;

  const usageDetails: Record<string, number> = {
    prompt_tokens: usage.prompt_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };

  if (usage.prompt_tokens_details) {
    for (const [key, value] of Object.entries(usage.prompt_tokens_details)) {
      if (typeof value === 'number') {
        usageDetails[`prompt_tokens_details_${key}`] = value;
      }
    }
  }

  if (usage.completion_tokens_details) {
    for (const [key, value] of Object.entries(usage.completion_tokens_details)) {
      if (typeof value === 'number') {
        usageDetails[`completion_tokens_details_${key}`] = value;
      }
    }
  }

  return usageDetails;
}

/** Normalize any numeric usage to details object */
export function toNumericUsageDetails(usage: unknown): Record<string, number> | undefined {
  if (!usage || typeof usage !== 'object') return undefined;

  const details: Record<string, number> = {};

  const flatten = (value: unknown, prefix = ''): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;

    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const field = prefix ? `${prefix}_${key}` : key;
      if (typeof nested === 'number') {
        details[field] = nested;
      } else if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        flatten(nested, field);
      }
    }
  };

  flatten(usage);
  return Object.keys(details).length > 0 ? details : undefined;
}
