// Tool definitions and executors for Anthropic API tool_use

import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { TTLCache } from './cache.js';
import { toErrorMessage } from './utils.js';
import type { ToolConfig } from './types.js';
import {
  fromClaudeCodeName,
  toClaudeCodeName,
  BUILTIN_TOOL_DEFINITIONS,
  FETCH_TOOL_DEFINITION,
  TOOL_DEFINITIONS,
  CODE_WITH_AGENT_TOOL,
  CHECK_CODE_AGENT_TOOL,
  DELEGATE_TO_AGENT_TOOL,
} from './tools/definitions.js';
import type { ExecuteToolContext } from './tools/execute-context.js';
import { executeReadFile, executeWriteFileLocked, executeListDirectory } from './tools/file-tools.js';
import { executeBash } from './tools/bash-tool.js';
import { executeFetch } from './tools/fetch-tool.js';

// Re-export from code-agents module for backward compatibility
export {
  // Registry functions
  getActiveCodeAgents,
  getRecentCodeAgents,
  getAllCodeAgents,
  getCodeAgent,
  cancelCodeAgent,
  restoreCodeAgentTasks,
  // Config
  setCodeAgentConfig,
  // Executor functions
  runValidation,
  runCodeAgentBackground,
  // Utilities
  buildCodeAgentArgs,
  // Parsers
  parseStreamJsonForLive,
} from './code-agents/index.js';

// Re-export from definitions
export {
  fromClaudeCodeName,
  toClaudeCodeName,
  BUILTIN_TOOL_DEFINITIONS,
  FETCH_TOOL_DEFINITION,
  TOOL_DEFINITIONS,
  CODE_WITH_AGENT_TOOL,
  CHECK_CODE_AGENT_TOOL,
  DELEGATE_TO_AGENT_TOOL,
};
export type { ExecuteToolContext };
// Re-export types for backward compatibility
export type { CodeAgentTask } from './code-agents/index.js';

// --- MCP (mcporter) ---

let mcpRuntime: any = null;
let mcpHealthInterval: ReturnType<typeof setInterval> | null = null;

/** Last time MCP tools were successfully discovered (epoch ms) */
let mcpLastDiscoveredAt = 0;
/** How often to re-validate MCP tools (5 minutes) */
const MCP_REDISCOVERY_INTERVAL_MS = 5 * 60 * 1000;

/**
 * MCP health check — periodically re-discovers tools to detect daemon restarts.
 * Runs every 5 minutes. If the runtime is stale (daemon died), clears caches
 * so the next getToolDefinitions() call triggers fresh discovery.
 */
function startMcpHealthCheck(): void {
  if (mcpHealthInterval) return;
  mcpHealthInterval = setInterval(async () => {
    try {
      const runtime = await getMcpRuntime();
      const servers = runtime.listServers();
      if (servers.length === 0 && discoveredMcpTools && discoveredMcpTools.length > 0) {
        // Runtime lost its servers — daemon likely died
        console.warn('[mcp] Health check: runtime has no servers, triggering reconnect');
        await reconnectMcp();
        return;
      }
      // Verify we can actually list tools from at least one server
      let healthy = false;
      for (const server of servers) {
        try {
          await runtime.listTools(server, { includeSchema: false });
          healthy = true;
          break;
        } catch {
          // This server is unhealthy
        }
      }
      if (!healthy && servers.length > 0) {
        console.warn('[mcp] Health check: all servers unhealthy, triggering reconnect');
        await reconnectMcp();
      }
    } catch {
      // Runtime creation failed — trigger reconnect on next use
      if (mcpRuntime) {
        await mcpRuntime.close().catch(() => {});
        mcpRuntime = null;
      }
      discoveredMcpTools = null;
      mcpToolNameMap.clear();
      toolDefsCache.clear();
    }
  }, MCP_REDISCOVERY_INTERVAL_MS);
  // Don't keep the process alive solely for the health check, and avoid
  // registering it as a fresh listener on each runtime construction path.
  if (typeof mcpHealthInterval?.unref === 'function') {
    mcpHealthInterval.unref();
  }
}

async function getMcpRuntime(): Promise<any> {
  if (mcpRuntime) return mcpRuntime;
  if (inflightRuntime) return inflightRuntime;
  inflightRuntime = (async () => {
    const { createRuntime } = await import('mcporter');
    mcpRuntime = await createRuntime({
      configPath: join(homedir(), '.mcporter', 'mcporter.json'),
    });
    startMcpHealthCheck();
    return mcpRuntime;
  })().finally(() => {
    inflightRuntime = null;
  });
  return inflightRuntime;
}

// --- MCP Auto-Discovery ---

let discoveredMcpTools: any[] | null = null;
/** Single-flight guards to prevent concurrent MCP work from registering
 *  duplicate socket listeners on the same mcporter runtime. */
let inflightDiscovery: Promise<any[]> | null = null;
let inflightReconnect: Promise<void> | null = null;
let inflightRuntime: Promise<any> | null = null;

/** Sanitize a name to match OpenAI/Codex tool name pattern: [a-zA-Z0-9_-] */
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Maps sanitized tool name → { server (original), tool (original) } for routing
const mcpToolNameMap = new Map<string, { server: string; tool: string }>();

/**
 * Fallback tool definitions for MCP servers that don't support tools/list.
 * Loaded from ~/.skimpyclaw/mcp-fallbacks.json if it exists.
 *
 * Format: { "<server-name>": [ { name, description, input_schema } ] }
 */
let mcpFallbackCache: Record<string, Array<{ name: string; description: string; input_schema: Record<string, unknown> }>> | null = null;

function getMcpFallbackTools(server: string): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  if (!mcpFallbackCache) {
    const fallbackPath = join(homedir(), '.skimpyclaw', 'mcp-fallbacks.json');
    try {
      if (existsSync(fallbackPath)) {
        mcpFallbackCache = JSON.parse(readFileSync(fallbackPath, 'utf-8'));
        console.log(`[mcp] Loaded fallback tools from ${fallbackPath}`);
      } else {
        mcpFallbackCache = {};
      }
    } catch (err) {
      console.warn('[mcp] Failed to load mcp-fallbacks.json:', err instanceof Error ? err.message : err);
      mcpFallbackCache = {};
    }
  }
  return mcpFallbackCache![server] || [];
}

export async function discoverMcpTools(): Promise<any[]> {
  // Re-discover if cache is older than the rediscovery interval
  const stale = mcpLastDiscoveredAt > 0 && (Date.now() - mcpLastDiscoveredAt) > MCP_REDISCOVERY_INTERVAL_MS;
  if (discoveredMcpTools !== null && !stale) return discoveredMcpTools;
  // Single-flight: if another caller is already discovering, await that
  // instead of spawning a parallel listTools fan-out (which would attach
  // duplicate socket listeners to the shared mcporter runtime).
  if (inflightDiscovery) return inflightDiscovery;

  inflightDiscovery = (async () => {
  const tools: any[] = [];
  mcpToolNameMap.clear();

  try {
    const runtime = await getMcpRuntime();
    const servers = runtime.listServers();

    console.log(`[mcp] Servers found: ${servers.join(', ')}`);
    for (const server of servers) {
      try {
        const serverTools = await runtime.listTools(server, { includeSchema: true });
        console.log(`[mcp] Server "${server}" returned ${serverTools.length} tools: ${serverTools.map((t: any) => t.name).join(', ')}`);
        const sanitizedServer = sanitizeToolName(server);
        for (const tool of serverTools) {
          const sanitizedTool = sanitizeToolName(tool.name);
          const name = `mcp__${sanitizedServer}__${sanitizedTool}`;
          // Store mapping from sanitized name to original names for routing
          mcpToolNameMap.set(name, { server, tool: tool.name });
          tools.push({
            name,
            description: tool.description || `MCP tool ${tool.name} from ${server}`,
            input_schema: tool.inputSchema || { type: 'object' as const, properties: {} },
          });
        }
      } catch (err) {
        console.warn(`[mcp] Failed to list tools for server "${server}":`, err instanceof Error ? err.message : err);
        // Fallback: register well-known tools for servers that don't support tools/list
        const fallbackTools = getMcpFallbackTools(server);
        if (fallbackTools.length > 0) {
          const sanitizedServer = sanitizeToolName(server);
          for (const ft of fallbackTools) {
            const sanitizedTool = sanitizeToolName(ft.name);
            const name = `mcp__${sanitizedServer}__${sanitizedTool}`;
            mcpToolNameMap.set(name, { server, tool: ft.name });
            tools.push({ name, description: ft.description, input_schema: ft.input_schema });
          }
          console.log(`[mcp] Registered ${fallbackTools.length} fallback tools for "${server}"`);
        }
      }
    }
  } catch (err) {
    console.warn('[mcp] Failed to create runtime for tool discovery:', err instanceof Error ? err.message : err);
  }

  discoveredMcpTools = tools;
  mcpLastDiscoveredAt = Date.now();
  console.log(`[mcp] Discovered ${tools.length} tools: ${tools.map((t: any) => t.name).join(', ')}`);
  return tools;
  })().finally(() => {
    inflightDiscovery = null;
  });
  return inflightDiscovery;
}

export function clearMcpToolCache(): void {
  discoveredMcpTools = null;
  mcpLastDiscoveredAt = 0;
}

const toolDefsCache = new TTLCache<any[]>(60_000);

/** Force-reconnect the MCP runtime (clears cached runtime and tool discovery). */
export async function reconnectMcp(): Promise<void> {
  // Single-flight: overlapping reconnect calls would each close+recreate the
  // runtime and re-trigger discovery, piling duplicate listeners onto the new
  // mcporter sockets. Coalesce concurrent callers onto one reconnect.
  if (inflightReconnect) return inflightReconnect;
  inflightReconnect = (async () => {
    console.log('[mcp] Reconnecting...');
    if (mcpRuntime) {
      await mcpRuntime.close().catch(() => {});
      mcpRuntime = null;
    }
    discoveredMcpTools = null;
    mcpToolNameMap.clear();
    mcpFallbackCache = null;
    toolDefsCache.clear();
    try {
      await getMcpRuntime();
      const tools = await discoverMcpTools();
      console.log(`[mcp] Reconnected — ${tools.length} tools discovered`);
    } catch (err) {
      console.error('[mcp] Reconnect failed:', err instanceof Error ? err.message : err);
    }
  })().finally(() => {
    inflightReconnect = null;
  });
  return inflightReconnect;
}

/** Inject project names into a tool's workdir description, or return the tool unchanged. */
function injectProjects(tool: any, projects?: Record<string, string>): any {
  if (!projects || Object.keys(projects).length === 0) return tool;
  const projectList = Object.entries(projects)
    .map(([name, path]) => `"${name}" → ${path}`)
    .join(', ');
  return {
    ...tool,
    input_schema: {
      ...tool.input_schema,
      properties: {
        ...tool.input_schema.properties,
        workdir: {
          type: 'string',
          description: `Working directory or project name. Named projects: ${projectList}. Default: SkimpyClaw repo root.`,
        },
      },
    },
  };
}

/**
 * Get all available tool definitions: built-ins + fetch + MCP (auto-discovered) + agent tools.
 * This is the primary way to get tools — replaces the static TOOL_DEFINITIONS export.
 * Pass includeAgentTools: true to include code_with_agent and check_code_agent.
 * Results are cached for 60s to avoid rebuilding the array on every agent turn.
 */
export async function getToolDefinitions(config?: ToolConfig, options?: { includeAgentTools?: boolean; includeMcp?: boolean; projects?: Record<string, string> }): Promise<any[]> {
  const includeMcp = options?.includeMcp !== false; // default true for backwards compat
  const profile = config?.toolProfile ?? 'full';
  const cacheKey = JSON.stringify({
    agentTools: options?.includeAgentTools,
    mcp: includeMcp,
    projects: options?.projects,
    profile,
  });

  const cached = toolDefsCache.get(cacheKey);
  if (cached) return cached;

  const tools: any[] = [...BUILTIN_TOOL_DEFINITIONS];

  // Fetch is always available (lightweight HTTP, no dependencies)
  tools.push(FETCH_TOOL_DEFINITION);

  // Minimal profile: built-in tools + fetch.
  if (profile === 'minimal') {
    toolDefsCache.set(cacheKey, tools);
    return tools;
  }

  // Coding profile: built-ins + fetch + code_with_agent + check_code_agent.
  // Skips MCP discovery.
  if (profile === 'coding') {
    if (options?.includeAgentTools) {
      tools.push(injectProjects(CODE_WITH_AGENT_TOOL, options.projects));
      tools.push(CHECK_CODE_AGENT_TOOL);
      tools.push(DELEGATE_TO_AGENT_TOOL);
    }
    toolDefsCache.set(cacheKey, tools);
    return tools;
  }

  // Full profile (default): everything including MCP.

  // Auto-discover MCP tools from mcporter config (only for Anthropic models)
  if (includeMcp) {
    const mcpTools = await discoverMcpTools();
    tools.push(...mcpTools);
  }

  // Include code_with_agent and check_code_agent when requested
  if (options?.includeAgentTools) {
    const projects = options.projects;
    tools.push(injectProjects(CODE_WITH_AGENT_TOOL, projects));
    tools.push(CHECK_CODE_AGENT_TOOL);
    tools.push(DELEGATE_TO_AGENT_TOOL);
  }

  toolDefsCache.set(cacheKey, tools);
  return tools;
}

export function clearToolDefsCache(): void {
  toolDefsCache.clear();
}

// --- MCP Tool Execution (generic) ---

async function callMcpTool(server: string, tool: string, args: Record<string, any>): Promise<string> {
  const runtime = await getMcpRuntime();
  const result = await runtime.callTool(server, tool, { args });
  const content = (result as any)?.content;
  if (Array.isArray(content)) {
    return content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
  }
  return JSON.stringify(result);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeMcpToolArgsForExecution(
  server: string,
  tool: string,
  args: Record<string, any>,
): Record<string, any> {
  if (server !== 'context-a8c' || tool !== 'context-a8c-execute-tool' || isPlainObject(args.params)) {
    return args;
  }

  const aliasedParams = ['parameters', 'input', 'arguments']
    .map(key => args[key])
    .find(isPlainObject);
  if (aliasedParams) {
    const {
      parameters: _parameters,
      input: _input,
      arguments: _arguments,
      ...rest
    } = args;
    return { ...rest, params: aliasedParams };
  }

  if (typeof args.provider === 'string' && typeof args.tool === 'string') {
    const params = Object.fromEntries(
      Object.entries(args).filter(([key]) => !['provider', 'tool', 'params'].includes(key)),
    );
    if (Object.keys(params).length > 0) {
      return {
        provider: args.provider,
        tool: args.tool,
        params,
      };
    }
  }

  return args;
}

async function executeMcpToolGeneric(fullName: string, args: Record<string, any>): Promise<string> {
  const mapping = mcpToolNameMap.get(fullName);
  let server: string;
  let toolName: string;

  if (mapping) {
    server = mapping.server;
    toolName = mapping.tool;
  } else {
    const parts = fullName.split('__');
    if (parts.length < 3) return `Error: Invalid MCP tool name "${fullName}"`;
    server = parts[1];
    toolName = parts.slice(2).join('__');
  }
  const normalizedArgs = normalizeMcpToolArgsForExecution(server, toolName, args);

  const isRetryableError = (msg: string) =>
    msg.includes('session') || msg.includes('Session') || msg.includes('ECONNR') ||
    msg.includes('EPIPE') || msg.includes('closed') || msg.includes('close') ||
    msg.includes('disconnected') || msg.includes('fetch failed') ||
    msg.includes('timed out') || msg.includes('Premature') ||
    msg.includes('-32603') || msg.includes('-32001') || msg.includes('-32000');

  const isRetryableResult = (msg: string) =>
    msg.includes('Access forbidden') ||
    msg.includes('access forbidden') ||
    msg.includes('provider access is forbidden');

  const MAX_RETRIES = 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await callMcpTool(server, toolName, normalizedArgs);
      if (attempt < MAX_RETRIES && isRetryableResult(result)) {
        const delay = (attempt + 1) * 2000;
        console.warn(`[mcp] Tool call returned retryable result (${result.slice(0, 100)}), reconnecting (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, delay));
        await reconnectMcp();
        continue;
      }
      return result;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES && isRetryableError(msg)) {
        const delay = (attempt + 1) * 2000; // 2s, 4s
        console.warn(`[mcp] Tool call failed (${msg}), reconnecting (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, delay));
        await reconnectMcp();
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function cleanupMcp(): Promise<void> {
  if (mcpHealthInterval) {
    clearInterval(mcpHealthInterval);
    mcpHealthInterval = null;
  }
  if (mcpRuntime) {
    await mcpRuntime.close().catch(() => {});
    mcpRuntime = null;
  }
  inflightDiscovery = null;
  inflightReconnect = null;
  inflightRuntime = null;
}

// --- Tool Executor ---

export async function executeTool(
  name: string,
  input: Record<string, any>,
  config: ToolConfig,
  context?: ExecuteToolContext
): Promise<string> {
  try {
    // Route MCP tools BEFORE normalization to preserve server/tool name casing
    // NOTE: MCP servers run as external processes with full host access.
    // We validate path-like arguments as a best-effort check, but MCP servers
    // are a trusted boundary — only configure servers you trust.
    if (name.startsWith('mcp__')) {
      if (config.allowedPaths?.length) {
        const { isPathAllowed } = await import('./tools/path-utils.js');
        for (const [key, value] of Object.entries(input)) {
          if (typeof value === 'string' && (value.startsWith('/') || value.startsWith('~/') || value.startsWith('./'))) {
            const resolved = value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : resolve(value);
            if (!isPathAllowed(resolved, config.allowedPaths)) {
              return `Error: MCP tool argument "${key}" references path outside allowed directories: ${value}`;
            }
          }
        }
      }
      return await executeMcpToolGeneric(name, input);
    }

    // Route code_with_agent - delegate to code-agents module
    if (name === 'code_with_agent') {
      const { executeCodeWithAgent } = await import('./code-agents/index.js');
      return await executeCodeWithAgent(input, config, context);
    }

    // Route check_code_agent - delegate to code-agents module
    if (name === 'check_code_agent') {
      const { executeCheckCodeAgent } = await import('./code-agents/index.js');
      return executeCheckCodeAgent(input);
    }

    if (name === 'delegate_to_agent') {
      const { executeDelegateToAgent } = await import('./tools/agent-delegation.js');
      if (!context?.fullConfig) return 'Error: delegate_to_agent requires runtime config.';
      return executeDelegateToAgent(input, context.fullConfig, context);
    }

    // Map Claude Code names to internal names for built-in tools
    const normalized = fromClaudeCodeName(name).toLowerCase().replace(/-/g, '_');

    switch (normalized) {
      case 'read_file':
        return executeReadFile(input.file_path || input.path, config);
      case 'write_file':
        return await executeWriteFileLocked(input.file_path || input.path, input.content, config, context?.lockTaskId);
      case 'list_directory': {
        const directoryPath = resolveListDirectoryInput(input);
        if (!directoryPath) return 'Error: Missing path or pattern';
        return executeListDirectory(directoryPath, config);
      }
      case 'bash':
        return await executeBash(input.command || input.cmd, input.cwd, config, context);
      case 'fetch':
        return await executeFetch(input as any, config);
      default:
        return `Error: Unknown tool "${name}"`;
    }
  } catch (err) {
    return `Error: ${toErrorMessage(err)}`;
  }
}

function resolveListDirectoryInput(input: Record<string, any>): string | undefined {
  const rawPath = input.path ?? input.pattern;
  if (typeof rawPath !== 'string' || rawPath.length === 0) return undefined;
  // Glob is a compatibility alias for list_directory; wildcard patterns list their containing directory.
  const directoryPath = /[*?[\]{}]/.test(rawPath) ? dirname(rawPath) : rawPath;
  return resolve(directoryPath);
}

// --- Individual Tool Implementations ---
