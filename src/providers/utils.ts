// Provider Utilities

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ChatMessage, ContentBlock, ChatOptions, Config } from '../types.js';

// Anti-hallucination instructions injected between the Claude Code identity
// block and the actual system prompt. Prevents the model from roleplaying
// Claude Code's full behavior (XML tool calls, fabricated output, etc.)
export const TOOL_GUARD = `You are SkimpyClaw (NOT Claude Code CLI). Use only API tool_use — never text/XML tools. Never fabricate results.`;

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
      parameters: t.input_schema && t.input_schema.type ? t.input_schema : { type: 'object' as const, properties: {} },
    },
  }));
}

/**
 * Resolve model alias to actual model name.
 */
export function resolveModel(modelSpec: string, config: Config): string {
  // Check aliases first
  const aliased = config.models.aliases[modelSpec] || modelSpec;
  return migrateDeprecatedModelSpec(aliased);
}

function migrateDeprecatedModelSpec(modelSpec: string): string {
  const slashIdx = modelSpec.indexOf('/');
  const hasProvider = slashIdx > 0;
  const provider = hasProvider ? modelSpec.slice(0, slashIdx) : '';
  const bare = hasProvider ? modelSpec.slice(slashIdx + 1) : modelSpec;

  let migratedBare = bare;
  if (/^claude[-.]3[-.]5[-.]sonnet(?:[-_.].*)?$/i.test(bare)) {
    migratedBare = 'claude-sonnet-4-6';
  } else if (/^claude[-.]3[-.]5[-.]haiku(?:[-_.].*)?$/i.test(bare) || bare === 'claude-haiku') {
    migratedBare = 'claude-haiku-4-5';
  } else if (/^claude[-.]opus[-.]4(?:[-_.].*)?$/i.test(bare)) {
    migratedBare = 'claude-opus-4-6';
  }

  if (migratedBare === bare) return modelSpec;
  return hasProvider ? `${provider}/${migratedBare}` : migratedBare;
}

export interface ResolvedProviderRoute {
  resolvedModel: string;
  provider: string;
  modelId: string;
  isCodexModel: boolean;
}

/**
 * Resolve model alias and derive normalized provider route fields.
 */
export function resolveProviderRoute(modelSpec: string, config: Config): ResolvedProviderRoute {
  const resolvedModel = resolveModel(modelSpec, config);
  const provider = getProvider(resolvedModel);
  const modelId = stripProvider(resolvedModel);
  const isCodexModel = /\bcodex\b/i.test(modelId);
  return {
    resolvedModel,
    provider,
    modelId,
    isCodexModel,
  };
}

/**
 * Legacy compatibility: route openai/*codex models to codex provider when configured.
 */
export function shouldUseCodexAliasProvider(
  provider: string,
  isCodexModel: boolean,
  codexProviderConfigured: boolean
): boolean {
  return provider === 'openai' && isCodexModel && codexProviderConfigured;
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

/** Truncate tool result to maxBytes. Appends truncation notice. */
/**
 * Observation masking threshold. Tool outputs above this size are written to
 * a scratch file and replaced with a compact summary + file path.
 * Outputs below this are returned inline (no file I/O overhead).
 */
const MASK_THRESHOLD = 4000; // ~1000 tokens — must be high enough for typical file reads

/**
 * Mask large tool outputs by writing to scratch files.
 * Returns the original result if small enough, or a summary + file path if large.
 * Falls back to simple truncation if file write fails.
 */
export function truncateToolResult(result: string, _maxBytes: number = 10_240): string {
  if (result.length <= MASK_THRESHOLD) return result;

  try {
    const scratchDir = join(homedir(), '.skimpyclaw', 's');
    if (!existsSync(scratchDir)) mkdirSync(scratchDir, { recursive: true });

    const id = Math.random().toString(36).slice(2, 5);
    const filePath = join(scratchDir, id);
    writeFileSync(filePath, result);

    const home = homedir().replace(/\/+$/, '');
    const shortFP = filePath.startsWith(home) ? '~' + filePath.slice(home.length) : filePath;
    console.log(`[context-manager] Masked ${result.length} chars → ${filePath}`);
    return `→${shortFP}`;
  } catch (err) {
    // Fallback: simple truncation
    console.warn(`[context-manager] Masking failed: ${err instanceof Error ? err.message : err}`);
    return result.slice(0, MASK_THRESHOLD) + `\n\n[Truncated: ${result.length} chars total]`;
  }
}

/**
 * Write full output to a scratch file. Returns the file path, or null on failure.
 */
function writeScratchFile(result: string): string | null {
  try {
    const scratchDir = join(homedir(), '.skimpyclaw', 's');
    if (!existsSync(scratchDir)) mkdirSync(scratchDir, { recursive: true });
    const id = Math.random().toString(36).slice(2, 5);
    const filePath = join(scratchDir, id);
    writeFileSync(filePath, result);
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Structured split tool results: generates a semantic summary based on tool type.
 * For small results (<= MASK_THRESHOLD), returns unchanged.
 * For large results, writes full output to scratch file and returns a compact,
 * tool-aware summary with the scratch file path.
 */
export function splitToolResult(
  toolName: string,
  toolInput: Record<string, any>,
  result: string
): string {
  // Never split scratch file reads — these are already split results being retrieved
  const nameLower0 = toolName.toLowerCase();
  if (nameLower0 === 'read' || nameLower0 === 'read_file') {
    const filePath = toolInput.file_path || toolInput.path || '';
    const scratchPrefix = join(homedir(), '.skimpyclaw', 's');
    if (typeof filePath === 'string' && (filePath.startsWith(scratchPrefix) || filePath.startsWith('~/.skimpyclaw/s/') || filePath.startsWith('~/.skimpyclaw/scratch/'))) {
      return result;
    }
  }

  if (result.length <= MASK_THRESHOLD) return result;

  const scratchPath = writeScratchFile(result);
  if (!scratchPath) {
    // Fallback to legacy truncation
    return truncateToolResult(result);
  }

  // Use tilde-prefixed path in output to save tokens
  const home = homedir().replace(/\/+$/, '');
  const shortPath = scratchPath.startsWith(home) ? '~' + scratchPath.slice(home.length) : scratchPath;

  console.log(`[context-manager] Split ${result.length} chars (${toolName}) → ${scratchPath}`);

  const nameLower = toolName.toLowerCase();

  // Bash: preserve exit code and error lines (critical for model)
  if (nameLower === 'bash') {
    const lines = result.split('\n');
    const exitMatch = result.match(/exit code[:\s]+(\d+)/i);
    const exitInfo = exitMatch && exitMatch[1] !== '0' ? ` exit=${exitMatch[1]}` : '';
    const errLines = lines.filter(l => /^(error|fatal|ERR!)/i.test(l.trim()));
    const errNote = errLines.length > 0 ? `\n${errLines.slice(0, 3).join('\n')}` : '';
    return `${exitInfo}${errNote}\n→${shortPath}`.trimStart();
  }

  // All non-Bash tools: include a preview so the model has usable data
  const preview = result.slice(0, 800);
  const truncNote = result.length > 800 ? `\n... (${result.length} chars total)` : '';
  return `${preview}${truncNote}\nFull output: Read({"path":"${scratchPath}"})`;

}

/**
 * Compact old tool results in Anthropic-format messages.
 * Replaces tool_result content with '✓' for all results except the last
 * `keepRecent` messages. The model has already processed these results,
 * so we only need to preserve the structure (tool_use_id matching).
 *
 * Mutates the messages array in place for efficiency.
 */
export function compactOldResults(messages: any[], keepRecent: number = 2): void {
  if (messages.length <= keepRecent) return;
  const cutoff = messages.length - keepRecent;

  // Remove old messages entirely — keep only recent
  messages.splice(0, cutoff);

  // Ensure first message is user role (API requirement)
  if (messages.length > 0 && messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: '·' });
  }
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
