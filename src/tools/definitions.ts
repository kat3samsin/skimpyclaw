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
    },
    required: ['task', 'type'],
  },
};

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
      validate: { type: 'boolean', description: 'Run build && test after completion using the auto-detected package manager (default: true)' },
    },
    required: ['task'],
  },
};

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
      validate: { type: 'boolean', description: 'Run build && test after all agents complete using the auto-detected package manager (default: true)' },
    },
    required: ['task'],
  },
};

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
