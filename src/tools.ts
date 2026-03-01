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
  TOOL_DEFINITIONS,
  CODE_WITH_AGENT_TOOL,
  CODE_WITH_TEAM_TOOL,
  CHECK_CODE_AGENT_TOOL,
} from './tools/definitions.js';
import type { ExecuteToolContext } from './tools/execute-context.js';
import { executeReadFile, executeWriteFileLocked, executeListDirectory } from './tools/file-tools.js';
import { executeBash } from './tools/bash-tool.js';
import { executeBrowser, cleanupBrowser } from './tools/browser-tool.js';
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

async function getMcpRuntime(): Promise<any> {
  if (!mcpRuntime) {
    const { createRuntime } = await import('mcporter');
    mcpRuntime = await createRuntime({
      configPath: join(homedir(), '.mcporter', 'mcporter.json'),
    });
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

export async function discoverMcpTools(): Promise<any[]> {
  if (discoveredMcpTools !== null) return discoveredMcpTools;

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
      }
    }
  } catch (err) {
    console.warn('[mcp] Failed to create runtime for tool discovery:', err instanceof Error ? err.message : err);
  }

  discoveredMcpTools = tools;
  return tools;
}

export function clearMcpToolCache(): void {
  discoveredMcpTools = null;
}

const toolDefsCache = new TTLCache<any[]>(60_000);

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

  // Minimal profile: only the 4 built-in tools (Read, Write, Glob, Bash).
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

async function executeMcpToolGeneric(fullName: string, args: Record<string, any>): Promise<string> {
  // Look up original server/tool names from the sanitized name map
  const mapping = mcpToolNameMap.get(fullName);
  if (!mapping) {
    // Fallback: parse from the name directly (works when names don't need sanitizing)
    const parts = fullName.split('__');
    if (parts.length < 3) return `Error: Invalid MCP tool name "${fullName}"`;
    const server = parts[1];
    const toolName = parts.slice(2).join('__');
    const runtime = await getMcpRuntime();
    const result = await runtime.callTool(server, toolName, { args });
    const content = (result as any)?.content;
    if (Array.isArray(content)) {
      return content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
    }
    return JSON.stringify(result);
  }

  const runtime = await getMcpRuntime();
  const result = await runtime.callTool(mapping.server, mapping.tool, { args });
  const content = (result as any)?.content;
  if (Array.isArray(content)) {
    return content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
  }
  return JSON.stringify(result);
}

export async function cleanupMcp(): Promise<void> {
  if (mcpRuntime) {
    await mcpRuntime.close().catch(() => {});
    mcpRuntime = null;
  }
}

async function executeWebSearch(query: string): Promise<string> {
  const q = query.trim();
  if (!q) return 'Error: $web_search requires a non-empty query';

  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    return `Error: web search failed (${res.status} ${res.statusText})`;
  }

  const data = await res.json() as {
    AbstractText?: string;
    AbstractURL?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string } | { Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  };

  const lines: string[] = [];
  if (data.AbstractText) {
    lines.push(`Summary: ${data.AbstractText}`);
    if (data.AbstractURL) {
      lines.push(`Source: ${data.AbstractURL}`);
    }
  }

  const related: Array<{ Text?: string; FirstURL?: string }> = [];
  for (const item of data.RelatedTopics || []) {
    if ('Topics' in item && Array.isArray(item.Topics)) {
      related.push(...item.Topics);
    } else {
      related.push(item as { Text?: string; FirstURL?: string });
    }
  }

  const top = related.filter((item) => item.Text && item.FirstURL).slice(0, 5);
  if (top.length > 0) {
    lines.push('Top results:');
    for (const item of top) {
      lines.push(`- ${item.Text}\n  ${item.FirstURL}`);
    }
  }

  if (lines.length === 0) {
    return `No web results found for: ${q}`;
  }

  return lines.join('\n');
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
      const needsHost = normalized === 'bash' && input.command &&
        MACOS_HOST_COMMANDS.has(input.command.trim().split(/[\s;|&]/)[0]);
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
            const translatedCmd = translateBashPaths(input.command);
            // Apply hard safety blocks and exec-approval inside sandbox.
            // The sandbox provides filesystem isolation but not command-level policy.
            if (!isBashCommandSafe(translatedCmd)) {
              return 'Error: Command blocked by safety filter.';
            }
            const classification = classifyCommandRisk(translatedCmd);
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
        return await executeWebSearch(input.query || input.q || input.text || '');
      case 'read_file':
        return executeReadFile(input.file_path || input.path, config);
      case 'write_file':
        return await executeWriteFileLocked(input.file_path || input.path, input.content, config, context?.lockTaskId);
      case 'list_directory':
        return executeListDirectory(input.path, config);
      case 'bash':
        return await executeBash(input.command, input.cwd, config, context);
      case 'browser':
        return await executeBrowser(input, config);
      default:
        return `Error: Unknown tool "${name}"`;
    }
  } catch (err) {
    return `Error: ${toErrorMessage(err)}`;
  }
}

// --- Individual Tool Implementations ---
