// Provider Utilities

import type { ChatMessage, ContentBlock, ChatOptions, Config } from '../types.js';

// Anti-hallucination instructions injected between the Claude Code identity
// block and the actual system prompt. Prevents the model from roleplaying
// Claude Code's full behavior (XML tool calls, fabricated output, etc.)
export const TOOL_GUARD = `You are a personal assistant running inside SkimpyClaw.
You are NOT the full Claude Code CLI. Do NOT roleplay as Claude Code.

## Tool Rules
- You have ONLY the tools provided via the API tool_use mechanism.
- Tool names are case-sensitive. Call tools exactly as listed.
- NEVER output tool calls as text/XML/JSON. Use the API tool_use mechanism only.
- NEVER fabricate tool results or file contents. If you haven't read a file, say so.
- NEVER invent tools that are not in your tool list (no str_replace_editor, no view, etc.)
- If a Browser tool is available, you DO have web-browsing access via that tool. Use it instead of claiming you can't browse.
- If you need information, use a tool to get it. Do not guess.`;

// Track if using OAuth (requires Claude Code identity)
let usingOAuth = false;

export function setUsingOAuth(value: boolean): void {
  usingOAuth = value;
}

export function isUsingOAuth(): boolean {
  return usingOAuth;
}

/**
 * Build the system parameter for Anthropic API calls.
 * For OAuth: returns an array with Claude Code identity + guard + actual prompt as separate blocks.
 * For API key: returns the prompt string directly (or array with cache_control if caching enabled).
 * When cacheEnabled, adds cache_control breakpoint to the last system block.
 */
export function buildSystemParam(
  systemContent: string | undefined,
  cacheEnabled: boolean = false
): string | Array<{type: 'text', text: string, cache_control?: {type: 'ephemeral'}}> | undefined {
  if (!systemContent) return undefined;

  if (usingOAuth) {
    const blocks: Array<{type: 'text', text: string, cache_control?: {type: 'ephemeral'}}> = [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: 'text', text: TOOL_GUARD },
      { type: 'text', text: systemContent },
    ];
    if (cacheEnabled) {
      blocks[2].cache_control = { type: 'ephemeral' };
    }
    return blocks as any;
  }

  if (cacheEnabled) {
    return [{ type: 'text' as const, text: systemContent, cache_control: { type: 'ephemeral' } }];
  }
  return systemContent;
}

/**
 * Add cache_control breakpoint to the last tool definition.
 * One breakpoint on the last tool caches the entire tools array.
 */
export function addToolCacheBreakpoint(toolDefs: any[]): void {
  if (toolDefs.length === 0) return;
  if (toolDefs[toolDefs.length - 1].cache_control) return;
  toolDefs[toolDefs.length - 1].cache_control = { type: 'ephemeral' };
}

/**
 * Convert content array to text-only for non-vision models.
 */
export function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;

  const textParts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'image') {
      textParts.push('[Image attached — vision not supported with this provider]');
    }
  }
  return textParts.join('\n');
}

/**
 * Convert Anthropic-format tool definitions to OpenAI function calling format.
 */
export function toOpenAITools(toolDefs: any[]): any[] {
  return toolDefs.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/**
 * Resolve model alias to actual model name.
 */
export function resolveModel(modelSpec: string, config: Config): string {
  // Check aliases first
  if (config.models.aliases[modelSpec]) {
    return config.models.aliases[modelSpec];
  }
  return modelSpec;
}

/**
 * Get provider name from model spec.
 */
export function getProvider(model: string): string {
  // Explicit prefix: "openrouter/google/gemini-2.0-flash" → "openrouter"
  const slashIdx = model.indexOf('/');
  if (slashIdx > 0) {
    const prefix = model.slice(0, slashIdx);
    // Known Anthropic prefix
    if (prefix === 'anthropic') return 'anthropic';
    // Any other prefix = provider name (openai, openrouter, groq, together, etc.)
    return prefix;
  }
  // No prefix: infer from model name
  if (model.includes('claude')) return 'anthropic';
  if (model.includes('gpt')) return 'openai';
  // Default to anthropic
  return 'anthropic';
}

/**
 * Strip provider prefix from model name.
 */
export function stripProvider(model: string, openaiClients?: Map<string, unknown>, responsesApiProviders?: Set<string>): string {
  const slashIdx = model.indexOf('/');
  if (slashIdx > 0) {
    const prefix = model.slice(0, slashIdx);
    // When provider registries are omitted, assume provider/model format and strip.
    if (!openaiClients && !responsesApiProviders) {
      return model.slice(slashIdx + 1);
    }
    // Only strip the first prefix if it matches a known provider
    if (
      prefix === 'anthropic' ||
      openaiClients?.has(prefix) ||
      responsesApiProviders?.has(prefix)
    ) {
      return model.slice(slashIdx + 1);
    }
  }
  return model;
}

/**
 * Build thinking config based on thinking level.
 */
export function buildThinkingConfig(thinking?: 'none' | 'low' | 'medium' | 'high'): { budget: number; maxTokens: number } | undefined {
  if (!thinking || thinking === 'none') return undefined;
  
  const budgetTokens: Record<string, number> = {
    low: 2048,
    medium: 8192,
    high: 16384,
  };
  const budget = budgetTokens[thinking] || 2048;
  return {
    budget,
    maxTokens: budget + 4096,
  };
}
