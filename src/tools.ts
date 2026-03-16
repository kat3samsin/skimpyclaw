// Tool definitions and executors for Anthropic API tool_use

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { TTLCache } from './cache.js';
import { toErrorMessage } from './utils.js';
import type { ToolConfig } from './types.js';
import {
  fromClaudeCodeName,
  toClaudeCodeName,
  BUILTIN_TOOL_DEFINITIONS,
  BROWSER_TOOL_DEFINITION,
  FETCH_TOOL_DEFINITION,
  TOOL_DEFINITIONS,
  CODE_WITH_AGENT_TOOL,
  CODE_WITH_TEAM_TOOL,
  CHECK_CODE_AGENT_TOOL,
} from './tools/definitions.js';
import type { ExecuteToolContext } from './tools/execute-context.js';
import { executeReadFile, executeWriteFileLocked, executeListDirectory } from './tools/file-tools.js';
import { executeBash } from './tools/bash-tool.js';
import { executeBrowser, cleanupBrowser } from './tools/browser-tool.js';
import { executeFetch } from './tools/fetch-tool.js';
import type { SandboxConfig } from './types.js';
import { ensureContainer, SANDBOX_DEFAULTS, translatePath, validateMountPaths } from './sandbox/index.js';
import { sandboxBash, sandboxReadFile, sandboxWriteFile, sandboxListDir, sandboxGlob } from './sandbox/index.js';
import { isBashCommandSafe } from './security.js';
import { classifyCommandRisk, requiresApproval } from './exec-approval.js';

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
  // Orchestrator functions
  computeWaves,
  decomposeTask,
  synthesizeResults,
  // Executor functions
  runValidation,
  runCodeAgentBackground,
  // Utilities
  buildCodeAgentArgs,
  readTeamState,
  // Parsers
  parseStreamJsonForLive,
} from './code-agents/index.js';

// Re-export from definitions
export {
  fromClaudeCodeName,
  toClaudeCodeName,
  BUILTIN_TOOL_DEFINITIONS,
  BROWSER_TOOL_DEFINITION,
  FETCH_TOOL_DEFINITION,
  TOOL_DEFINITIONS,
  CODE_WITH_AGENT_TOOL,
  CODE_WITH_TEAM_TOOL,
  CHECK_CODE_AGENT_TOOL,
  cleanupBrowser,
};
export type { ExecuteToolContext };
// Re-export types for backward compatibility
export type { CodeAgentTask, DecomposedSubtask } from './code-agents/index.js';

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
}

async function getMcpRuntime(): Promise<any> {
  if (!mcpRuntime) {
    const { createRuntime } = await import('mcporter');
    mcpRuntime = await createRuntime({
      configPath: join(homedir(), '.mcporter', 'mcporter.json'),
    });
    startMcpHealthCheck();
  }
  return mcpRuntime;
}

// --- MCP Auto-Discovery ---

let discoveredMcpTools: any[] | null = null;

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

  const tools: any[] = [];
  mcpToolNameMap.clear();

  try {
    const runtime = await getMcpRuntime();
    const servers = runtime.listServers();

    for (const server of servers) {
      try {
        const serverTools = await runtime.listTools(server, { includeSchema: true });
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
  return tools;
}

export function clearMcpToolCache(): void {
  discoveredMcpTools = null;
  mcpLastDiscoveredAt = 0;
}

const toolDefsCache = new TTLCache<any[]>(60_000);

/** Force-reconnect the MCP runtime (clears cached runtime and tool discovery). */
export async function reconnectMcp(): Promise<void> {
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
 * Get all available tool definitions: built-ins + browser (if enabled) + MCP (auto-discovered) + agent tools.
 * This is the primary way to get tools — replaces the static TOOL_DEFINITIONS export.
 * Pass includeAgentTools: true to include code_with_agent, code_with_team, check_code_agent.
 * Results are cached for 60s to avoid rebuilding the array on every agent turn.
 */
export async function getToolDefinitions(config?: ToolConfig, options?: { includeAgentTools?: boolean; includeMcp?: boolean; projects?: Record<string, string> }): Promise<any[]> {
  const includeMcp = options?.includeMcp !== false; // default true for backwards compat
  const profile = config?.toolProfile ?? 'full';
  const cacheKey = JSON.stringify({
    browser: config?.browser?.enabled,
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
  // Used by orchestrator decompose/synthesize calls.
  if (profile === 'minimal') {
    toolDefsCache.set(cacheKey, tools);
    return tools;
  }

  // Include browser tool only when explicitly enabled
  if (config?.browser?.enabled) {
    tools.push(BROWSER_TOOL_DEFINITION);
  }

  // Coding profile: built-ins + browser + code_with_agent + check_code_agent.
  // Skips MCP discovery and code_with_team.
  if (profile === 'coding') {
    if (options?.includeAgentTools) {
      tools.push(injectProjects(CODE_WITH_AGENT_TOOL, options.projects));
      tools.push(CHECK_CODE_AGENT_TOOL);
    }
    toolDefsCache.set(cacheKey, tools);
    return tools;
  }

  // Full profile (default): everything including MCP and code_with_team.

  // Auto-discover MCP tools from mcporter config (only for Anthropic models)
  if (includeMcp) {
    const mcpTools = await discoverMcpTools();
    tools.push(...mcpTools);
  }

  // Include code_with_agent, code_with_team, and check_code_agent when requested
  if (options?.includeAgentTools) {
    const projects = options.projects;
    tools.push(injectProjects(CODE_WITH_AGENT_TOOL, projects));
    tools.push(injectProjects(CODE_WITH_TEAM_TOOL, projects));
    tools.push(CHECK_CODE_AGENT_TOOL);
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

  const isRetryableError = (msg: string) =>
    msg.includes('session') || msg.includes('Session') || msg.includes('ECONNR') ||
    msg.includes('EPIPE') || msg.includes('closed') || msg.includes('close') ||
    msg.includes('disconnected') || msg.includes('fetch failed') ||
    msg.includes('timed out') || msg.includes('Premature') ||
    msg.includes('-32603') || msg.includes('-32001') || msg.includes('-32000');

  const MAX_RETRIES = 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callMcpTool(server, toolName, args);
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

    // Route code_with_team - delegate to code-agents module
    if (name === 'code_with_team') {
      const { executeCodeWithTeam } = await import('./code-agents/index.js');
      return await executeCodeWithTeam(input, config, context);
    }

    // Route check_code_agent - delegate to code-agents module
    if (name === 'check_code_agent') {
      const { executeCheckCodeAgent } = await import('./code-agents/index.js');
      return executeCheckCodeAgent(input);
    }

    // Route autoresearch tools
    if (name === 'init_experiment') {
      const { executeInitExperiment } = await import('./tools/autoresearch-tool.js');
      const cwd = config.allowedPaths?.[0] || process.cwd();
      return executeInitExperiment(input, cwd);
    }
    if (name === 'run_experiment') {
      const { executeRunExperiment } = await import('./tools/autoresearch-tool.js');
      const cwd = config.allowedPaths?.[0] || process.cwd();
      return await executeRunExperiment(input, cwd);
    }
    if (name === 'log_experiment') {
      const { executeLogExperiment } = await import('./tools/autoresearch-tool.js');
      const cwd = config.allowedPaths?.[0] || process.cwd();
      return executeLogExperiment(input, cwd);
    }

    // Map Claude Code names to internal names for built-in tools
    const normalized = fromClaudeCodeName(name).toLowerCase().replace(/-/g, '_');

    // --- Sandbox routing ---
    const sandboxCfg = context?.sandboxConfig;
    if (sandboxCfg?.enabled) {
      const SANDBOXED_TOOLS = new Set(['bash', 'read_file', 'write_file', 'list_directory', 'glob']);
      // macOS-only commands that must run on the host (not available in Linux containers)
      const MACOS_HOST_COMMANDS = new Set([
        'osascript', 'open', 'say', 'pbcopy', 'pbpaste', 'defaults',
        'icalBuddy', 'shortcuts', 'caffeinate', 'networksetup', 'launchctl',
        'security', 'xattr', 'ditto', 'hdiutil', 'diskutil', 'sw_vers',
      ]);
      const bashCmd = input.command || input.cmd;
      const needsHost = normalized === 'bash' && bashCmd &&
        MACOS_HOST_COMMANDS.has(bashCmd.trim().split(/[\s;|&]/)[0]);
      if (SANDBOXED_TOOLS.has(normalized) && !needsHost) {
        const sessionId = context?.sessionId || context?.chatId?.toString() || 'default';
        const merged = { ...SANDBOX_DEFAULTS, ...sandboxCfg };
        const containerName = await ensureContainer(sessionId, merged, config.allowedPaths);
        const mounts = validateMountPaths(config.allowedPaths);
        const tp = (p: string) => translatePath(p, mounts);
        // Translate host paths in bash commands so they resolve inside the container
        const translateBashPaths = (cmd: string): string => {
          let translated = cmd;
          // Sort mounts by host path length descending to match most specific first
          const sorted = [...mounts].sort((a, b) => b.host.length - a.host.length);
          for (const mount of sorted) {
            translated = translated.replaceAll(mount.host, mount.container);
          }
          // Also translate ~ and $HOME references to /workspace/config
          const home = homedir();
          const homeMounts = sorted.filter(m => m.host.startsWith(home));
          for (const mount of homeMounts) {
            const tildeForm = '~' + mount.host.slice(home.length);
            translated = translated.replaceAll(tildeForm, mount.container);
            const envForm = '$HOME' + mount.host.slice(home.length);
            translated = translated.replaceAll(envForm, mount.container);
          }
          return translated;
        };
        // Reverse-translate container paths back to host paths in file content.
        // Prevents the agent from writing /workspace/... paths into config files.
        const reverseTranslatePaths = (content: string): string => {
          let reversed = content;
          const sorted = [...mounts].sort((a, b) => b.container.length - a.container.length);
          for (const mount of sorted) {
            reversed = reversed.replaceAll(mount.container, mount.host);
          }
          return reversed;
        };
        switch (normalized) {
          case 'bash': {
            const translatedCmd = translateBashPaths(bashCmd);
            // Apply hard safety blocks inside sandbox.
            // Sandbox provides filesystem isolation, so opaque script execution
            // (heredocs, -c, -e) is safe — only require approval for truly
            // destructive patterns (rm -rf, dd, mkfs, etc.).
            if (!isBashCommandSafe(translatedCmd)) {
              return 'Error: Command blocked by safety filter.';
            }
            const classification = classifyCommandRisk(translatedCmd);
            // Downgrade opaque-script classifications in sandbox — the isolation
            // already handles the risk that inline code poses on the host.
            if (classification.tier >= 2 && (
              classification.reason === 'Inline heredoc script execution' ||
              classification.reason === 'Inline interpreter code execution'
            )) {
              classification.tier = 0 as import('./exec-approval.js').RiskTier;
              classification.reason = `${classification.reason} (sandboxed — auto-approved)`;
            }
            const approvalConfig = config.execApproval;
            if (requiresApproval(classification, approvalConfig)) {
              const isUnattended =
                context?.channel === 'subagent' ||
                context?.isCronJob === true ||
                (!context?.approverUserId && !context?.channelTargetId && !context?.chatId);
              if (isUnattended) {
                return `⛔ Command blocked — tier ${classification.tier} commands require approval but no approver is available in this context (${classification.reason}). Use safer alternatives or request approval via an interactive channel.`;
              }
              // Attended context — run full approval flow before executing in sandbox
              const { createApprovalRequest: sbxCreate, waitForApproval: sbxWait } = await import('./exec-approval.js');
              const ttlMs = approvalConfig?.ttlMs ?? 5 * 60 * 1000;
              const channelMeta = context?.channel ? {
                channel: context.channel,
                chatId: context.channelTargetId ?? context.chatId,
                userId: context.approverUserId,
                username: context.approverUsername,
              } : context?.chatId ? { channel: 'telegram', chatId: context.chatId } : undefined;
              const sbxReq = sbxCreate(translatedCmd, input.cwd, classification, approvalConfig, channelMeta);
              const sbxResolved = await sbxWait(sbxReq.id, ttlMs);
              if (sbxResolved.status !== 'approved') {
                return `⛔ Command not executed — approval ${sbxResolved.status} (tier ${classification.tier}: ${classification.reason}).`;
              }
            }
            return await sandboxBash(containerName, translatedCmd, input.cwd ? tp(input.cwd) : undefined, config.bashTimeout);
          }
          case 'read_file':
            return await sandboxReadFile(containerName, tp(input.file_path || input.path));
          case 'write_file':
            return await sandboxWriteFile(containerName, tp(input.file_path || input.path), reverseTranslatePaths(input.content));
          case 'list_directory':
            return await sandboxListDir(containerName, tp(input.path));
          case 'glob':
            return await sandboxGlob(containerName, tp(input.base || input.path || '/workspace'), input.pattern || '*');
          default:
            break; // fall through
        }
      }
    }

    switch (normalized) {
      case '$web_search':
      case 'web_search':
      case 'websearch':
        // Legacy: redirect to Fetch with DuckDuckGo HTML search
        return await executeFetch({ url: `https://duckduckgo.com/html/?q=${encodeURIComponent(input.query || input.q || input.text || '')}` } as any, config);
      case 'read_file':
        return executeReadFile(input.file_path || input.path, config);
      case 'write_file':
        return await executeWriteFileLocked(input.file_path || input.path, input.content, config, context?.lockTaskId);
      case 'list_directory':
        return executeListDirectory(input.path, config);
      case 'bash':
        return await executeBash(input.command || input.cmd, input.cwd, config, context);
      case 'browser':
        return await executeBrowser(input, config);
      case 'fetch':
        return await executeFetch(input as any, config);
      default:
        return `Error: Unknown tool "${name}"`;
    }
  } catch (err) {
    return `Error: ${toErrorMessage(err)}`;
  }
}

// --- Individual Tool Implementations ---
