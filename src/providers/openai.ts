// OpenAI-Compatible Provider (OpenAI, OpenRouter, Groq, etc.)

import OpenAI from 'openai';
import { startObservation } from '@langfuse/tracing';
import type { ProviderChatParams, ProviderToolChatParams, ToolChatResult } from './types.js';
import { stripProvider } from './utils.js';
import { toOpenAIContent } from './content.js';
import { toUsageDetails, toCostDetails } from './observability.js';
import { toErrorMessage } from '../utils.js';
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
  return startObservation(name, attributes, { asType: 'generation' });
}

export async function chatOpenAI(params: ProviderChatParams, provider: string): Promise<string> {
  const client = openaiClients.get(provider);
  if (!client) {
    throw new Error(`OpenAI client not initialized for provider: ${provider}`);
  }

  const { messages, options, config } = params;
  const modelId = stripProvider(options.model, openaiClients);
  const providerBaseURL = config.models.providers[provider]?.baseURL || '';
  const isKimiLike = providerBaseURL.includes('kimi.com') || providerBaseURL.includes('moonshot.ai');
  const kimiRequestExtras = isKimiLike
    ? { extra_body: { interleaved: { field: 'reasoning_content' } } }
    : {};

  const openaiMessages: any[] = messages.map(m => ({
    role: m.role,
    content: toOpenAIContent(m.content),
  }));

  const genObs = await startGenerationObservation(`${provider}:${modelId}`, {
    input: { messages: openaiMessages },
    model: modelId,
    modelParameters: {
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature,
    },
    metadata: { provider },
  });

  try {
    const response = await client.chat.completions.create({
      model: modelId,
      messages: openaiMessages,
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature,
      ...kimiRequestExtras,
    });

    let content = response.choices[0]?.message?.content || '';
    // Strip <think>...</think> reasoning blocks (e.g. MiniMax M2.x)
    content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();

    recordOpenAIUsage({ model: modelId, provider, usage: response.usage, trigger: 'api' });
    
    genObs?.update({
      output: response.choices[0]?.message,
      usageDetails: toUsageDetails(response.usage),
      costDetails: toCostDetails(modelId, response.usage),
    });
    genObs?.end();

    return content;
  } catch (err) {
    const errorMessage = toErrorMessage(err);
    genObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
    genObs?.end();
    throw err;
  }
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
