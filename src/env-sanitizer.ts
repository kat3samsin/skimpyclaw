/** Env var name patterns that should never be exposed to model-executed commands. */
const SENSITIVE_ENV_PATTERNS = [
  /api.?key/i, /token/i, /secret/i, /password/i, /credential/i,
  /^ANTHROPIC_/i, /^OPENAI_/i, /^CLAUDE/i, /^CODEX_/i, /^MINIMAX_/i,
  /^KIMI_/i, /^TOGETHER_/i, /^GROQ_/i, /^OPENROUTER_/i,
];

/** Env vars that match SENSITIVE_ENV_PATTERNS but should be kept (e.g. tool auth). */
const SENSITIVE_ENV_ALLOWLIST = new Set(['GH_TOKEN']);

/** Common tool paths that may be missing when launched as a service/daemon. */
const EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];

export function sanitizeExecEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (!SENSITIVE_ENV_ALLOWLIST.has(key) && SENSITIVE_ENV_PATTERNS.some(p => p.test(key))) {
      delete env[key];
    }
  }

  const currentPath = env.PATH || '';
  const missing = EXTRA_PATH_DIRS.filter(d => !currentPath.includes(d));
  if (missing.length > 0) {
    env.PATH = currentPath ? `${currentPath}:${missing.join(':')}` : missing.join(':');
  }
  return env;
}
