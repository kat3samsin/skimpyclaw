// Tool definitions and executors for Anthropic API tool_use

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync, createWriteStream } from 'fs';
import { join, resolve, dirname, sep } from 'path';
import { homedir } from 'os';
import { exec, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { execSync } from 'child_process';
import { isBashCommandSafe } from './security.js';
import { TTLCache } from './cache.js';
import {
  classifyCommandRisk,
  requiresApproval,
  createApprovalRequest,
  waitForApproval,
  type ApprovalChannelMeta,
} from './exec-approval.js';

/** Resolve full path for a CLI command. Falls back to the name itself if not found. */
function resolveCliPath(name: string): string {
  try {
    return execSync(`which ${name}`, { encoding: 'utf-8' }).trim();
  } catch {
    return name;
  }
}

// Resolve CLI paths once at import time so spawn doesn't get ENOENT
const CLAUDE_CLI_PATH = resolveCliPath('claude');
const CODEX_CLI_PATH = resolveCliPath('codex');
const KIMI_CLI_PATH = resolveCliPath('kimi');
import { startTrace, addEvent, endTrace } from './audit.js';
import type { ToolConfig } from './types.js';

// Claude Code canonical tool names (stealth mode for OAuth compatibility)
// Maps our internal names to Claude Code's exact casing
const TOOL_NAME_MAP: Record<string, string> = {
  'Read': 'read_file',
  'Write': 'write_file',
  'Glob': 'list_directory',
  'Bash': 'bash',
  'Browser': 'browser',
};

// Reverse map: internal name -> Claude Code name
const INTERNAL_TO_CC: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_NAME_MAP).map(([cc, internal]) => [internal, cc])
);

/** Convert Claude Code tool name back to our internal name */
export function fromClaudeCodeName(name: string): string {
  return TOOL_NAME_MAP[name] || name;
}

/** Convert our internal name to Claude Code tool name */
export function toClaudeCodeName(name: string): string {
  return INTERNAL_TO_CC[name] || name;
}

// Built-in tool definitions — always available
export const BUILTIN_TOOL_DEFINITIONS = [
  {
    name: 'Read',
    description: 'Read the contents of a file at the given absolute path.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file. Creates parent directories if needed. Overwrites existing files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Glob',
    description: 'List files and directories at the given path. Returns name, type (file/dir), and size.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute path to the directory to list' },
      },
      required: ['path'],
    },
  },
  {
    name: 'Bash',
    description: 'Execute a shell command and return stdout/stderr. Use for CLI tools like gh, icalBuddy, date, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
      },
      required: ['command'],
    },
  },
];

export const BROWSER_TOOL_DEFINITION = {
  name: 'Browser',
  description: `Control a browser via Playwright. Actions (case-insensitive):
- open: Navigate to URL. Required: url
- click: Click element. Required: selector
- type: Fill input. Required: selector, text
- select: Pick dropdown option. Required: selector, text (value)
- hover: Hover element. Required: selector
- scroll: Scroll page. Optional: selector (scrollIntoView), direction (up/down), amount (pixels)
- waitFor: Wait for element/text. Required: selector OR text
- evaluate: Run JavaScript in page. Required: script. Returns JSON result.
- getText: Get visible text. Optional: selector (defaults to full page body text)
- screenshot: Capture page. Optional: file_path
- wait: Delay. Required: timeMs
- close: Close browser`,
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', description: 'Action to perform (see description)' },
      type: { type: 'string', description: 'Browser type: chromium | firefox | webkit (optional, config default)' },
      url: { type: 'string', description: 'URL to open (open action)' },
      selector: { type: 'string', description: 'CSS selector (click/type/waitFor/getText/scroll/select/hover)' },
      text: { type: 'string', description: 'Text to type, wait for, or select value (type/waitFor/select)' },
      script: { type: 'string', description: 'JavaScript code to evaluate in page (evaluate action)' },
      direction: { type: 'string', description: 'Scroll direction: up or down (scroll action, default: down)' },
      amount: { type: 'number', description: 'Pixels to scroll (scroll action, default: one viewport height)' },
      file_path: { type: 'string', description: 'Absolute path to save screenshot (optional)' },
      timeoutMs: { type: 'number', description: 'Timeout in ms (optional)' },
      timeMs: { type: 'number', description: 'Time to wait in ms (wait action)' },
      headless: { type: 'boolean', description: 'Override headless for open (optional)' },
      slowMoMs: { type: 'number', description: 'Slow motion delay per action (ms) (optional)' },
      userAgent: { type: 'string', description: 'Override user agent (optional)' },
      viewport: {
        type: 'object',
        properties: {
          width: { type: 'number' },
          height: { type: 'number' },
        },
      },
      // executablePath and profileDir are config-only for security (no model overrides)
    },
    required: ['action'],
  },
};

// Legacy export for backward compat — static list (built-ins + browser + no MCP)
export const TOOL_DEFINITIONS = [...BUILTIN_TOOL_DEFINITIONS, BROWSER_TOOL_DEFINITION];

// --- Spawn Subagent Tool ---

export const SPAWN_SUBAGENT_TOOL = {
  name: 'spawn_subagent',
  description: 'Spawn a background subagent to handle a task independently. Returns immediately with a run ID. Results are announced back to this chat when done. Use for tasks that benefit from parallel work or long-running operations.',
  input_schema: {
    type: 'object' as const,
    properties: {
      task: { type: 'string', description: 'What the subagent should do — be specific and self-contained' },
      type: {
        type: 'string',
        enum: ['coding', 'research'],
        description: 'Agent type: coding (code/files/bash), research (investigation/reading)',
      },
      model: { type: 'string', description: 'Optional model override (e.g. claude-opus, claude-think)' },
      label: { type: 'string', description: 'Short label for status display (e.g. "write tests", "check logs")' },
      allowedPaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional file paths the subagent can access beyond defaults',
      },
    },
    required: ['task', 'type'],
  },
};

// --- Code With Agent Tool ---

export const CODE_WITH_AGENT_TOOL = {
  name: 'code_with_agent',
  description: 'Delegate a coding task to a coding agent CLI (Claude Code or Codex). The agent will edit files, run commands, and return results. Always use this for code changes instead of writing code directly.',
  input_schema: {
    type: 'object' as const,
    properties: {
      task: { type: 'string', description: 'Detailed coding task. Be specific: what to change, why, which files, expected behavior.' },
      agent: { type: 'string', enum: ['claude', 'codex', 'kimi'], description: 'Which coding CLI to use. Omit to use configured default.' },
      workdir: { type: 'string', description: 'Working directory (default: SkimpyClaw repo root)' },
      model: { type: 'string', description: 'Model override (e.g. opus, gpt-5.3-codex)' },
      max_turns: { type: 'number', description: 'Max agentic turns, Claude only (default: 30)' },
      timeout_minutes: { type: 'number', description: 'Timeout in minutes (default: 10, max: 30)' },
      validate: { type: 'boolean', description: 'Run pnpm build && pnpm test after (default: true)' },
    },
    required: ['task'],
  },
};

// --- Code With Team Tool ---

export const CODE_WITH_TEAM_TOOL = {
  name: 'code_with_team',
  description: 'Decompose a complex task into subtasks and run multiple code_with_agent instances in parallel. SkimpyClaw manages coordination: decomposes the task, spawns N parallel agents, monitors progress, synthesizes results, and validates. Use for multi-file refactors, cross-layer changes, or tasks with independent subtasks.',
  input_schema: {
    type: 'object' as const,
    properties: {
      task: { type: 'string', description: 'Detailed task description. Be specific: what to change, why, which files, expected behavior.' },
      team_size: { type: 'number', description: 'Number of parallel agents (2-5, default 3)' },
      workdir: { type: 'string', description: 'Working directory or project name (default: SkimpyClaw repo root)' },
      agent: { type: 'string', enum: ['claude', 'codex', 'kimi'], description: 'Which coding CLI to use for all team workers. Omit to use configured default.' },
      model: { type: 'string', description: 'Model override (e.g. claude-sonnet-4-5, gpt-5.3-codex)' },
      timeout_minutes: { type: 'number', description: 'Total timeout in minutes (default: 20, max: 60)' },
      validate: { type: 'boolean', description: 'Run pnpm build && pnpm test after all agents complete (default: true)' },
    },
    required: ['task'],
  },
};

// --- Check Code Agent Tool ---

export const CHECK_CODE_AGENT_TOOL = {
  name: 'check_code_agent',
  description: 'Check status of running coding agents. Call with no args to list all, or with id to get details.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Agent ID (e.g. ca-1). Omit to list all active agents.' },
    },
  },
};

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

/**
 * Discover MCP tools from all servers registered in mcporter config.
 * Caches the result — call clearMcpToolCache() to force re-discovery.
 */
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

// --- Path Validation ---

function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  const resolved = resolve(filePath);
  return allowedPaths.some((allowed) => {
    const allowedRoot = resolve(allowed);
    return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${sep}`);
  });
}

// --- Tool Executor ---

export interface ExecuteToolContext {
  /** Task ID for file lock acquisition (subagent writes) */
  lockTaskId?: string;
  /** Abort signal for cancelling long-running tool loops */
  abortSignal?: AbortSignal;
  /** Chat ID for spawn_subagent dispatch */
  chatId?: number;
  /** Full config for spawn_subagent */
  fullConfig?: import('./types.js').Config;
  /** Conversation history for spawn_subagent */
  history?: import('./types.js').ChatMessage[];
  /** Audit trace ID for recording tool events */
  auditTraceId?: string;
  /** Originating channel for approval routing */
  channel?: 'telegram' | 'discord' | string;
  /** Channel-specific target ID (Telegram chat ID or Discord channel snowflake) */
  channelTargetId?: string | number;
  /** User ID of the person who can approve */
  approverUserId?: string;
  /** Username of the approver */
  approverUsername?: string;
  /** Trigger source for usage tracking */
  trigger?: string;
  /** Agent ID for usage tracking */
  agentId?: string;
}

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

    // Route code_with_agent
    if (name === 'code_with_agent') {
      return await executeCodeWithAgent(input, config, context);
    }

    // Route code_with_team
    if (name === 'code_with_team') {
      return await executeCodeWithTeam(input, config, context);
    }

    // Route check_code_agent
    if (name === 'check_code_agent') {
      return executeCheckCodeAgent(input);
    }

    // Map Claude Code names to internal names for built-in tools
    const normalized = fromClaudeCodeName(name).toLowerCase().replace(/-/g, '_');
    switch (normalized) {
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

function executeReadFile(path: string, config: ToolConfig): string {
  if (!isPathAllowed(path, config.allowedPaths)) {
    return `Error: Path not allowed. Permitted: ${config.allowedPaths.join(', ')}`;
  }
  if (!existsSync(path)) {
    return `Error: File not found: ${path}`;
  }
  const content = readFileSync(path, 'utf-8');
  if (content.length > 100_000) {
    return content.slice(0, 100_000) + '\n\n[TRUNCATED - file exceeds 100KB]';
  }
  return content;
}

function executeWriteFile(path: string, content: string, config: ToolConfig): string {
  if (!isPathAllowed(path, config.allowedPaths)) {
    return `Error: Path not allowed. Permitted: ${config.allowedPaths.join(', ')}`;
  }
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, content, 'utf-8');
  return `Written: ${path} (${content.length} bytes)`;
}

/**
 * Write with file locking when a lockTaskId is provided (subagent context).
 * Falls back to unlocked write when no lockTaskId.
 */
async function executeWriteFileLocked(path: string, content: string, config: ToolConfig, lockTaskId?: string): Promise<string> {
  if (!lockTaskId) {
    return executeWriteFile(path, content, config);
  }

  const { acquireLock, releaseLock } = await import('./file-lock.js');
  const acquired = await acquireLock(path, lockTaskId);
  if (!acquired) {
    return `Error: Could not acquire file lock on ${path} (timed out after 30s)`;
  }

  try {
    return executeWriteFile(path, content, config);
  } finally {
    releaseLock(path, lockTaskId);
  }
}

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

// --- Code With Agent Executor (Multi-Agent, Async) ---

const SKIMPYCLAW_ROOT = resolve(join(import.meta.dirname || process.cwd(), '..'));
const CODE_AGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const VALIDATE_TIMEOUT_MS = 60 * 1000; // 60 seconds
const CODE_AGENTS_DIR = join(homedir(), '.skimpyclaw', 'logs', 'code-agents');

export interface CodeAgentTask {
  id: string;                    // "ca-1", "ca-2"
  agent: string;                 // "claude" | "codex" | "team-coordinator"
  task: string;                  // full prompt
  status: 'running' | 'validating' | 'completed' | 'failed' | 'timeout' | 'pending' | 'cancelled';
  chatId?: number;               // for notification delivery
  startedAt: string;
  endedAt?: string;
  durationSeconds?: number;
  exitCode?: number | null;
  validationPassed?: boolean;
  validationOutput?: string;     // pnpm build/test output on failure (first 8KB)
  outputPreview?: string;        // first 500 chars of result
  liveOutput?: string;           // last 5KB for streaming
  error?: string;
  workdir: string;
  model?: string;
  retryCount?: number;           // how many internal validation retries have run
  // Team coordination fields
  parentTaskId?: string;         // child points to parent
  childTaskIds?: string[];       // parent tracks children
  subtask?: string;              // child's specific subtask description
  synthesisResult?: string;      // parent's final synthesized output
  // Dependency tracking
  dependsOn?: number[];          // indices of subtasks this depends on
  wave?: number;                 // which execution wave (0-based)
}

// In-memory tracking
let codeAgentCounter = 0;
const codeAgentTasks = new Map<string, CodeAgentTask>();
const codeAgentCancellers = new Map<string, () => void>();

// Reference to config for notifications — set via setCodeAgentConfig()
let _codeAgentConfig: import('./types.js').Config | null = null;

/** Set the config reference used for auto-notifications on completion. */
export function setCodeAgentConfig(config: import('./types.js').Config): void {
  _codeAgentConfig = config;
}

function writeCodeAgentTask(task: CodeAgentTask): void {
  try {
    if (!existsSync(CODE_AGENTS_DIR)) mkdirSync(CODE_AGENTS_DIR, { recursive: true });
    const filePath = join(CODE_AGENTS_DIR, `${task.id}.json`);
    writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf-8');
  } catch { /* best effort */ }
}

/** Get all active (running/validating) code agents. */
export function getActiveCodeAgents(): CodeAgentTask[] {
  return Array.from(codeAgentTasks.values())
    .filter(t => t.status === 'running' || t.status === 'validating');
}

/** Get recent code agents (completed/failed/timeout), newest first. */
export function getRecentCodeAgents(limit = 20): CodeAgentTask[] {
  return Array.from(codeAgentTasks.values())
    .filter(t => t.status !== 'running' && t.status !== 'validating' && t.status !== 'pending')
    .sort((a, b) => (b.endedAt || b.startedAt).localeCompare(a.endedAt || a.startedAt))
    .slice(0, limit);
}

/** Get all code agents (active + recent), newest first. */
export function getAllCodeAgents(): CodeAgentTask[] {
  return Array.from(codeAgentTasks.values())
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Get a single code agent by ID. */
export function getCodeAgent(id: string): CodeAgentTask | null {
  return codeAgentTasks.get(id) || null;
}

/** Cancel a running/pending code agent. For team coordinators, cascades to children. */
export function cancelCodeAgent(id: string): CodeAgentTask | null {
  const task = codeAgentTasks.get(id);
  if (!task) return null;

  const isTerminal = ['completed', 'failed', 'timeout', 'cancelled'].includes(task.status);
  if (isTerminal) return task;

  for (const childId of task.childTaskIds || []) {
    const child = codeAgentTasks.get(childId);
    if (!child) continue;
    const childTerminal = ['completed', 'failed', 'timeout', 'cancelled'].includes(child.status);
    if (childTerminal) continue;

    const childCanceller = codeAgentCancellers.get(childId);
    if (childCanceller) {
      try { childCanceller(); } catch { /* best effort */ }
    }
    child.status = 'cancelled';
    child.endedAt = new Date().toISOString();
    child.durationSeconds = Math.round((Date.now() - new Date(child.startedAt).getTime()) / 1000);
    child.error = 'Cancelled by user';
    child.liveOutput = undefined;
    writeCodeAgentTask(child);
  }

  const canceller = codeAgentCancellers.get(id);
  if (canceller) {
    try { canceller(); } catch { /* best effort */ }
  }
  task.status = 'cancelled';
  task.endedAt = new Date().toISOString();
  task.durationSeconds = Math.round((Date.now() - new Date(task.startedAt).getTime()) / 1000);
  task.error = 'Cancelled by user';
  task.liveOutput = undefined;
  writeCodeAgentTask(task);
  return task;
}

/** Restore code agent tasks from disk on startup. */
export function restoreCodeAgentTasks(): void {
  try {
    if (!existsSync(CODE_AGENTS_DIR)) return;
    const files = readdirSync(CODE_AGENTS_DIR).filter(f => f.endsWith('.json'));
    let maxCounter = 0;
    for (const file of files) {
      try {
        const task = JSON.parse(readFileSync(join(CODE_AGENTS_DIR, file), 'utf-8')) as CodeAgentTask;
        // On startup, any task still "running" or "validating" means the managing process died
        if (task.status === 'running' || task.status === 'validating') {
          const elapsed = task.startedAt ? Date.now() - new Date(task.startedAt).getTime() : 0;
          task.status = 'failed';
          task.error = 'Process interrupted (server restarted)';
          task.endedAt = new Date().toISOString();
          task.durationSeconds = Math.round(elapsed / 1000);
          writeCodeAgentTask(task);
        }
        codeAgentTasks.set(task.id, task);
        const num = parseInt(task.id.replace('ca-', ''), 10);
        if (num > maxCounter) maxCounter = num;
      } catch { /* skip corrupt files */ }
    }
    codeAgentCounter = maxCounter;
  } catch { /* best effort */ }
}

/** Build CLI args for code_with_agent. Exported for testing. */
export function buildCodeAgentArgs(input: {
  task: string;
  agent?: string;
  workdir?: string;
  model?: string;
  max_turns?: number;
}): { cmd: string; args: string[] } {
  const agent = input.agent || 'claude';
  const maxTurns = String(input.max_turns || 30);

  if (agent === 'codex') {
    const args = [
      'exec',
      '--full-auto',
      '--json',
      '--color', 'never',
    ];
    if (input.workdir) args.push('-C', input.workdir);
    if (input.model) args.push('-m', input.model);
    args.push(input.task);
    return { cmd: CODEX_CLI_PATH, args };
  }

  if (agent === 'kimi') {
    const args = [
      '--yolo',
      '-p', input.task,
    ];
    if (input.workdir) args.push('-w', input.workdir);
    if (input.model) args.push('-m', input.model);
    return { cmd: KIMI_CLI_PATH, args };
  }

  // Default: claude
  // Each --allowedTools flag takes one tool name — repeat the flag per tool
  const allowedTools = ['Edit', 'Read', 'Write', 'Bash', 'Glob', 'Grep'];
  const toolArgs = allowedTools.flatMap(t => ['--allowedTools', t]);
  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    ...toolArgs,
    '--max-turns', maxTurns,
    '--append-system-prompt', 'Output text only. Never use say or TTS. Focus on the coding task. Run pnpm build && pnpm test to verify changes.',
  ];
  if (input.model) args.push('--model', input.model);
  args.push(input.task);
  return { cmd: CLAUDE_CLI_PATH, args };
}

// --- Task Decomposition & Synthesis ---

export interface DecomposedSubtask {
  description: string;
  dependsOn: number[];  // indices of subtasks this depends on
}

/**
 * Compute execution waves from dependency info.
 * Returns an array of waves, where each wave is an array of subtask indices that can run in parallel.
 * Throws if there's a cycle in the dependency graph.
 */
export function computeWaves(subtasks: DecomposedSubtask[]): number[][] {
  const n = subtasks.length;
  const assigned = new Array<number>(n).fill(-1);  // wave assignment per subtask
  const waves: number[][] = [];

  // Topological wave assignment
  let remaining = n;
  let waveIdx = 0;
  while (remaining > 0) {
    const wave: number[] = [];
    for (let i = 0; i < n; i++) {
      if (assigned[i] >= 0) continue;  // already assigned
      // Check if all dependencies are satisfied
      const depsOk = subtasks[i].dependsOn.every(d => assigned[d] >= 0);
      if (depsOk) wave.push(i);
    }
    if (wave.length === 0) {
      // Cycle detected — force remaining into current wave
      console.warn('[team] Dependency cycle detected, forcing remaining subtasks into current wave');
      for (let i = 0; i < n; i++) {
        if (assigned[i] < 0) {
          wave.push(i);
        }
      }
    }
    for (const idx of wave) {
      assigned[idx] = waveIdx;
    }
    waves.push(wave);
    remaining -= wave.length;
    waveIdx++;
  }

  return waves;
}

/**
 * Use a quick model call to decompose a complex task into N subtasks with optional dependency info.
 * Falls back to numbered subtask splitting on parse error.
 * Falls back to all-independent if dependency info is missing or invalid.
 */
export async function decomposeTask(
  task: string,
  teamSize: number,
  config: import('./types.js').Config,
): Promise<DecomposedSubtask[]> {
  try {
    const { runAgentTurn } = await import('./agent.js');
    const prompt = `You are a task decomposition assistant. Break the following task into exactly ${teamSize} subtasks for separate coding agents. Each subtask should be specific and self-contained.

If some subtasks depend on others (e.g. "write queries" depends on "create schema"), specify dependencies using the dependsOn array with 0-based indices. Independent subtasks should have an empty dependsOn array. Tasks within the same wave (no mutual dependencies) will run in parallel.

Return ONLY a JSON object in this exact format, no other text:
{"subtasks": [{"description": "subtask 1", "dependsOn": []}, {"description": "subtask 2", "dependsOn": [0]}, ...]}

Task to decompose:
${task}`;

    const result = await runAgentTurn('main', prompt, config);
    const match = result.match(/\{[\s\S]*"subtasks"[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0) {
        // Handle both new format (objects with dependsOn) and legacy format (plain strings)
        const normalized: DecomposedSubtask[] = parsed.subtasks.map((item: any, _idx: number) => {
          if (typeof item === 'string') {
            return { description: item, dependsOn: [] };
          }
          if (item && typeof item.description === 'string') {
            const deps = Array.isArray(item.dependsOn)
              ? item.dependsOn.filter((d: any) => typeof d === 'number' && d >= 0 && d < parsed.subtasks.length)
              : [];
            return { description: item.description, dependsOn: deps };
          }
          return null;
        }).filter((x: DecomposedSubtask | null): x is DecomposedSubtask => x !== null);

        if (normalized.length > 0) {
          // Remove self-references from dependsOn
          for (let i = 0; i < normalized.length; i++) {
            normalized[i].dependsOn = normalized[i].dependsOn.filter(d => d !== i);
          }
          // Pad or trim to match teamSize
          while (normalized.length < teamSize) {
            normalized.push({ description: normalized[normalized.length - 1].description, dependsOn: [] });
          }
          return normalized.slice(0, teamSize);
        }
      }
    }
  } catch (err) {
    console.warn('[team] Task decomposition failed, using fallback:', err instanceof Error ? err.message : err);
  }

  // Fallback: numbered subtask splitting (all independent)
  return Array.from({ length: teamSize }, (_, i) => ({
    description: `Part ${i + 1} of ${teamSize}: ${task}`,
    dependsOn: [],
  }));
}

/**
 * Use a quick model call to synthesize results from multiple subtask completions.
 */
export async function synthesizeResults(
  originalTask: string,
  results: Array<{ subtask: string; status: string; output?: string; error?: string }>,
  config: import('./types.js').Config,
): Promise<string> {
  try {
    const { runAgentTurn } = await import('./agent.js');
    const resultSummary = results.map((r, i) =>
      `### Subtask ${i + 1}: ${r.subtask}\nStatus: ${r.status}\n${r.output ? `Output: ${r.output.slice(0, 1000)}` : ''}${r.error ? `Error: ${r.error}` : ''}`
    ).join('\n\n');

    const prompt = `You are a results synthesizer. Summarize the results of a multi-agent coding task.

Original task: ${originalTask}

Results from each agent:
${resultSummary}

Provide a concise markdown summary of what was accomplished, what succeeded, and what failed (if anything). Be specific about files changed and outcomes.`;

    return await runAgentTurn('main', prompt, config);
  } catch (err) {
    // Fallback: mechanical summary
    const succeeded = results.filter(r => r.status === 'completed').length;
    const failed = results.filter(r => r.status !== 'completed').length;
    return `Team completed: ${succeeded}/${results.length} subtasks succeeded${failed > 0 ? `, ${failed} failed` : ''}.\n\n${results.map((r, i) => `${i + 1}. [${r.status}] ${r.subtask}`).join('\n')}`;
  }
}

/**
 * Run build/test validation. Shared by solo agents and team orchestrator.
 */
export function runValidation(workdir: string): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    exec('pnpm build && pnpm test', {
      cwd: workdir,
      timeout: VALIDATE_TIMEOUT_MS,
      maxBuffer: 5 * 1024 * 1024,
    }, (error, vStdout, vStderr) => {
      if (error) {
        resolve({
          passed: false,
          output: [`VALIDATION FAILED (exit ${error.code}):`, vStdout, vStderr].filter(Boolean).join('\n').slice(0, 8_000),
        });
      } else {
        resolve({ passed: true, output: 'PASS' });
      }
    });
  });
}

async function executeCodeWithTeam(
  input: Record<string, any>,
  config: ToolConfig,
  context?: ExecuteToolContext,
): Promise<string> {
  const task = input.task as string;
  if (!task) return 'Error: task is required';

  const configDefault = context?.fullConfig?.subagents?.defaultCodeAgent || 'claude';
  const agent = (input.agent as string) || configDefault;
  if (!['claude', 'codex', 'kimi'].includes(agent)) {
    return `Error: Invalid agent "${agent}". Must be claude, codex, or kimi.`;
  }

  const teamSize = Math.max(2, Math.min(5, (input.team_size as number) || 3));

  const projects = context?.fullConfig?.projects ?? {};
  const rawWorkdir = input.workdir as string | undefined;

  // Resolve project name → path
  let workdir: string;
  if (rawWorkdir && projects[rawWorkdir]) {
    workdir = resolve(projects[rawWorkdir]);
  } else {
    workdir = resolve(rawWorkdir || SKIMPYCLAW_ROOT);
  }

  // Project paths are always allowed
  const projectPaths = Object.values(projects).map(p => resolve(p));
  const effectiveAllowedPaths = [...config.allowedPaths, ...projectPaths];

  if (!isPathAllowed(workdir, effectiveAllowedPaths)) {
    const projectNames = Object.keys(projects).length > 0
      ? ` (or project names: ${Object.keys(projects).join(', ')})`
      : '';
    return `Error: Working directory not allowed. Permitted: ${config.allowedPaths.join(', ')}${projectNames}`;
  }

  // Concurrency check — need room for teamSize children
  const maxConcurrent = context?.fullConfig?.subagents?.maxConcurrent ?? 5;
  const activeCount = getActiveCodeAgents().length;
  if (activeCount + teamSize > maxConcurrent) {
    return `Error: Concurrency limit — need ${teamSize} slots but only ${maxConcurrent - activeCount} available (${activeCount}/${maxConcurrent} running). Wait for agents to finish.`;
  }

  const validate = input.validate !== false;

  // Resolve model alias
  let resolvedModel: string | undefined = input.model as string | undefined;
  if (resolvedModel && context?.fullConfig) {
    const aliases = context.fullConfig.models?.aliases;
    if (aliases?.[resolvedModel]) {
      resolvedModel = aliases[resolvedModel];
    }
    if (resolvedModel.includes('/')) {
      resolvedModel = resolvedModel.split('/').slice(1).join('/');
    }
  }

  // Create parent task
  const id = `ca-${++codeAgentCounter}`;
  const startedAt = new Date();
  const caTask: CodeAgentTask = {
    id,
    agent: 'team-coordinator',
    task,
    status: 'running',
    chatId: context?.chatId,
    startedAt: startedAt.toISOString(),
    workdir,
    model: resolvedModel,
    childTaskIds: [],
  };
  codeAgentTasks.set(id, caTask);
  writeCodeAgentTask(caTask);

  // Fire-and-forget: orchestrator decomposes, spawns children, monitors, synthesizes
  runTeamOrchestrator(id, task, teamSize, workdir, validate, agent, resolvedModel, startedAt, context).catch((err) => {
    console.error(`[code-team] Background error for ${id}:`, err);
  });

  const taskPreview = task.length > 100 ? task.slice(0, 100) + '...' : task;
  return `Started coding team ${id} (${teamSize} parallel ${agent} agents). Task: ${taskPreview}\n\nUse check_code_agent to poll status.`;
}

async function executeCodeWithAgent(
  input: Record<string, any>,
  config: ToolConfig,
  context?: ExecuteToolContext,
): Promise<string> {
  const task = input.task as string;
  if (!task) return 'Error: task is required';

  const configDefault = context?.fullConfig?.subagents?.defaultCodeAgent || 'claude';
  const agent = (input.agent as string) || configDefault;
  if (!['claude', 'codex', 'kimi'].includes(agent)) {
    return `Error: Invalid agent "${agent}". Must be claude, codex, or kimi.`;
  }

  const projects = context?.fullConfig?.projects ?? {};
  const rawWorkdir = input.workdir as string | undefined;

  // Resolve project name → path (e.g. "skimpyclaw" → configured project path)
  let workdir: string;
  if (rawWorkdir && projects[rawWorkdir]) {
    workdir = resolve(projects[rawWorkdir]);
  } else {
    workdir = resolve(rawWorkdir || SKIMPYCLAW_ROOT);
  }

  // Project paths are always allowed in addition to configured allowedPaths
  const projectPaths = Object.values(projects).map(p => resolve(p));
  const effectiveAllowedPaths = [...config.allowedPaths, ...projectPaths];

  if (!isPathAllowed(workdir, effectiveAllowedPaths)) {
    const projectNames = Object.keys(projects).length > 0
      ? ` (or project names: ${Object.keys(projects).join(', ')})`
      : '';
    return `Error: Working directory not allowed. Permitted: ${config.allowedPaths.join(', ')}${projectNames}`;
  }

  // Concurrency check — share limit with subagents
  const maxConcurrent = context?.fullConfig?.subagents?.maxConcurrent ?? 5;
  const activeCount = getActiveCodeAgents().length;
  if (activeCount >= maxConcurrent) {
    return `Error: Concurrency limit reached (${activeCount}/${maxConcurrent} coding agents running). Wait for one to finish or increase subagents.maxConcurrent.`;
  }

  const validate = input.validate !== false; // default true

  // Resolve model alias to real model ID (e.g. "claude-opus" → "anthropic/claude-opus-4")
  // CLI tools don't know SkimpyClaw's aliases, so we must resolve before passing --model
  let resolvedModel: string | undefined = input.model as string | undefined;
  if (resolvedModel && context?.fullConfig) {
    const aliases = context.fullConfig.models?.aliases;
    if (aliases?.[resolvedModel]) {
      resolvedModel = aliases[resolvedModel];
    }
    // Strip provider prefix for CLI tools (they don't use "anthropic/..." format)
    if (resolvedModel.includes('/')) {
      resolvedModel = resolvedModel.split('/').slice(1).join('/');
    }
  }

  // Create task with unique ID
  const id = `ca-${++codeAgentCounter}`;
  const startedAt = new Date();
  const caTask: CodeAgentTask = {
    id,
    agent,
    task,
    status: 'running',
    chatId: context?.chatId,
    startedAt: startedAt.toISOString(),
    workdir,
    model: resolvedModel,
  };
  codeAgentTasks.set(id, caTask);
  writeCodeAgentTask(caTask);

  // Fire-and-forget: spawn background process
  // Pass resolved model so buildCodeAgentArgs gets the real model ID, not the alias
  const resolvedInput = { ...input, model: resolvedModel };
  runCodeAgentBackground(id, agent, task, workdir, validate, resolvedInput, startedAt).catch((err) => {
    console.error(`[code-agent] Background error for ${id}:`, err);
  });

  const taskPreview = task.length > 100 ? task.slice(0, 100) + '...' : task;
  return `Started coding agent ${id} (${agent}). Task: ${taskPreview}\n\nUse check_code_agent to poll status.`;
}

/** Format duration as human-readable string. */
function formatDuration(seconds: number | undefined): string {
  if (seconds == null) return '?';
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Build notification for a team-coordinator task with child results. */
function buildTeamNotification(task: CodeAgentTask): string {
  const dur = formatDuration(task.durationSeconds);
  const taskPreview = task.task.length > 100 ? task.task.slice(0, 100) + '...' : task.task;
  const statusIcon = task.status === 'completed' ? '✅' : task.status === 'timeout' ? '⏰' : '❌';
  const validation = task.validationPassed ? ' Tests pass.' : '';

  const lines: string[] = [];
  lines.push(`${statusIcon} Team ${task.id} ${task.status} (${dur}).${validation}`);
  lines.push(`Task: ${taskPreview}`);

  // Per-child summary
  const childIds = task.childTaskIds || [];
  if (childIds.length > 0) {
    lines.push('');
    for (const childId of childIds) {
      const child = codeAgentTasks.get(childId);
      if (!child) continue;
      const childIcon = child.status === 'completed' ? '✓' : child.status === 'failed' ? '✗' : child.status === 'timeout' ? '⏰' : '?';
      const childDur = formatDuration(child.durationSeconds);
      const subtask = (child.subtask || child.task || '').slice(0, 80);
      lines.push(`  ${childIcon} ${child.id} (${childDur}): ${subtask}`);
    }
  }

  // Errors
  if (task.error && task.error !== 'Validation failed') {
    lines.push(`\nError: ${task.error}`);
  }
  if (task.validationOutput) {
    lines.push(`\nValidation:\n${task.validationOutput.slice(0, 800)}`);
  }

  return lines.join('\n');
}

/** Send auto-notification to active channel on completion/failure. */
async function notifyCodeAgentResult(task: CodeAgentTask): Promise<void> {
  if (!_codeAgentConfig) return;
  const { sendActiveChannelProactiveMessage } = await import('./channels.js');

  let message: string;

  // Team coordinator gets a structured notification
  if (task.agent === 'team-coordinator') {
    message = buildTeamNotification(task);
    await sendActiveChannelProactiveMessage(_codeAgentConfig, message).catch(() => {});
    return;
  }

  const dur = formatDuration(task.durationSeconds);
  const taskPreview = task.task.length > 120 ? task.task.slice(0, 120) + '...' : task.task;

  if (task.status === 'completed') {
    const validation = task.validationPassed ? ' Build/tests pass.' : '';
    message = `✅ Coding agent ${task.id} completed (${dur}).${validation}\n\nTask: ${taskPreview}`;
    if (task.outputPreview) {
      const preview = task.outputPreview.slice(0, 300);
      message += `\n\nResult: ${preview}`;
    }
  } else if (task.status === 'timeout') {
    message = `⏰ Coding agent ${task.id} timed out after ${dur}.\n\nTask: ${taskPreview}`;
  } else {
    const retryNote = task.retryCount ? ` (retried ${task.retryCount}x)` : '';
    message = `❌ Coding agent ${task.id} failed (${dur})${retryNote}.\n\nTask: ${taskPreview}`;
    if (task.error) message += `\n\nError: ${task.error}`;
    if (task.validationOutput) {
      message += `\n\nBuild/test output:\n${task.validationOutput.slice(0, 1_500)}`;
    }
  }

  await sendActiveChannelProactiveMessage(_codeAgentConfig, message).catch(() => {});
}

/**
 * Parse stream-json stdout into human-readable live output.
 * Extracts assistant text, tool use summaries, and system messages.
 * Returns the last `maxChars` of readable output.
 */
function parseStreamJsonForLive(raw: string, maxChars = 5000): string {
  const lines = raw.split('\n');
  const parts: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);

      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          } else if (block.type === 'tool_use') {
            const name = block.name || 'tool';
            const inputPreview = block.input
              ? JSON.stringify(block.input).slice(0, 120)
              : '';
            parts.push(`[${name}] ${inputPreview}`);
          }
        }
      } else if (event.type === 'result') {
        if (event.result) parts.push(event.result);
      } else if (event.type === 'system' && event.message) {
        parts.push(`[system] ${typeof event.message === 'string' ? event.message : JSON.stringify(event.message).slice(0, 200)}`);
      }
    } catch {
      // Non-JSON line — include if it looks like meaningful output
      if (line.trim().length > 0 && !line.startsWith('{')) {
        parts.push(line.trim());
      }
    }
  }

  const output = parts.join('\n');
  return output.length > maxChars ? output.slice(-maxChars) : output;
}

/** Options for team-mode or other overrides in runCodeAgentBackground. */
export interface CodeAgentBackgroundOptions {
  /** Extra env vars to set (e.g. CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) */
  env?: Record<string, string>;
  /** Override args builder (returns { cmd, args } instead of buildCodeAgentArgs) */
  buildArgs?: () => { cmd: string; args: string[] };
  /** Default timeout in minutes (overrides 10min default) */
  defaultTimeoutMinutes?: number;
  /** Max timeout in minutes (overrides 30min cap) */
  maxTimeoutMinutes?: number;
  /** Skip sending notification on completion (parent handles it) */
  skipNotification?: boolean;
}

/** Background execution of a coding agent. Updates task status throughout. */
export async function runCodeAgentBackground(
  id: string,
  agent: string,
  task: string,
  workdir: string,
  validate: boolean,
  input: Record<string, any>,
  startedAt: Date,
  options?: CodeAgentBackgroundOptions,
): Promise<void> {
  const caTask = codeAgentTasks.get(id)!;
  const CANCELLED_MESSAGE = 'Cancelled by user';
  let cancelled = false;
  let activeProc: ChildProcess | null = null;
  let activeTimer: NodeJS.Timeout | null = null;
  let activeExecProc: ChildProcess | null = null;

  const setActiveCanceller = (fn: () => void) => {
    codeAgentCancellers.set(id, () => {
      cancelled = true;
      try { fn(); } catch { /* best effort */ }
    });
  };
  setActiveCanceller(() => {});

  const ensureNotCancelled = () => {
    if (cancelled || caTask.status === 'cancelled') throw new Error(CANCELLED_MESSAGE);
  };

  // Start audit trace
  const traceId = startTrace('code_agent');
  addEvent(traceId, {
    type: 'spawn',
    summary: `${agent}: ${task.slice(0, 150)}`,
    durationMs: 0,
    detail: { agent, workdir, model: input.model, validate },
  });

  // Per-invocation timeout (configurable defaults for team vs solo)
  const defaultTimeout = options?.defaultTimeoutMinutes ?? 10;
  const maxTimeout = options?.maxTimeoutMinutes ?? 30;
  const timeoutMinutes = Math.min(input.timeout_minutes || defaultTimeout, maxTimeout);
  const timeoutMs = timeoutMinutes * 60 * 1000;

  const { cmd, args } = options?.buildArgs
    ? options.buildArgs()
    : buildCodeAgentArgs({
        task,
        agent,
        workdir,
        model: input.model,
        max_turns: input.max_turns,
      });

  let stdout = '';
  let stderr = '';

  // Full log file — untruncated stdout + stderr
  const logPath = join(CODE_AGENTS_DIR, `${id}.log`);
  if (!existsSync(CODE_AGENTS_DIR)) mkdirSync(CODE_AGENTS_DIR, { recursive: true });
  const logStream = createWriteStream(logPath, { flags: 'w' });
  logStream.write(`=== ${id} | ${agent} | ${new Date().toISOString()} ===\n`);
  logStream.write(`Task: ${task.slice(0, 500)}\n`);
  logStream.write(`Workdir: ${workdir}\n\n`);

  try {
    ensureNotCancelled();
    const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
      const spawnEnv = { ...process.env };
      delete spawnEnv.CLAUDECODE;
      // Apply extra env vars (e.g. team mode feature flag)
      if (options?.env) Object.assign(spawnEnv, options.env);
      const proc = spawn(cmd, args, {
        cwd: workdir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv,
      });
      activeProc = proc;

      let lastStatusWrite = 0;
      const STATUS_WRITE_INTERVAL = 3000;

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        logStream.write(chunk);
        const now = Date.now();
        if (now - lastStatusWrite > STATUS_WRITE_INTERVAL) {
          lastStatusWrite = now;
          // Parse stream-json into readable live output
          const parsed = parseStreamJsonForLive(stdout);
          const live = stderr ? `[progress]\n${stderr.slice(-2000)}\n\n${parsed}` : parsed;
          caTask.liveOutput = live;
          writeCodeAgentTask(caTask);
        }
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        logStream.write(chunk);
        const now = Date.now();
        if (now - lastStatusWrite > STATUS_WRITE_INTERVAL) {
          lastStatusWrite = now;
          const parsedOut = parseStreamJsonForLive(stdout);
          const live = `[progress]\n${stderr.slice(-2000)}\n\n${parsedOut}`;
          caTask.liveOutput = live;
          writeCodeAgentTask(caTask);
        }
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeoutMs);
      activeTimer = timer;
      setActiveCanceller(() => {
        if (activeTimer) clearTimeout(activeTimer);
        activeTimer = null;
        try { activeProc?.kill('SIGTERM'); } catch { /* best effort */ }
      });

      proc.on('close', (code) => {
        if (activeTimer) clearTimeout(activeTimer);
        activeTimer = null;
        activeProc = null;
        logStream.write(`\n=== EXIT ${code} | ${new Date().toISOString()} ===\n`);
        logStream.end();
        if (cancelled || caTask.status === 'cancelled') {
          reject(new Error(CANCELLED_MESSAGE));
          return;
        }
        if (timedOut) {
          reject(new Error(`${agent} agent timed out after ${timeoutMinutes} minutes`));
        } else {
          resolvePromise(code);
        }
      });

      proc.on('error', (err) => {
        if (activeTimer) clearTimeout(activeTimer);
        activeTimer = null;
        activeProc = null;
        logStream.write(`\n=== ERROR: ${err.message} ===\n`);
        logStream.end();
        reject(err);
      });
    });
    ensureNotCancelled();

    // Parse output — stream-json format is newline-delimited JSON events
    let agentOutput: string;
    if (agent === 'claude') {
      try {
        const lines = stdout.trim().split('\n');
        let resultText = '';
        let lastResult: any = null;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            // Capture assistant text messages
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'text' && block.text) {
                  resultText += block.text + '\n';
                }
              }
            }
            // The final "result" event has metadata
            if (event.type === 'result') {
              lastResult = event;
              if (event.result) resultText += event.result;
            }
          } catch { /* skip non-JSON lines */ }
        }

        if (resultText.trim()) {
          agentOutput = resultText.trim();
        } else if (lastResult) {
          // No text output — build summary from result metadata
          const turns = lastResult.num_turns || '?';
          const cost = lastResult.total_cost_usd != null ? `$${lastResult.total_cost_usd.toFixed(2)}` : '';
          const duration = lastResult.duration_ms ? `${Math.round(lastResult.duration_ms / 1000)}s` : '';
          const parts = [`Completed in ${turns} turns`, duration, cost].filter(Boolean);
          agentOutput = parts.join(', ');
        } else {
          agentOutput = stdout.slice(0, 500) || stderr.slice(0, 500) || '(no output)';
        }
      } catch {
        agentOutput = stdout || stderr || '(no output)';
      }
    } else {
      const lines = stdout.trim().split('\n');
      const outputs: string[] = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'output_text' || obj.output_text) {
            outputs.push(obj.output_text || obj.text || '');
          }
        } catch {
          if (line.trim()) outputs.push(line);
        }
      }
      agentOutput = outputs.join('\n') || stdout || '(no output)';
    }

    if (exitCode !== 0) {
      addEvent(traceId, { type: 'error', summary: `${agent} exited with code ${exitCode}`, durationMs: Date.now() - startedAt.getTime() });
      await endTrace(traceId, 'error');
      Object.assign(caTask, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
        exitCode,
        outputPreview: agentOutput.slice(0, 5000),
        error: `Exited with code ${exitCode}`,
        liveOutput: undefined,
      });
      writeCodeAgentTask(caTask);
      if (!options?.skipNotification) await notifyCodeAgentResult(caTask);
      return;
    }

    // Post-validation gate
    if (validate) {
      caTask.status = 'validating';
      caTask.outputPreview = agentOutput.slice(0, 500);
      caTask.liveOutput = undefined;
      writeCodeAgentTask(caTask);

      const runValidation = (): Promise<string> => new Promise((res) => {
        const validationProc = exec('pnpm build && pnpm test', {
          cwd: workdir,
          timeout: VALIDATE_TIMEOUT_MS,
          maxBuffer: 5 * 1024 * 1024,
        }, (error, vStdout, vStderr) => {
          activeExecProc = null;
          if (error) {
            res([`VALIDATION FAILED (exit ${error.code}):`, vStdout, vStderr].filter(Boolean).join('\n').slice(0, 8_000));
          } else {
            res('PASS');
          }
        });
        activeExecProc = validationProc;
        setActiveCanceller(() => {
          try { activeExecProc?.kill('SIGTERM'); } catch { /* best effort */ }
          activeExecProc = null;
        });
      });

      let validateResult = await runValidation();
      ensureNotCancelled();

      // Internal retry: if validation failed, re-run the agent with test errors injected
      if (validateResult !== 'PASS' && !caTask.retryCount) {
        caTask.retryCount = 1;
        caTask.status = 'running';
        caTask.validationOutput = validateResult;
        writeCodeAgentTask(caTask);

        addEvent(traceId, { type: 'validation', summary: 'Validation failed, retrying with error context', durationMs: Date.now() - startedAt.getTime() });

        // Re-run agent with the validation errors appended to the prompt
        const retryTask = `${task}\n\n---\nPrevious attempt failed validation. Fix the following build/test errors before finishing:\n\n${validateResult.slice(0, 4_000)}`;
        stdout = '';
        stderr = '';

        const { cmd: retryCmd, args: retryArgs } = buildCodeAgentArgs({
          task: retryTask,
          agent,
          workdir,
          model: input.model,
          max_turns: input.max_turns,
        });

        const retryExitCode = await new Promise<number | null>((resolveRetry, rejectRetry) => {
          const spawnEnv = { ...process.env };
          delete spawnEnv.CLAUDECODE;
          const retryProc = spawn(retryCmd, retryArgs, {
            cwd: workdir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: spawnEnv,
          });
          activeProc = retryProc;

          let lastStatusWrite = 0;
          retryProc.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
            const now = Date.now();
            if (now - lastStatusWrite > 3000) {
              lastStatusWrite = now;
              const retryParsed = parseStreamJsonForLive(stdout);
              const live = stderr ? `[progress]\n${stderr.slice(-2000)}\n\n${retryParsed}` : retryParsed;
              caTask.liveOutput = live;
              writeCodeAgentTask(caTask);
            }
          });
          retryProc.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
            const now = Date.now();
            if (now - lastStatusWrite > 3000) {
              lastStatusWrite = now;
              const parsedOut = parseStreamJsonForLive(stdout);
          const live = `[progress]\n${stderr.slice(-2000)}\n\n${parsedOut}`;
              caTask.liveOutput = live;
              writeCodeAgentTask(caTask);
            }
          });

          const retryTimer = setTimeout(() => retryProc.kill('SIGTERM'), timeoutMs);
          activeTimer = retryTimer;
          setActiveCanceller(() => {
            if (activeTimer) clearTimeout(activeTimer);
            activeTimer = null;
            try { activeProc?.kill('SIGTERM'); } catch { /* best effort */ }
          });
          retryProc.on('close', (code) => {
            if (activeTimer) clearTimeout(activeTimer);
            activeTimer = null;
            activeProc = null;
            if (cancelled || caTask.status === 'cancelled') {
              rejectRetry(new Error(CANCELLED_MESSAGE));
              return;
            }
            resolveRetry(code);
          });
          retryProc.on('error', (err) => {
            if (activeTimer) clearTimeout(activeTimer);
            activeTimer = null;
            activeProc = null;
            rejectRetry(err);
          });
        });
        ensureNotCancelled();

        if (retryExitCode === 0) {
          if (agent === 'claude') {
            try { agentOutput = JSON.parse(stdout).result || stdout; } catch { agentOutput = stdout || stderr || '(no output)'; }
          } else {
            agentOutput = stdout || '(no output)';
          }
          caTask.status = 'validating';
          caTask.liveOutput = undefined;
          writeCodeAgentTask(caTask);
          validateResult = await runValidation();
          ensureNotCancelled();
        }
        // if retry exit code non-zero, fall through with original validateResult (still !== 'PASS')
      }

      const endedAt = new Date();
      const duration = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);

      if (validateResult !== 'PASS') {
        addEvent(traceId, { type: 'validation', summary: 'Build/test validation failed', durationMs: Date.now() - startedAt.getTime() });
        await endTrace(traceId, 'error');
        Object.assign(caTask, {
          status: 'failed',
          endedAt: endedAt.toISOString(),
          durationSeconds: duration,
          exitCode,
          validationPassed: false,
          validationOutput: validateResult.slice(0, 8_000),
          outputPreview: agentOutput.slice(0, 5000),
          error: 'Validation failed',
        });
        writeCodeAgentTask(caTask);
        if (!options?.skipNotification) await notifyCodeAgentResult(caTask);
        return;
      }

      addEvent(traceId, { type: 'validation', summary: 'Build/test validation passed', durationMs: Date.now() - startedAt.getTime() });
      await endTrace(traceId, 'ok');
      Object.assign(caTask, {
        status: 'completed',
        endedAt: endedAt.toISOString(),
        durationSeconds: duration,
        exitCode,
        validationPassed: true,
        validationOutput: undefined,
        outputPreview: agentOutput.slice(0, 5000),
      });
      writeCodeAgentTask(caTask);
      if (!options?.skipNotification) await notifyCodeAgentResult(caTask);
      return;
    }

    // No validation — mark complete
    addEvent(traceId, { type: 'complete', summary: `${agent} completed (no validation)`, durationMs: Date.now() - startedAt.getTime() });
    await endTrace(traceId, 'ok');
    Object.assign(caTask, {
      status: 'completed',
      endedAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      exitCode,
      outputPreview: agentOutput.slice(0, 5000),
      liveOutput: undefined,
    });
    writeCodeAgentTask(caTask);
    if (!options?.skipNotification) await notifyCodeAgentResult(caTask);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    addEvent(traceId, { type: 'error', summary: errMsg.slice(0, 200), durationMs: Date.now() - startedAt.getTime() });
    await endTrace(traceId, 'error');
    Object.assign(caTask, {
      status: errMsg.includes(CANCELLED_MESSAGE) || cancelled || caTask.status === 'cancelled'
        ? 'cancelled'
        : errMsg.includes('timed out')
          ? 'timeout'
          : 'failed',
      endedAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      error: errMsg,
      liveOutput: undefined,
    });
    writeCodeAgentTask(caTask);
    if (!options?.skipNotification && caTask.status !== 'cancelled') await notifyCodeAgentResult(caTask);
  } finally {
    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = null;
    activeProc = null;
    activeExecProc = null;
    codeAgentCancellers.delete(id);
  }
}

/**
 * Team orchestrator — decomposes task, spawns parallel agents, monitors, synthesizes.
 */
async function runTeamOrchestrator(
  parentId: string,
  task: string,
  teamSize: number,
  workdir: string,
  validate: boolean,
  agent: string,
  model: string | undefined,
  startedAt: Date,
  context?: ExecuteToolContext,
): Promise<void> {
  const parentTask = codeAgentTasks.get(parentId)!;

  const traceId = startTrace('code_team');
  addEvent(traceId, {
    type: 'spawn',
    summary: `team-coordinator: ${task.slice(0, 150)}`,
    durationMs: 0,
    detail: { teamSize, workdir, agent, model, validate },
  });

  const timeoutMinutes = Math.min(context?.fullConfig?.subagents?.maxConcurrent ? 60 : 20, 60);
  const perChildTimeout = Math.max(5, Math.floor(timeoutMinutes / teamSize));
  const CANCELLED_MESSAGE = 'Cancelled by user';

  try {
    if (codeAgentTasks.get(parentId)?.status === 'cancelled') throw new Error(CANCELLED_MESSAGE);
    // Phase 1: Decompose
    parentTask.liveOutput = 'Phase: Decomposing task...';
    writeCodeAgentTask(parentTask);

    const fullConfig = context?.fullConfig;
    if (!fullConfig) throw new Error('No config available for task decomposition');

    const subtasks = await decomposeTask(task, teamSize, fullConfig);
    const waves = computeWaves(subtasks);
    addEvent(traceId, {
      type: 'decompose',
      summary: `Decomposed into ${subtasks.length} subtasks in ${waves.length} wave(s)`,
      durationMs: Date.now() - startedAt.getTime(),
    });

    // Phase 2: Create child task entries and schedule waves
    const totalWaves = waves.length;

    parentTask.liveOutput = `Phase: Scheduling ${subtasks.length} agents in ${totalWaves} wave(s)...`;
    writeCodeAgentTask(parentTask);

    // Create all child tasks upfront (pending for later waves)
    const childIds: string[] = [];
    const childIdByIndex: string[] = [];  // subtask index → child id
    for (let i = 0; i < subtasks.length; i++) {
      const childId = `ca-${++codeAgentCounter}`;
      const waveNum = waves.findIndex(w => w.includes(i));
      const childTask: CodeAgentTask = {
        id: childId,
        agent,
        task: subtasks[i].description,
        status: waveNum === 0 ? 'running' : 'pending',
        chatId: context?.chatId,
        startedAt: new Date().toISOString(),
        workdir,
        model,
        parentTaskId: parentId,
        subtask: subtasks[i].description,
        dependsOn: subtasks[i].dependsOn,
        wave: waveNum,
      };
      codeAgentTasks.set(childId, childTask);
      writeCodeAgentTask(childTask);
      childIds.push(childId);
      childIdByIndex.push(childId);
    }

    parentTask.childTaskIds = childIds;
    writeCodeAgentTask(parentTask);

    // Helper: build task prompt with predecessor context for dependent subtasks
    function buildChildPrompt(subtaskIdx: number): string {
      const sub = subtasks[subtaskIdx];
      if (sub.dependsOn.length === 0) return sub.description;

      const contextParts: string[] = [];
      for (const depIdx of sub.dependsOn) {
        const depChild = codeAgentTasks.get(childIdByIndex[depIdx]);
        if (depChild && depChild.outputPreview) {
          contextParts.push(`- Task "${subtasks[depIdx].description}": ${depChild.outputPreview.slice(0, 1000)}`);
        }
      }
      if (contextParts.length === 0) return sub.description;

      return `Context from completed prerequisite tasks:\n${contextParts.join('\n')}\n\nYour task: ${sub.description}`;
    }

    // Phase 3: Execute waves sequentially, tasks within each wave in parallel
    const POLL_INTERVAL = 3000;
    const totalTimeoutMs = timeoutMinutes * 60 * 1000;

    for (let waveIdx = 0; waveIdx < totalWaves; waveIdx++) {
      if (codeAgentTasks.get(parentId)?.status === 'cancelled') throw new Error(CANCELLED_MESSAGE);
      const waveIndices = waves[waveIdx];

      addEvent(traceId, {
        type: 'wave_start',
        summary: `Starting wave ${waveIdx + 1}/${totalWaves} (${waveIndices.length} tasks)`,
        durationMs: Date.now() - startedAt.getTime(),
      });

      // Spawn all tasks in this wave
      for (const subtaskIdx of waveIndices) {
        const childId = childIdByIndex[subtaskIdx];
        const child = codeAgentTasks.get(childId)!;
        const prompt = buildChildPrompt(subtaskIdx);

        child.status = 'running';
        child.task = prompt;
        child.startedAt = new Date().toISOString();
        writeCodeAgentTask(child);

        runCodeAgentBackground(
          childId,
          agent,
          prompt,
          workdir,
          false, // children don't validate individually
          { task: prompt, model, timeout_minutes: perChildTimeout },
          new Date(),
          { skipNotification: true, defaultTimeoutMinutes: perChildTimeout, maxTimeoutMinutes: perChildTimeout },
        ).catch((err) => {
          console.error(`[code-team] Child ${childId} background error:`, err);
        });
      }

      // Poll until all tasks in this wave complete
      const waveChildIds = waveIndices.map(i => childIdByIndex[i]);

      while (true) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        if (codeAgentTasks.get(parentId)?.status === 'cancelled') throw new Error(CANCELLED_MESSAGE);

        const allChildren = childIds.map(id => codeAgentTasks.get(id)!);
        const waveChildren = waveChildIds.map(id => codeAgentTasks.get(id)!);
        const waveDone = waveChildren.filter(c => c.status !== 'running' && c.status !== 'validating').length;

        // Build wave-grouped status display
        const waveStatusLines: string[] = [];
        for (let w = 0; w < totalWaves; w++) {
          const wIndices = waves[w];
          const wChildren = wIndices.map(i => codeAgentTasks.get(childIdByIndex[i])!);
          const wDone = wChildren.every(c => c.status !== 'running' && c.status !== 'validating' && c.status !== 'pending');
          const wRunning = w === waveIdx;
          const wPending = w > waveIdx;
          const wLabel = wDone ? 'done' : wRunning ? 'running' : 'pending';

          const childLines = wChildren.map(c => {
            if (c.status === 'pending') return `  ${c.id} [pending]`;
            const elapsed = Math.round((Date.now() - new Date(c.startedAt).getTime()) / 1000);
            const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`;
            const preview = (c.subtask || c.task).slice(0, 150);
            return `  ${c.id} [${c.status}] (${elapsedStr}): ${preview}`;
          }).join('\n');

          waveStatusLines.push(`Wave ${w + 1} [${wLabel}]:\n${childLines}`);
        }

        const completedWaves = waves.filter((_, w) => w < waveIdx).length;
        parentTask.liveOutput = `Phase: Running Wave ${waveIdx + 1}/${totalWaves} (${completedWaves}/${totalWaves} complete)\n${waveStatusLines.join('\n')}`;
        writeCodeAgentTask(parentTask);

        if (waveDone === waveChildren.length) break;

        // Check total timeout
        if (Date.now() - startedAt.getTime() > totalTimeoutMs) {
          // Kill all remaining running/pending children
          for (const child of allChildren) {
            if (child.status === 'running' || child.status === 'validating' || child.status === 'pending') {
              Object.assign(child, {
                status: 'timeout',
                endedAt: new Date().toISOString(),
                durationSeconds: Math.round((Date.now() - new Date(child.startedAt).getTime()) / 1000),
                error: 'Parent team timed out',
              });
              writeCodeAgentTask(child);
            }
          }
          // Jump to synthesis
          break;
        }
      }

      // If we timed out, don't start more waves
      if (Date.now() - startedAt.getTime() > totalTimeoutMs) break;
    }

    // Phase 4: Collect results and synthesize
    if (codeAgentTasks.get(parentId)?.status === 'cancelled') throw new Error(CANCELLED_MESSAGE);
    parentTask.liveOutput = 'Phase: Synthesizing results...';
    writeCodeAgentTask(parentTask);

    const childResults = childIds.map(id => {
      const child = codeAgentTasks.get(id)!;
      return {
        subtask: child.subtask || child.task,
        status: child.status,
        output: child.outputPreview,
        error: child.error,
      };
    });

    addEvent(traceId, {
      type: 'synthesize',
      summary: `Synthesizing ${childResults.length} results`,
      durationMs: Date.now() - startedAt.getTime(),
    });

    const synthesis = await synthesizeResults(task, childResults, fullConfig);
    parentTask.synthesisResult = synthesis;

    // Phase 5: Validation (once, on the combined result)
    if (validate) {
      parentTask.liveOutput = 'Phase: Validating...';
      parentTask.status = 'validating';
      writeCodeAgentTask(parentTask);

      const { passed, output } = await runValidation(workdir);
      const endedAt = new Date();
      const duration = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);

      if (!passed) {
        addEvent(traceId, { type: 'validation', summary: 'Team validation failed', durationMs: Date.now() - startedAt.getTime() });
        await endTrace(traceId, 'error');
        Object.assign(parentTask, {
          status: 'failed',
          endedAt: endedAt.toISOString(),
          durationSeconds: duration,
          validationPassed: false,
          validationOutput: output,
          outputPreview: synthesis.slice(0, 5000),
          error: 'Validation failed',
          liveOutput: undefined,
        });
        writeCodeAgentTask(parentTask);
        await notifyCodeAgentResult(parentTask);
        return;
      }

      addEvent(traceId, { type: 'validation', summary: 'Team validation passed', durationMs: Date.now() - startedAt.getTime() });
      await endTrace(traceId, 'ok');
      Object.assign(parentTask, {
        status: 'completed',
        endedAt: endedAt.toISOString(),
        durationSeconds: duration,
        validationPassed: true,
        outputPreview: synthesis.slice(0, 5000),
        liveOutput: undefined,
      });
      writeCodeAgentTask(parentTask);
      await notifyCodeAgentResult(parentTask);
      return;
    }

    // No validation — mark complete
    const endedAt = new Date();
    addEvent(traceId, { type: 'complete', summary: 'Team completed (no validation)', durationMs: Date.now() - startedAt.getTime() });
    await endTrace(traceId, 'ok');
    Object.assign(parentTask, {
      status: 'completed',
      endedAt: endedAt.toISOString(),
      durationSeconds: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
      outputPreview: synthesis.slice(0, 5000),
      liveOutput: undefined,
    });
    writeCodeAgentTask(parentTask);
    await notifyCodeAgentResult(parentTask);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    addEvent(traceId, { type: 'error', summary: errMsg.slice(0, 200), durationMs: Date.now() - startedAt.getTime() });
    await endTrace(traceId, 'error');
    Object.assign(parentTask, {
      status: errMsg.includes(CANCELLED_MESSAGE) || parentTask.status === 'cancelled'
        ? 'cancelled'
        : errMsg.includes('timed out')
          ? 'timeout'
          : 'failed',
      endedAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      error: errMsg,
      liveOutput: undefined,
    });
    writeCodeAgentTask(parentTask);
    if (parentTask.status !== 'cancelled') await notifyCodeAgentResult(parentTask);
  }
}

/** @deprecated Removed — old Claude CLI team state reader. Kept for backward compat. */
export function readTeamState(): null {
  return null;
}

/** Execute check_code_agent tool — list all or get details for one agent. */
function executeCheckCodeAgent(input: Record<string, any>): string {
  const id = input.id as string | undefined;

  if (id) {
    const task = getCodeAgent(id);
    if (!task) return `No coding agent found with ID "${id}".`;
    return JSON.stringify({
      id: task.id,
      agent: task.agent,
      status: task.status,
      task: task.task,
      workdir: task.workdir,
      model: task.model,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      durationSeconds: task.durationSeconds,
      exitCode: task.exitCode,
      validationPassed: task.validationPassed,
      validationOutput: task.validationOutput,
      outputPreview: task.outputPreview,
      error: task.error,
      retryCount: task.retryCount,
    }, null, 2);
  }

  // List all agents (active first, then recent)
  const active = getActiveCodeAgents();
  const recent = getRecentCodeAgents(10);
  const all = [...active, ...recent];

  if (all.length === 0) return 'No coding agents have run yet.';

  const lines = all.map(t => {
    const elapsed = t.durationSeconds != null
      ? (t.durationSeconds < 60 ? `${t.durationSeconds}s` : `${Math.floor(t.durationSeconds / 60)}m`)
      : (Math.round((Date.now() - new Date(t.startedAt).getTime()) / 1000) + 's');
    const taskPreview = t.task.length > 60 ? t.task.slice(0, 60) + '...' : t.task;
    return `${t.id}: ${t.status.toUpperCase()} (${t.agent}, ${elapsed}) — ${taskPreview}`;
  });

  return lines.join('\n');
}

function executeListDirectory(path: string, config: ToolConfig): string {
  if (!isPathAllowed(path, config.allowedPaths)) {
    return `Error: Path not allowed. Permitted: ${config.allowedPaths.join(', ')}`;
  }
  if (!existsSync(path)) {
    return `Error: Directory not found: ${path}`;
  }
  const entries = readdirSync(path, { withFileTypes: true });
  if (entries.length === 0) return '(empty directory)';

  const lines = entries.map(e => {
    const type = e.isDirectory() ? 'dir' : 'file';
    if (e.isFile()) {
      const stat = statSync(join(path, e.name));
      return `${type}\t${e.name}\t${stat.size}`;
    }
    return `${type}\t${e.name}`;
  });
  return lines.join('\n');
}

async function executeBash(command: string, cwd: string | undefined, config: ToolConfig, context?: ExecuteToolContext): Promise<string> {
  // Hard block: existing safety filter (always enforced)
  if (!isBashCommandSafe(command)) {
    return Promise.resolve('Error: Command blocked by safety filter.');
  }
  if (cwd && !isPathAllowed(cwd, config.allowedPaths)) {
    return Promise.resolve('Error: Working directory not in allowed paths.');
  }

  // Exec approval gate: classify risk and check if approval is needed
  const approvalConfig = config.execApproval;
  if (approvalConfig?.enabled !== false) {
    const classification = classifyCommandRisk(command);
    if (requiresApproval(classification, approvalConfig)) {
      // Build channel metadata from context for notification routing
      const channelMeta: ApprovalChannelMeta | undefined = context?.channel
        ? {
            channel: context.channel,
            chatId: context.channelTargetId ?? context.chatId,
            userId: context.approverUserId,
            username: context.approverUsername,
          }
        : context?.chatId
          ? {
              channel: 'telegram',
              chatId: context.chatId,
            }
          : undefined;

      // Create a pending approval request and wait for resolution
      const ttlMs = approvalConfig?.ttlMs ?? 5 * 60 * 1000;
      const request = createApprovalRequest(command, cwd, classification, approvalConfig, channelMeta);
      const resolved = await waitForApproval(request.id, ttlMs);

      if (resolved.status !== 'approved') {
        return `⛔ Command not executed — approval ${resolved.status} (tier ${classification.tier}: ${classification.reason}).`;
      }
      // Approved — fall through to execution below
    }
  }

  const timeout = config.bashTimeout || 30_000;

  return new Promise((res) => {
    exec(command, {
      cwd: cwd || undefined,
      timeout,
      env: { ...process.env },
      maxBuffer: 5 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const parts = [stdout, stderr, `Exit code: ${error.code ?? 'unknown'}`].filter(Boolean);
        res(parts.join('\n').slice(0, 50_000));
        return;
      }
      const output = [stdout, stderr].filter(Boolean).join('\n');
      res(output.slice(0, 50_000) || '(no output)');
    });
  });
}

// --- Browser Tool (Playwright) ---

let playwrightModule: any | null = null;
let browserContext: any | null = null;
let browserPage: any | null = null;
let browserOptionsKey: string | null = null;

async function getPlaywright(): Promise<any> {
  if (!playwrightModule) {
    try {
      playwrightModule = await import('playwright');
    } catch {
      throw new Error('Playwright not installed. Run: npx playwright install');
    }
  }
  return playwrightModule;
}

function resolveScreenshotPath(filePath: string | undefined, config: ToolConfig): string {
  if (filePath) {
    if (!isPathAllowed(filePath, config.allowedPaths)) {
      throw new Error(`Path not allowed. Permitted: ${config.allowedPaths.join(', ')}`);
    }
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return filePath;
  }
  const dir = join(homedir(), '.skimpyclaw', 'screenshots');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(dir, `shot-${stamp}.png`);
}

function isFileUrlAllowed(url: string, config: ToolConfig): boolean {
  if (!url.startsWith('file://')) return true;
  if (!config.browser?.allowFile) return false;
  const filePath = new URL(url).pathname;
  return isPathAllowed(filePath, config.allowedPaths);
}

/** Pick override only if it's a meaningful value (not empty string, not 0 for non-numeric fields). */
function pick<T>(override: T | undefined, configVal: T | undefined, fallback?: T): T | undefined {
  if (override !== undefined && override !== null && override !== '') return override;
  if (configVal !== undefined && configVal !== null && configVal !== '') return configVal;
  return fallback as T | undefined;
}

function buildBrowserOptions(config: ToolConfig, overrides?: Record<string, any>) {
  // Config values take priority for security/environment settings.
  // Overrides (from model tool calls) only apply when config doesn't specify a value.
  const type = pick(overrides?.type, config.browser?.type, 'chromium') as string;
  const headless = config.browser?.headless ?? overrides?.headless ?? true;
  const slowMo = config.browser?.slowMoMs ?? ((typeof overrides?.slowMoMs === 'number' && overrides.slowMoMs > 0) ? overrides.slowMoMs : undefined);
  const userAgent = pick(config.browser?.userAgent, overrides?.userAgent) as string | undefined;
  const viewport = config.browser?.viewport ?? (overrides?.viewport?.width ? overrides.viewport : undefined);
  // Security: profileDir and executablePath are config-only — never allow model overrides
  const profileDir = config.browser?.profileDir || join(homedir(), '.skimpyclaw', 'browser-profile');
  const executablePath = config.browser?.executablePath;
  return { type, headless, slowMo, userAgent, viewport, profileDir, executablePath };
}

async function ensureBrowser(config: ToolConfig, overrides?: Record<string, any>): Promise<void> {
  const options = buildBrowserOptions(config, overrides);
  const optionsKey = JSON.stringify(options);

  if (browserContext && browserPage && browserOptionsKey === optionsKey) return;

  if (browserPage) {
    await browserPage.close().catch(() => {});
    browserPage = null;
  }
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
  }

  if (!isPathAllowed(options.profileDir, config.allowedPaths)) {
    throw new Error(`Profile dir not allowed. Add to allowedPaths: ${options.profileDir}`);
  }
  if (!existsSync(options.profileDir)) {
    mkdirSync(options.profileDir, { recursive: true });
  }

  const pw = await getPlaywright();
  const browserLauncher = pw[options.type as keyof typeof pw] || pw.chromium;
  try {
    browserContext = await browserLauncher.launchPersistentContext(options.profileDir, {
      headless: options.headless,
      slowMo: options.slowMo,
      userAgent: options.userAgent,
      viewport: options.viewport,
      executablePath: options.executablePath,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to launch browser (${options.type}): ${msg}. Ensure the browser is installed: npx playwright install ${options.type}`);
  }

  const pages = browserContext.pages();
  browserPage = pages.length > 0 ? pages[0] : await browserContext.newPage();

  // Remove navigator.webdriver flag that sites use to detect automation
  await browserPage.addInitScript(`Object.defineProperty(navigator, 'webdriver', { get: () => false })`);
  browserOptionsKey = optionsKey;
}

async function executeBrowser(input: Record<string, any>, config: ToolConfig): Promise<string> {
  if (!config.browser?.enabled) {
    return 'Error: Browser tool is disabled. Enable it in config (tools.browser.enabled).';
  }

  const action = String(input.action || '').toLowerCase();
  const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : 30_000;

  switch (action) {
    case 'open': {
      const url = input.url as string | undefined;
      if (!url) return 'Error: url is required for open.';
      if (!isFileUrlAllowed(url, config)) {
        return 'Error: file:// URLs are blocked. Enable tools.browser.allowFile to allow.';
      }
      await ensureBrowser(config, input);
      await browserPage.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      return `Opened: ${url}`;
    }
    case 'click': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const selector = input.selector as string | undefined;
      if (!selector) return 'Error: selector is required for click.';
      await browserPage.click(selector, { timeout: timeoutMs });
      return `Clicked: ${selector}`;
    }
    case 'type': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const selector = input.selector as string | undefined;
      const text = input.text as string | undefined;
      if (!selector || text === undefined) return 'Error: selector and text are required for type.';
      await browserPage.fill(selector, text, { timeout: timeoutMs });
      return `Typed into: ${selector}`;
    }
    case 'waitfor': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const selector = input.selector as string | undefined;
      const text = input.text as string | undefined;
      if (!selector && !text) return 'Error: selector or text is required for waitFor.';
      if (selector) {
        await browserPage.waitForSelector(selector, { timeout: timeoutMs });
        return `Waited for selector: ${selector}`;
      }
      await browserPage.waitForSelector(`text=${text}`, { timeout: timeoutMs });
      return `Waited for text: ${text}`;
    }
    case 'select': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const selector = input.selector as string | undefined;
      const value = input.text as string | undefined;
      if (!selector || value === undefined) return 'Error: selector and text (value) are required for select.';
      await browserPage.selectOption(selector, value, { timeout: timeoutMs });
      return `Selected "${value}" in: ${selector}`;
    }
    case 'hover': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const selector = input.selector as string | undefined;
      if (!selector) return 'Error: selector is required for hover.';
      await browserPage.hover(selector, { timeout: timeoutMs });
      return `Hovered: ${selector}`;
    }
    case 'scroll': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const selector = input.selector as string | undefined;
      if (selector) {
        await browserPage.evaluate(`{
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) el.scrollIntoView({ behavior: 'smooth' });
        }`);
        return `Scrolled into view: ${selector}`;
      }
      const direction = (input.direction as string || 'down').toLowerCase();
      const amount = typeof input.amount === 'number' ? input.amount : undefined;
      const dir = direction === 'up' ? -1 : 1;
      const scrollExpr = amount != null
        ? `window.scrollBy(0, ${dir * amount})`
        : `window.scrollBy(0, ${dir} * window.innerHeight)`;
      await browserPage.evaluate(scrollExpr);
      return `Scrolled ${direction}${amount ? ` ${amount}px` : ' one viewport'}`;
    }
    case 'evaluate': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const script = input.script as string | undefined;
      if (!script) return 'Error: script is required for evaluate.';
      const result = await browserPage.evaluate(script);
      return JSON.stringify(result);
    }
    case 'gettext': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const selector = input.selector as string | undefined;
      if (selector) {
        const text = await browserPage.textContent(selector, { timeout: timeoutMs });
        return text ?? '(no text content)';
      }
      const bodyText = await browserPage.evaluate('document.body.innerText');
      return bodyText || '(empty page)';
    }
    case 'screenshot': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const filePath = resolveScreenshotPath(input.file_path, config);
      await browserPage.screenshot({ path: filePath, fullPage: true });
      return `Saved screenshot: ${filePath}`;
    }
    case 'wait': {
      const waitMs = typeof input.timeMs === 'number' ? input.timeMs : timeoutMs;
      await new Promise((r) => setTimeout(r, waitMs));
      return `Waited ${waitMs}ms`;
    }
    case 'close': {
      await cleanupBrowser();
      return 'Browser closed.';
    }
    default:
      return `Error: Unknown browser action "${action}"`;
  }
}

// --- Browser Cleanup ---

export async function cleanupBrowser(): Promise<void> {
  if (browserPage) {
    await browserPage.close().catch(() => {});
    browserPage = null;
  }
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
  }
  browserOptionsKey = null;
}

// Prevent orphaned browser processes on exit
const handleExit = () => {
  if (browserContext) {
    browserContext.close().catch(() => {});
    browserContext = null;
    browserPage = null;
    browserOptionsKey = null;
  }
};
process.on('SIGTERM', handleExit);
process.on('SIGINT', handleExit);
process.on('exit', handleExit);
