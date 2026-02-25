// Tool definitions and executors for Anthropic API tool_use

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { TTLCache } from './cache.js';
import type { ToolConfig } from './types.js';
import {
  fromClaudeCodeName,
  toClaudeCodeName,
  BUILTIN_TOOL_DEFINITIONS,
  BROWSER_TOOL_DEFINITION,
  TOOL_DEFINITIONS,
  SPAWN_SUBAGENT_TOOL,
  CODE_WITH_AGENT_TOOL,
  CODE_WITH_TEAM_TOOL,
  CHECK_CODE_AGENT_TOOL,
} from './tools/definitions.js';
import type { ExecuteToolContext } from './tools/execute-context.js';
import { executeReadFile, executeWriteFileLocked, executeListDirectory } from './tools/file-tools.js';
import { executeBash } from './tools/bash-tool.js';
import { executeBrowser, cleanupBrowser } from './tools/browser-tool.js';

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
  SPAWN_SUBAGENT_TOOL,
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

/**
 * Get all available tool definitions: built-ins + browser (if enabled) + MCP (auto-discovered) + spawn_subagent.
 * This is the primary way to get tools — replaces the static TOOL_DEFINITIONS export.
 * Pass includeSpawnSubagent: true to include the spawn_subagent tool (e.g. for Telegram conversations).
 * Results are cached for 60s to avoid rebuilding the array on every agent turn.
 */
export async function getToolDefinitions(config?: ToolConfig, options?: { includeSpawnSubagent?: boolean; includeMcp?: boolean; projects?: Record<string, string> }): Promise<any[]> {
  const includeMcp = options?.includeMcp !== false; // default true for backwards compat
  const cacheKey = JSON.stringify({
    browser: config?.browser?.enabled,
    spawn: options?.includeSpawnSubagent,
    mcp: includeMcp,
    projects: options?.projects,
  });

  const cached = toolDefsCache.get(cacheKey);
  if (cached) return cached;

  const tools: any[] = [...BUILTIN_TOOL_DEFINITIONS];

  // Include browser tool only when explicitly enabled
  if (config?.browser?.enabled) {
    tools.push(BROWSER_TOOL_DEFINITION);
  }

  // Auto-discover MCP tools from mcporter config (only for Anthropic models)
  if (includeMcp) {
    const mcpTools = await discoverMcpTools();
    tools.push(...mcpTools);
  }

  // Include spawn_subagent, code_with_agent, and check_code_agent tools when requested
  if (options?.includeSpawnSubagent) {
    tools.push(SPAWN_SUBAGENT_TOOL);

    // Inject project names into code_with_agent description so the model knows what to use
    const projects = options.projects;
    if (projects && Object.keys(projects).length > 0) {
      const projectList = Object.entries(projects)
        .map(([name, path]) => `"${name}" → ${path}`)
        .join(', ');
      const codeAgentWithProjects = {
        ...CODE_WITH_AGENT_TOOL,
        input_schema: {
          ...CODE_WITH_AGENT_TOOL.input_schema,
          properties: {
            ...CODE_WITH_AGENT_TOOL.input_schema.properties,
            workdir: {
              type: 'string',
              description: `Working directory or project name. Named projects: ${projectList}. Default: SkimpyClaw repo root.`,
            },
          },
        },
      };
      tools.push(codeAgentWithProjects);
    } else {
      tools.push(CODE_WITH_AGENT_TOOL);
    }

    // Inject project names into code_with_team description too
    if (projects && Object.keys(projects).length > 0) {
      const projectList = Object.entries(projects)
        .map(([name, path]) => `"${name}" → ${path}`)
        .join(', ');
      const codeTeamWithProjects = {
        ...CODE_WITH_TEAM_TOOL,
        input_schema: {
          ...CODE_WITH_TEAM_TOOL.input_schema,
          properties: {
            ...CODE_WITH_TEAM_TOOL.input_schema.properties,
            workdir: {
              type: 'string',
              description: `Working directory or project name. Named projects: ${projectList}. Default: SkimpyClaw repo root.`,
            },
          },
        },
      };
      tools.push(codeTeamWithProjects);
    } else {
      tools.push(CODE_WITH_TEAM_TOOL);
    }

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
    if (name.startsWith('mcp__')) {
      return await executeMcpToolGeneric(name, input);
    }

    // Route spawn_subagent
    if (name === 'spawn_subagent') {
      return await executeSpawnSubagent(input, context);
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
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// --- Individual Tool Implementations ---

/**
 * Execute spawn_subagent tool — dispatches a background subagent.
 */
async function executeSpawnSubagent(input: Record<string, any>, context?: ExecuteToolContext): Promise<string> {
  if (!context?.fullConfig || !context?.chatId) {
    return 'Error: spawn_subagent requires a chat context (not available in this mode)';
  }

  const { dispatchSubagent } = await import('./subagent.js');

  const task = input.task as string;
  const type = input.type as string;
  const model = input.model as string | undefined;
  const label = input.label as string | undefined;
  const allowedPaths = input.allowedPaths as string[] | undefined;

  if (!task || !type) {
    return 'Error: task and type are required';
  }
  if (!['coding', 'research'].includes(type)) {
    return `Error: Invalid type "${type}". Must be coding or research.`;
  }

  try {
    const subagentTask = dispatchSubagent(
      type as import('./types.js').SubagentType,
      task,
      context.chatId,
      context.fullConfig,
      model,
      context.history,
      { label, allowedPaths }
    );

    const labelStr = label ? ` "${label}"` : '';
    return JSON.stringify({
      status: 'accepted',
      runId: subagentTask.id,
      label: label || subagentTask.type,
      message: `Subagent ${subagentTask.id}${labelStr} dispatched (${subagentTask.type}, model: ${subagentTask.model}). Results will be announced when done.`,
    });
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
