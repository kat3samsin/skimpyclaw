// Claude Code canonical tool names (stealth mode for OAuth compatibility)
// Maps our internal names to Claude Code's exact casing
const TOOL_NAME_MAP: Record<string, string> = {
  'Read': 'read_file',
  'Write': 'write_file',
  'Glob': 'list_directory',
  'Bash': 'bash',
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
    input_schema: { type: 'object' as const, properties: { path: {} } },
  },
  {
    name: 'Write',
    input_schema: { type: 'object' as const, properties: { path: {}, content: {} }, required: ['path', 'content'] },
  },
  {
    name: 'Glob',
    input_schema: { type: 'object' as const, properties: { path: {}, pattern: {} } },
  },
  {
    name: 'Bash',
    input_schema: { type: 'object' as const, properties: { cmd: {} } },
  },
];

export const FETCH_TOOL_DEFINITION = {
  name: 'Fetch',
  input_schema: { type: 'object' as const, properties: { url: {} } },
};

// Legacy export for backward compat — static list (built-ins + fetch + no MCP)
export const TOOL_DEFINITIONS = [...BUILTIN_TOOL_DEFINITIONS, FETCH_TOOL_DEFINITION];


export const CODE_WITH_AGENT_TOOL = {
  name: 'code_with_agent',
  input_schema: {
    type: 'object' as const,
    properties: {
      task: { type: 'string' as const },
      agent: { type: 'string' as const },
      interactive: {
        type: 'boolean' as const,
        description: 'If true, spawn as an interactive session. Creates a Discord thread and resumes session on follow-up messages. Discord-only; claude or codex only. Default false.',
      },
      effort: {
        type: 'string' as const,
        enum: ['none', 'low', 'medium', 'high', 'xhigh'],
        description: 'Optional reasoning effort for coding agents that support it.',
      },
      worktree: {
        description: 'Use an isolated git worktree for this task. true forces one, false disables it, auto uses one for review/rebase-style tasks. Default auto.',
      },
    },
    required: ['task'],
  },
};

export const CHECK_CODE_AGENT_TOOL = {
  name: 'check_code_agent',
  input_schema: { type: 'object' as const, properties: { id: { type: 'string' as const } } },
};

export const DELEGATE_TO_AGENT_TOOL = {
  name: 'delegate_to_agent',
  input_schema: {
    type: 'object' as const,
    properties: {
      alias: {
        type: 'string' as const,
        description: 'Discord agent profile alias to delegate to, without @.',
      },
      task: {
        type: 'string' as const,
        description: 'Task or question for the target agent profile.',
      },
      mode: {
        type: 'string' as const,
        enum: ['new_thread'],
        description: 'Delegation mode. Only new_thread is currently supported.',
      },
      wait: {
        type: 'boolean' as const,
        description: 'If true, wait for the delegated agent response. Default false.',
      },
    },
    required: ['alias', 'task'],
  },
};
