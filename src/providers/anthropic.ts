// Anthropic Provider

import Anthropic from '@anthropic-ai/sdk';
import type { ProviderChatParams, ProviderToolChatParams, ToolChatResult } from './types.js';
import { toCostDetails } from './observability.js';
import { buildUsageRecord, recordUsage } from '../usage.js';

let anthropicClient: Anthropic | null = null;

export function setAnthropicClient(client: Anthropic | null): void {
  anthropicClient = client;
}

export function getAnthropicClient(): Anthropic | null {
  return anthropicClient;
}

export function isAnthropicAvailable(): boolean {
  return anthropicClient !== null;
}

const LANGFUSE_APP_NAME = 'skimpyclaw';

function recordAnthropicUsage(params: {
  model: string;
  usage: any;
  trigger?: string;
  agentId?: string;
}): void {
  const usage = params.usage;
  const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0;
  if (inputTokens === 0 && outputTokens === 0) return;

  const cost = toCostDetails(params.model, usage);
  recordUsage(buildUsageRecord({
    model: params.model,
    provider: 'anthropic',
    inputTokens,
    outputTokens,
    inputCost: cost?.input ?? 0,
    outputCost: cost?.output ?? 0,
    totalCost: cost?.total ?? 0,
    trigger: params.trigger || 'api',
    agentId: params.agentId,
    cacheReadTokens: typeof usage?.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined,
    cacheCreationTokens: typeof usage?.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined,
  }));
}

async function startGenerationObservation(name: string, attributes: Record<string, any>) {
  // Check langfuse enabled through dynamic import to avoid circular deps
  const { isLangfuseEnabled } = await import('../langfuse.js');
  if (!isLangfuseEnabled()) return null;
  attributes.metadata = { app: LANGFUSE_APP_NAME, ...attributes.metadata };
  const { startObservation } = await import('@langfuse/tracing');
  return startObservation(name, attributes, { asType: 'generation' });
}

/** @deprecated Use adapter.chat() via the provider registry instead. */
export async function chatAnthropic(params: ProviderChatParams): Promise<string> {
  const { AnthropicAdapter } = await import('./adapters/anthropic-adapter.js');
  const adapter = new AnthropicAdapter();
  return adapter.chat(params.messages, params.options, params.config);
}

export async function chatWithToolsAnthropic(params: ProviderToolChatParams): Promise<ToolChatResult> {
  if (!anthropicClient) {
    throw new Error('Anthropic client not initialized');
  }
  const { runToolLoop } = await import('./tool-loop.js');
  const { AnthropicAdapter } = await import('./adapters/anthropic-adapter.js');
  const adapter = new AnthropicAdapter();
  return runToolLoop(adapter, params.messages, params.options, params.config, params.toolConfig, params.toolContext);
}
