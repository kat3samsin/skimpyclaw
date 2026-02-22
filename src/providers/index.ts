// Providers Module - Unified AI Provider Interface

import type { Config, ChatMessage, ChatOptions, ToolConfig } from '../types.js';
import type { ExecuteToolContext } from '../tools/execute-context.js';
import type { ToolChatResult, ProviderChatParams, ProviderToolChatParams } from './types.js';

// Re-export types
export type { ToolChatResult, ProviderChatParams, ProviderToolChatParams } from './types.js';

// Re-export utilities
export {
  TOOL_GUARD,
  setUsingOAuth,
  isUsingOAuth,
  buildSystemParam,
  addToolCacheBreakpoint,
  contentToText,
  toOpenAITools,
  resolveModel,
  getProvider,
  stripProvider,
  buildThinkingConfig,
} from './utils.js';

// Re-export content converters
export { toOpenAIContent, toCodexContent, toCodexToolDefinitions } from './content.js';

// Re-export observability
export {
  setLangfuseHelpers,
  toCostDetails,
  toAnthropicUsageDetails,
  toUsageDetails,
  toNumericUsageDetails,
} from './observability.js';

// Import provider functions directly to avoid circular deps
import {
  setAnthropicClient,
  isAnthropicAvailable,
  chatAnthropic,
  chatWithToolsAnthropic,
} from './anthropic.js';

import {
  addOpenAIClient,
  clearOpenAIClients,
  isOpenAIAvailable,
  chatOpenAI,
  chatWithToolsOpenAI,
} from './openai.js';

import {
  addResponsesApiProvider,
  isResponsesApiProvider,
  setCodexAuthPath,
  setCodexBaseUrl,
  initCodexAuth,
  resetCodexProviderState,
  loadCodexAuth,
  isCodexAvailable,
  chatCodex,
  chatWithToolsCodex,
} from './codex.js';

import { setUsingOAuth, getProvider, stripProvider, resolveModel } from './utils.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// Re-export all provider functions
export {
  setAnthropicClient,
  isAnthropicAvailable,
  chatAnthropic,
  chatWithToolsAnthropic,
} from './anthropic.js';

export {
  addOpenAIClient,
  getOpenAIClient,
  hasOpenAIClient,
  clearOpenAIClients,
  resetOpenAIProviderState,
  isOpenAIAvailable,
  chatOpenAI,
  chatWithToolsOpenAI,
} from './openai.js';

export {
  addResponsesApiProvider,
  isResponsesApiProvider,
  setCodexAuthPath,
  setCodexBaseUrl,
  initCodexAuth,
  resetCodexProviderState,
  loadCodexAuth,
  getCodexAuth,
  isCodexAvailable,
  chatCodex,
  chatWithToolsCodex,
} from './codex.js';

// Initialize all providers from config
export async function initProviders(config: Config): Promise<void> {
  // Reset provider state so reloads strictly reflect current config.
  setAnthropicClient(null);
  setUsingOAuth(false);
  clearOpenAIClients();
  resetCodexProviderState();

  const anthropicConfig = config.models.providers.anthropic;
  
  // Initialize Anthropic if configured
  if (anthropicConfig?.apiKey || anthropicConfig?.authToken) {
    if (anthropicConfig.authToken) {
      // OAuth token path
      setUsingOAuth(true);
      setAnthropicClient(new Anthropic({
        apiKey: null,
        authToken: anthropicConfig.authToken,
        defaultHeaders: {
          'accept': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
          'user-agent': 'claude-cli/2.1.2 (external, cli)',
          'x-app': 'cli',
        },
        dangerouslyAllowBrowser: true,
      }));
      console.log('[providers] Initialized anthropic [OAuth]');
    } else if (anthropicConfig.apiKey) {
      setAnthropicClient(new Anthropic({ apiKey: anthropicConfig.apiKey }));
      console.log('[providers] Initialized anthropic');
    }
  }

  // Initialize all non-Anthropic providers
  for (const [name, providerConfig] of Object.entries(config.models.providers)) {
    if (name === 'anthropic' || !providerConfig) continue;

    // Codex OAuth uses ChatGPT backend, not OpenAI API
    if (providerConfig.authToken === 'codex') {
      if (providerConfig.authPath) setCodexAuthPath(providerConfig.authPath);
      if (providerConfig.baseURL) setCodexBaseUrl(providerConfig.baseURL);
      if (initCodexAuth()) {
        addResponsesApiProvider(name);
        console.log(`[providers] Initialized ${name} [codex ChatGPT backend]`);
      } else {
        console.log(`[providers] Skipping ${name} — no Codex OAuth token found`);
      }
      continue;
    }

    const apiKey = providerConfig.apiKey;
    if (!apiKey) continue;

    const opts: Record<string, any> = { apiKey };
    if (providerConfig.baseURL) opts.baseURL = providerConfig.baseURL;
    // Kimi Code API requires a coding-agent User-Agent with version string
    if (providerConfig.baseURL?.includes('kimi.com')) {
      opts.defaultHeaders = { 'User-Agent': 'claude-code/2.1.42' };
    }
    addOpenAIClient(name, new OpenAI(opts));
    console.log(`[providers] Initialized ${name}${providerConfig.baseURL ? ` (${providerConfig.baseURL})` : ''}`);
  }
}

// Unified chat function that routes to appropriate provider
export async function chat(
  messages: ChatMessage[],
  options: ChatOptions,
  config: Config
): Promise<string> {
  const resolvedModel = resolveModel(options.model, config);
  const provider = getProvider(resolvedModel);
  const modelId = stripProvider(resolvedModel);
  const chatOpts = { ...options, model: modelId };
  const isCodexModel = /\bcodex\b/i.test(modelId);
  const useCodexAliasProvider = provider === 'openai' && isCodexModel && isResponsesApiProvider('codex');

  // Route to Codex if available (supports openai/*-codex legacy alias)
  if ((isResponsesApiProvider(provider) || useCodexAliasProvider) && isCodexAvailable()) {
    return chatCodex({ messages, options: chatOpts, config });
  }
  if (isResponsesApiProvider(provider) || useCodexAliasProvider) {
    throw new Error(`Codex provider "${provider}" is configured but auth is unavailable. Run "codex" to re-authenticate.`);
  }

  // Route to Anthropic if available
  if (provider === 'anthropic' && isAnthropicAvailable()) {
    return chatAnthropic({ messages, options: chatOpts, config });
  }

  // Route to OpenAI-compatible
  if (isOpenAIAvailable(provider)) {
    return chatOpenAI({ messages, options: chatOpts, config }, provider);
  }

  throw new Error(`Unknown provider "${provider}" for model: ${resolvedModel}`);
}

// Unified chatWithTools function that routes to appropriate provider
export async function chatWithTools(
  messages: ChatMessage[],
  options: ChatOptions,
  config: Config,
  toolConfig: ToolConfig,
  toolContext?: ExecuteToolContext
): Promise<ToolChatResult> {
  const resolvedModel = resolveModel(options.model, config);
  const provider = getProvider(resolvedModel);
  const modelId = stripProvider(resolvedModel);
  const chatOpts = { ...options, model: modelId };
  const isCodexModel = /\bcodex\b/i.test(modelId);
  const useCodexAliasProvider = provider === 'openai' && isCodexModel && isResponsesApiProvider('codex');

  // Route to Codex if available (supports openai/*-codex legacy alias)
  if ((isResponsesApiProvider(provider) || useCodexAliasProvider) && isCodexAvailable()) {
    return chatWithToolsCodex({ messages, options: chatOpts, config, toolConfig, toolContext });
  }
  if (isResponsesApiProvider(provider) || useCodexAliasProvider) {
    throw new Error(`Codex provider "${provider}" is configured but auth is unavailable. Run "codex" to re-authenticate.`);
  }

  // Route to Anthropic if available
  if (provider === 'anthropic' && isAnthropicAvailable()) {
    return chatWithToolsAnthropic({ messages, options: chatOpts, config, toolConfig, toolContext });
  }

  // Route to OpenAI-compatible
  if (isOpenAIAvailable(provider)) {
    return chatWithToolsOpenAI({ messages, options: chatOpts, config, toolConfig, toolContext }, provider);
  }

  throw new Error(`Unknown provider "${provider}" for model: ${resolvedModel}`);
}
