// OpenAI-Compatible Provider (OpenAI, OpenRouter, Groq, etc.)

import OpenAI from 'openai';
import type { ProviderChatParams, ProviderToolChatParams, ToolChatResult } from './types.js';
import { toCostDetails } from './observability.js';
import { buildUsageRecord, recordUsage } from '../usage.js';

// Map of provider name → OpenAI client
const openaiClients = new Map<string, OpenAI>();

export function addOpenAIClient(name: string, client: OpenAI): void {
  openaiClients.set(name, client);
}

export function getOpenAIClient(name: string): OpenAI | undefined {
  return openaiClients.get(name);
}

export function hasOpenAIClient(name: string): boolean {
  return openaiClients.has(name);
}

export function clearOpenAIClients(): void {
  openaiClients.clear();
}

export function resetOpenAIProviderState(): void {
  openaiClients.clear();
}

export function isOpenAIAvailable(provider: string): boolean {
  return openaiClients.has(provider);
}

const LANGFUSE_APP_NAME = 'skimpyclaw';

export function recordOpenAIUsage(params: {
  model: string;
  provider: string;
  usage: any;
  trigger?: string;
  agentId?: string;
}): void {
  const usage = params.usage;
  let inputTokens = typeof usage?.prompt_tokens === 'number'
    ? usage.prompt_tokens
    : (typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0);
  const outputTokens = typeof usage?.completion_tokens === 'number'
    ? usage.completion_tokens
    : (typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0);

  // Some OpenAI-compatible providers only return total_tokens.
  if (inputTokens === 0 && outputTokens === 0 && typeof usage?.total_tokens === 'number') {
    inputTokens = usage.total_tokens;
  }

  const cost = toCostDetails(params.model, usage);
  recordUsage(buildUsageRecord({
    model: params.model,
    provider: params.provider,
    inputTokens,
    outputTokens,
    inputCost: cost?.input ?? 0,
    outputCost: cost?.output ?? 0,
    totalCost: cost?.total ?? 0,
    trigger: params.trigger || 'api',
    agentId: params.agentId,
  }));
}

async function startGenerationObservation(name: string, attributes: Record<string, any>) {
  const { isLangfuseEnabled } = await import('../langfuse.js');
  if (!isLangfuseEnabled()) return null;
  attributes.metadata = { app: LANGFUSE_APP_NAME, ...attributes.metadata };
  const { startObservation } = await import('@langfuse/tracing');
  return startObservation(name, attributes, { asType: 'generation' });
}

/** @deprecated Use adapter.chat() via the provider registry instead. */
export async function chatOpenAI(params: ProviderChatParams, provider: string): Promise<string> {
  const { OpenAIAdapter } = await import('./adapters/openai-adapter.js');
  const adapter = new OpenAIAdapter(provider);
  return adapter.chat(params.messages, params.options, params.config);
}

export async function chatWithToolsOpenAI(params: ProviderToolChatParams, provider: string): Promise<ToolChatResult> {
  const client = openaiClients.get(provider);
  if (!client) {
    throw new Error(`OpenAI client not initialized for provider: ${provider}`);
  }
  const { runToolLoop } = await import('./tool-loop.js');
  const { OpenAIAdapter } = await import('./adapters/openai-adapter.js');
  const adapter = new OpenAIAdapter(provider);
  return runToolLoop(adapter, params.messages, params.options, params.config, params.toolConfig, params.toolContext);
}
