// Anthropic Provider

import Anthropic from '@anthropic-ai/sdk';
import type { ProviderChatParams, ProviderToolChatParams, ToolChatResult } from './types.js';

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
