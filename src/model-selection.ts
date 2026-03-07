import type { Config } from './types.js';
import { resolveModel } from './providers/utils.js';

const FULL_MODEL_SPEC_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/;
const BARE_MODEL_ID_RE = /^[A-Za-z0-9.-]+$/;
const SAFE_MODEL_INPUT_RE = /^[A-Za-z0-9._/-]+$/;
const MODEL_SELECTION_USAGE = 'Use alias, provider/model, or model-id.';

export interface ResolvedModelSelection {
  ok: boolean;
  resolved?: string;
  aliasUsed?: string;
  error?: string;
}

export function listModelAliases(config: Config): string[] {
  return Object.keys(config.models.aliases || {}).sort((a, b) => a.localeCompare(b));
}

export function formatAliases(config: Config): string {
  const aliases = listModelAliases(config);
  return aliases.length > 0 ? aliases.join(', ') : '(none)';
}

export function getModelSelectionUsage(): string {
  return MODEL_SELECTION_USAGE;
}

export function formatModelSelectionError(error: string, config: Config): string {
  return `${error}\n\nAvailable aliases: ${formatAliases(config)}\n${MODEL_SELECTION_USAGE}`;
}

/**
 * Resolve /model command input.
 * Accepts:
 * - configured alias
 * - full provider/model spec (e.g. anthropic/claude-sonnet-4-5)
 */
export function resolveModelSelection(input: string, config: Config): ResolvedModelSelection {
  const value = input.trim();
  if (!value) {
    return { ok: false, error: 'Model value is required.' };
  }

  const aliasTarget = config.models.aliases[value];
  if (aliasTarget) {
    return { ok: true, resolved: resolveModel(value, config), aliasUsed: value };
  }

  if (FULL_MODEL_SPEC_RE.test(value)) {
    return { ok: true, resolved: resolveModel(value, config) };
  }

  // Accept bare model IDs only if they contain a version-like pattern (digits after a hyphen/dot)
  // e.g. "claude-sonnet-4-5", "gpt-5.3-codex" — but NOT "claude-opuis"
  if (BARE_MODEL_ID_RE.test(value) && /[-.]/.test(value) && /\d/.test(value)) {
    return { ok: true, resolved: resolveModel(value, config) };
  }

  if (!SAFE_MODEL_INPUT_RE.test(value) || value.includes('/')) {
    return {
      ok: false,
      error: `Invalid model selection: "${value}". ${MODEL_SELECTION_USAGE}`,
    };
  }

  return {
    ok: false,
    error: `Unknown model alias: "${value}"`,
  };
}
