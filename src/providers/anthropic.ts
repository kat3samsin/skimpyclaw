// Anthropic Provider

import Anthropic from '@anthropic-ai/sdk';
import { startObservation } from '@langfuse/tracing';
import type { ProviderChatParams, ProviderToolChatParams, ToolChatResult } from './types.js';
import { buildSystemParam, contentToText, stripProvider, buildThinkingConfig } from './utils.js';
import { toAnthropicUsageDetails, toCostDetails } from './observability.js';
import { toErrorMessage } from '../utils.js';
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
  return startObservation(name, attributes, { asType: 'generation' });
}

export async function chatAnthropic(params: ProviderChatParams): Promise<string> {
  if (!anthropicClient) {
    throw new Error('Anthropic client not initialized');
  }

  const { messages, options, config } = params;
  const modelId = stripProvider(options.model);
  
  const systemMessage = messages.find(m => m.role === 'system');
  const chatMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content as any,
    }));

  // Build request parameters
  const cacheEnabled = config.models?.promptCaching !== false;
  const anthropicParams: Anthropic.MessageCreateParams = {
    model: modelId,
    max_tokens: options.maxTokens || 4096,
    messages: chatMessages,
  };

  const systemParam = buildSystemParam(contentToText(systemMessage?.content || ''), cacheEnabled);
  if (systemParam) {
    anthropicParams.system = systemParam;
  }

  // Add extended thinking if requested
  const thinkingConfig = buildThinkingConfig(options.thinking);
  if (thinkingConfig) {
    anthropicParams.thinking = {
      type: 'enabled',
      budget_tokens: thinkingConfig.budget,
    };
    anthropicParams.max_tokens = Math.max(anthropicParams.max_tokens, thinkingConfig.maxTokens);
  }

  const genObs = await startGenerationObservation(`anthropic:${modelId}`, {
    input: { system: systemMessage?.content, messages: chatMessages },
    model: modelId,
    modelParameters: {
      max_tokens: anthropicParams.max_tokens,
      ...(options.thinking && options.thinking !== 'none' ? { thinking: options.thinking } : {}),
    },
    metadata: { provider: 'anthropic' },
  });

  try {
    const response = await anthropicClient.messages.create(anthropicParams);
    const usage = (response as any).usage;

    // Log cache metrics
    if (usage?.cache_read_input_tokens > 0 || usage?.cache_creation_input_tokens > 0) {
      console.log(`[cache] read=${usage.cache_read_input_tokens || 0} created=${usage.cache_creation_input_tokens || 0}`);
    }
    recordAnthropicUsage({ model: modelId, usage, trigger: 'api' });

    // Extract text content
    const textContent = response.content.find(c => c.type === 'text');
    const text = textContent?.text || '';
    
    genObs?.update({
      output: { text },
      usageDetails: toAnthropicUsageDetails(usage),
      costDetails: toCostDetails(modelId, usage),
    });
    genObs?.end();

    return text;
  } catch (err) {
    const errorMessage = toErrorMessage(err);
    genObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
    genObs?.end();
    throw err;
  }
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
