// Providers Module - Unified AI Provider Interface
//
// Provider registry pattern: adapters implement ProviderAdapter (chat, chatWithTools, isAvailable).
// Routing resolves a model spec to an adapter and delegates to it.

import type { Config, ChatMessage, ChatOptions, ToolConfig } from '../types.js';
import type { ExecuteToolContext } from '../tools/execute-context.js';
import type { ToolChatResult } from './types.js';
import type { ProviderAdapter } from './adapter.js';
import { calculateUsageCost } from '../langfuse.js';

// Re-export types
export type { ToolChatResult, ProviderChatParams, ProviderToolChatParams } from './types.js';
export type { ProviderAdapter } from './adapter.js';

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
  resolveProviderRoute,
  shouldUseCodexAliasProvider,
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
import { setLangfuseHelpers } from './observability.js';

// Import provider module functions for init and backward-compat re-exports
import {
  setAnthropicClient,
} from './anthropic.js';

import {
  addResponsesApiProvider,
  isResponsesApiProvider,
  setCodexAuthPath,
  setCodexBaseUrl,
  initCodexAuth,
  resetCodexProviderState,
} from './codex.js';

import {
  setUsingOAuth,
  resolveProviderRoute,
  shouldUseCodexAliasProvider,
} from './utils.js';
import Anthropic from '@anthropic-ai/sdk';

// Lazy adapter imports (avoid circular deps at module load time)
import { AnthropicAdapter } from './adapters/anthropic-adapter.js';
import { CodexAdapter } from './adapters/codex-adapter.js';

// Wire provider observability helpers to runtime cost calculator.
setLangfuseHelpers(calculateUsageCost);

// ---------------------------------------------------------------------------
// Provider Registry
// ---------------------------------------------------------------------------

/**
 * Resolve a provider name to a ProviderAdapter instance.
 * Adapters are lightweight — creating one per call is fine.
 */
export function getAdapter(provider: string): ProviderAdapter {
  if (provider === 'anthropic') return new AnthropicAdapter();
  if (provider === 'codex') return new CodexAdapter();
  // Codex providers are registered dynamically via addResponsesApiProvider
  if (isResponsesApiProvider(provider)) return new CodexAdapter();
  throw new Error(`Unknown provider "${provider}"`);
}

interface NormalizedChatRoute {
  resolvedModel: string;
  provider: string;
  modelId: string;
  chatOpts: ChatOptions;
  useCodexAliasProvider: boolean;
}

function normalizeChatRoute(options: ChatOptions, config: Config): NormalizedChatRoute {
  const route = resolveProviderRoute(options.model, config);
  const { resolvedModel, provider, modelId, isCodexModel } = route;
  return {
    resolvedModel,
    provider,
    modelId,
    chatOpts: { ...options, model: modelId },
    useCodexAliasProvider: shouldUseCodexAliasProvider(provider, isCodexModel, isResponsesApiProvider('codex')),
  };
}

/**
 * Resolve routing and return the correct adapter + normalized options.
 * Handles the Codex alias compatibility path (openai/*-codex → codex provider).
 */
function resolveAdapter(
  options: ChatOptions,
  config: Config,
): { adapter: ProviderAdapter; resolvedModel: string; chatOpts: ChatOptions } {
  const { resolvedModel, provider, chatOpts, useCodexAliasProvider } = normalizeChatRoute(options, config);

  // Codex alias compatibility: openai/*-codex routes to codex when configured
  if (provider === 'codex' || useCodexAliasProvider || isResponsesApiProvider(provider)) {
    const codexAdapter = new CodexAdapter();
    if (codexAdapter.isAvailable()) {
      return { adapter: codexAdapter, resolvedModel, chatOpts };
    }
    throw new Error(`Codex provider "${provider}" is configured but auth is unavailable. Run "codex" to re-authenticate.`);
  }

  let adapter: ProviderAdapter;
  try {
    adapter = getAdapter(provider);
  } catch {
    throw new Error(`Unknown provider "${provider}" for model: ${resolvedModel}`);
  }
  if (adapter.isAvailable()) {
    return { adapter, resolvedModel, chatOpts };
  }

  throw new Error(`Unknown provider "${provider}" for model: ${resolvedModel}`);
}

// ---------------------------------------------------------------------------
// Backward-compat re-exports (provider module functions)
// ---------------------------------------------------------------------------

// Anthropic
export {
  setAnthropicClient,
  isAnthropicAvailable,
  chatAnthropic,
  chatWithToolsAnthropic,
} from './anthropic.js';

// Codex
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

// ---------------------------------------------------------------------------
// Provider Initialization (unchanged behavior)
// ---------------------------------------------------------------------------

export async function initProviders(config: Config): Promise<void> {
  // Reset provider state so reloads strictly reflect current config.
  setAnthropicClient(null);
  setUsingOAuth(false);
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

  // Initialize Codex providers. API-key chat providers are not core.
  for (const [name, providerConfig] of Object.entries(config.models.providers)) {
    if (name === 'anthropic' || !providerConfig) continue;

    // Codex OAuth uses ChatGPT backend, not OpenAI API. Older configs may
    // only have models.providers.codex.authPath, so keep that shape working.
    if (providerConfig.authToken === 'codex' || (name === 'codex' && providerConfig.authPath)) {
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
  }
}

// ---------------------------------------------------------------------------
// Unified chat + chatWithTools — route via adapter registry
// ---------------------------------------------------------------------------

/** Unified chat function that routes to appropriate provider via adapter. */
export async function chat(
  messages: ChatMessage[],
  options: ChatOptions,
  config: Config
): Promise<string> {
  const { adapter, chatOpts } = resolveAdapter(options, config);
  return adapter.chat(messages, chatOpts, config);
}

/** Unified chatWithTools function that routes to appropriate provider via adapter. */
export async function chatWithTools(
  messages: ChatMessage[],
  options: ChatOptions,
  config: Config,
  toolConfig: ToolConfig,
  toolContext?: ExecuteToolContext
): Promise<ToolChatResult> {
  const { adapter, chatOpts } = resolveAdapter(options, config);

  const { runToolLoop } = await import('./tool-loop.js');
  return runToolLoop(adapter, messages, chatOpts, config, toolConfig, toolContext);
}
