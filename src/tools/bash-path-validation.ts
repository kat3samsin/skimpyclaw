// Bash argument path validation — extracts file paths from command tokens
// and validates them against the allowedPaths list.

import { resolve } from 'path';
import { homedir } from 'os';
import {
  getCommandSegments,
  getSegmentCommandIndex,
  getExecutableName,
} from '../exec-approval.js';
import { isPathAllowed } from './path-utils.js';

// --- Path-like token detection ---

/**
 * Returns true if a shell token looks like a file/directory path.
 * Matches: /foo, ./foo, ../foo, ~/foo
 * Does NOT match: flags (-f, --file), bare words (foo), URLs (https://...)
 */
export function isPathLikeToken(token: string): boolean {
  const t = token.trim();
  if (!t || t === '-' || t === '--') return false;

  // Absolute path
  if (t.startsWith('/')) return true;
  // Relative paths
  if (t.startsWith('./') || t.startsWith('../') || t === '.' || t === '..') return true;
  // Home-relative path
  if (t.startsWith('~/') || t === '~') return true;

  return false;
}

// --- Interpreter script target extraction ---

const INTERPRETERS = new Set([
  'python', 'python3', 'python3.11', 'python3.12', 'python3.13',
  'node', 'deno', 'bun',
  'perl', 'ruby', 'php', 'lua',
  'bash', 'sh', 'zsh', 'fish',
]);

/** Flags that consume the next argument (so it's not a script path). */
const INTERPRETER_FLAGS_WITH_VALUE = new Set([
  '-c', '-e', '-m', '-W', '-X', '-O',
  '--eval', '--execute', '--require',
]);

/** Flags that mean "read from stdin" or "inline code follows" — stop looking for script path. */
const INTERPRETER_INLINE_FLAGS = new Set([
  '-c', '-e', '--eval', '--execute', '-r', '-Command',
]);

/**
 * For an interpreter command segment, extract the script file path if present.
 * Returns null if the command uses inline execution (-c, -e) or reads from stdin.
 */
export function extractScriptTarget(segment: string[]): string | null {
  const cmdIdx = getSegmentCommandIndex(segment);
  if (cmdIdx >= segment.length) return null;

  const cmd = getExecutableName(segment[cmdIdx]);
  if (!INTERPRETERS.has(cmd)) return null;

  const args = segment.slice(cmdIdx + 1);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Inline execution — no script file to validate
    if (INTERPRETER_INLINE_FLAGS.has(arg)) return null;

    // Flag that consumes next arg — skip both
    if (INTERPRETER_FLAGS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }

    // Skip other flags (single or double dash)
    if (arg.startsWith('-')) continue;

    // First non-flag argument is the script path
    return arg;
  }

  return null;
}

// --- Path extraction from full command ---

/**
 * Extract all file-path-like tokens from a shell command.
 * Handles piped/chained commands. Resolves ~ and relative paths using cwd.
 * Also extracts script targets from interpreter commands.
 */
export function extractPathsFromCommand(command: string, cwd?: string): string[] {
  const segments = getCommandSegments(command);
  const paths: string[] = [];
  const baseCwd = cwd || process.cwd();

  for (const segment of segments) {
    const cmdIdx = getSegmentCommandIndex(segment);

    // Check for interpreter script target
    const scriptTarget = extractScriptTarget(segment);
    if (scriptTarget) {
      paths.push(resolvePath(scriptTarget, baseCwd));
    }

    // Check all non-command tokens for path-like values
    for (let i = cmdIdx + 1; i < segment.length; i++) {
      const token = segment[i];
      if (isPathLikeToken(token)) {
        paths.push(resolvePath(token, baseCwd));
      }
    }
  }

  // Deduplicate
  return [...new Set(paths)];
}

/**
 * Resolve a token to an absolute path, expanding ~ and relative paths.
 */
function resolvePath(token: string, cwd: string): string {
  if (token.startsWith('~/') || token === '~') {
    return resolve(homedir(), token.slice(2) || '.');
  }
  return resolve(cwd, token);
}

// --- Validation ---

/**
 * Validate that all file paths in a bash command are within allowedPaths.
 * Returns null if all paths are valid, or an error message string if any are outside.
 */
export function validateBashPaths(
  command: string,
  cwd: string | undefined,
  allowedPaths: string[],
): string | null {
  // If no allowedPaths configured, skip validation (permissive mode)
  if (!allowedPaths || allowedPaths.length === 0) return null;

  const paths = extractPathsFromCommand(command, cwd);
  const blocked: string[] = [];

  for (const p of paths) {
    if (!isPathAllowed(p, allowedPaths)) {
      blocked.push(p);
    }
  }

  if (blocked.length === 0) return null;

  return `Error: Command references paths outside allowed directories: ${blocked.join(', ')}`;
}
