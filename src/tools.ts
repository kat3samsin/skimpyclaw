// Tool definitions and executors for Anthropic API tool_use

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'fs';
import { join, resolve, dirname, sep } from 'path';
import { homedir } from 'os';
import { exec, spawn } from 'child_process';
import { execSync } from 'child_process';
import { isBashCommandSafe } from './security.js';
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
        enum: ['coding', 'research', 'general'],
        description: 'Agent type: coding (code/files/bash), research (investigation/reading), general (other)',
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
      validate: { type: 'boolean', description: 'Run pnpm build && pnpm test after (default: true)' },
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

/**
 * Get all available tool definitions: built-ins + browser (if enabled) + MCP (auto-discovered) + spawn_subagent.
 * This is the primary way to get tools — replaces the static TOOL_DEFINITIONS export.
 * Pass includeSpawnSubagent: true to include the spawn_subagent tool (e.g. for Telegram conversations).
 */
export async function getToolDefinitions(config?: ToolConfig, options?: { includeSpawnSubagent?: boolean }): Promise<any[]> {
  const tools: any[] = [...BUILTIN_TOOL_DEFINITIONS];

  // Include browser tool only when explicitly enabled
  if (config?.browser?.enabled) {
    tools.push(BROWSER_TOOL_DEFINITION);
  }

  // Auto-discover MCP tools from mcporter config
  const mcpTools = await discoverMcpTools();
  tools.push(...mcpTools);

  // Include spawn_subagent, code_with_agent, and check_code_agent tools when requested
  if (options?.includeSpawnSubagent) {
    tools.push(SPAWN_SUBAGENT_TOOL);
    tools.push(CODE_WITH_AGENT_TOOL);
    tools.push(CHECK_CODE_AGENT_TOOL);
  }

  return tools;
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
  if (!['coding', 'research', 'general'].includes(type)) {
    return `Error: Invalid type "${type}". Must be coding, research, or general.`;
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
const CODE_AGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const VALIDATE_TIMEOUT_MS = 60 * 1000; // 60 seconds
const CODE_AGENTS_DIR = join(homedir(), '.skimpyclaw', 'logs', 'code-agents');

export interface CodeAgentTask {
  id: string;                    // "ca-1", "ca-2"
  agent: string;                 // "claude" | "codex"
  task: string;                  // full prompt
  status: 'running' | 'validating' | 'completed' | 'failed' | 'timeout';
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
}

// In-memory tracking
let codeAgentCounter = 0;
const codeAgentTasks = new Map<string, CodeAgentTask>();

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
    .filter(t => t.status !== 'running' && t.status !== 'validating')
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
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    ...toolArgs,
    '--max-turns', maxTurns,
    '--append-system-prompt', 'Output text only. Never use say or TTS. Focus on the coding task. Run pnpm build && pnpm test to verify changes.',
  ];
  if (input.model) args.push('--model', input.model);
  args.push(input.task);
  return { cmd: CLAUDE_CLI_PATH, args };
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

  const workdir = resolve(input.workdir || SKIMPYCLAW_ROOT);
  if (!isPathAllowed(workdir, config.allowedPaths)) {
    return `Error: Working directory not allowed. Permitted: ${config.allowedPaths.join(', ')}`;
  }

  // Concurrency check — share limit with subagents
  const maxConcurrent = context?.fullConfig?.subagents?.maxConcurrent ?? 5;
  const activeCount = getActiveCodeAgents().length;
  if (activeCount >= maxConcurrent) {
    return `Error: Concurrency limit reached (${activeCount}/${maxConcurrent} coding agents running). Wait for one to finish or increase subagents.maxConcurrent.`;
  }

  const validate = input.validate !== false; // default true

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
    model: input.model,
  };
  codeAgentTasks.set(id, caTask);
  writeCodeAgentTask(caTask);

  // Fire-and-forget: spawn background process
  runCodeAgentBackground(id, agent, task, workdir, validate, input, startedAt).catch((err) => {
    console.error(`[code-agent] Background error for ${id}:`, err);
  });

  const taskPreview = task.length > 100 ? task.slice(0, 100) + '...' : task;
  return `Started coding agent ${id} (${agent}). Task: ${taskPreview}\n\nUse check_code_agent to poll status.`;
}

/** Send auto-notification to active channel on completion/failure. */
async function notifyCodeAgentResult(task: CodeAgentTask): Promise<void> {
  if (!_codeAgentConfig) return;
  const { sendActiveChannelProactiveMessage } = await import('./channels.js');

  const dur = task.durationSeconds != null
    ? (task.durationSeconds < 60 ? `${task.durationSeconds}s` : `${Math.floor(task.durationSeconds / 60)}m ${task.durationSeconds % 60}s`)
    : '?';
  const taskPreview = task.task.length > 120 ? task.task.slice(0, 120) + '...' : task.task;

  let message: string;
  if (task.status === 'completed') {
    const validation = task.validationPassed ? ' Build/tests pass.' : '';
    message = `✅ Coding agent ${task.id} completed (${dur}).${validation}\n\nTask: ${taskPreview}`;
    if (task.outputPreview) message += `\n\nResult: ${task.outputPreview}`;
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

/** Background execution of a coding agent. Updates task status throughout. */
async function runCodeAgentBackground(
  id: string,
  agent: string,
  task: string,
  workdir: string,
  validate: boolean,
  input: Record<string, any>,
  startedAt: Date,
): Promise<void> {
  const caTask = codeAgentTasks.get(id)!;

  // Start audit trace
  const traceId = startTrace('code_agent');
  addEvent(traceId, {
    type: 'spawn',
    summary: `${agent}: ${task.slice(0, 150)}`,
    durationMs: 0,
    detail: { agent, workdir, model: input.model, validate },
  });

  const { cmd, args } = buildCodeAgentArgs({
    task,
    agent,
    workdir,
    model: input.model,
    max_turns: input.max_turns,
  });

  let stdout = '';
  let stderr = '';

  try {
    const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
      const spawnEnv = { ...process.env };
      delete spawnEnv.CLAUDECODE;
      const proc = spawn(cmd, args, {
        cwd: workdir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv,
      });

      let lastStatusWrite = 0;
      const STATUS_WRITE_INTERVAL = 3000;

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const now = Date.now();
        if (now - lastStatusWrite > STATUS_WRITE_INTERVAL) {
          lastStatusWrite = now;
          caTask.liveOutput = stdout.slice(-5000);
          writeCodeAgentTask(caTask);
        }
      });
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, CODE_AGENT_TIMEOUT_MS);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`${agent} agent timed out after ${CODE_AGENT_TIMEOUT_MS / 60000} minutes`));
        } else {
          resolvePromise(code);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Parse output
    let agentOutput: string;
    if (agent === 'claude') {
      try {
        const parsed = JSON.parse(stdout);
        agentOutput = parsed.result || parsed.content || stdout;
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
        outputPreview: agentOutput.slice(0, 500),
        error: `Exited with code ${exitCode}`,
        liveOutput: undefined,
      });
      writeCodeAgentTask(caTask);
      await notifyCodeAgentResult(caTask);
      return;
    }

    // Post-validation gate
    if (validate) {
      caTask.status = 'validating';
      caTask.outputPreview = agentOutput.slice(0, 500);
      caTask.liveOutput = undefined;
      writeCodeAgentTask(caTask);

      const runValidation = (): Promise<string> => new Promise((res) => {
        exec('pnpm build && pnpm test', {
          cwd: workdir,
          timeout: VALIDATE_TIMEOUT_MS,
          maxBuffer: 5 * 1024 * 1024,
        }, (error, vStdout, vStderr) => {
          if (error) {
            res([`VALIDATION FAILED (exit ${error.code}):`, vStdout, vStderr].filter(Boolean).join('\n').slice(0, 8_000));
          } else {
            res('PASS');
          }
        });
      });

      let validateResult = await runValidation();

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

          let lastStatusWrite = 0;
          retryProc.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
            const now = Date.now();
            if (now - lastStatusWrite > 3000) {
              lastStatusWrite = now;
              caTask.liveOutput = stdout.slice(-5000);
              writeCodeAgentTask(caTask);
            }
          });
          retryProc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

          const retryTimer = setTimeout(() => retryProc.kill('SIGTERM'), CODE_AGENT_TIMEOUT_MS);
          retryProc.on('close', (code) => { clearTimeout(retryTimer); resolveRetry(code); });
          retryProc.on('error', (err) => { clearTimeout(retryTimer); rejectRetry(err); });
        });

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
          outputPreview: agentOutput.slice(0, 500),
          error: 'Validation failed',
        });
        writeCodeAgentTask(caTask);
        await notifyCodeAgentResult(caTask);
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
        outputPreview: agentOutput.slice(0, 500),
      });
      writeCodeAgentTask(caTask);
      await notifyCodeAgentResult(caTask);
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
      outputPreview: agentOutput.slice(0, 500),
      liveOutput: undefined,
    });
    writeCodeAgentTask(caTask);
    await notifyCodeAgentResult(caTask);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    addEvent(traceId, { type: 'error', summary: errMsg.slice(0, 200), durationMs: Date.now() - startedAt.getTime() });
    await endTrace(traceId, 'error');
    Object.assign(caTask, {
      status: errMsg.includes('timed out') ? 'timeout' : 'failed',
      endedAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      error: errMsg,
      liveOutput: undefined,
    });
    writeCodeAgentTask(caTask);
    await notifyCodeAgentResult(caTask);
  }
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
