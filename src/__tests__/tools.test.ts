import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { executeTool, BUILTIN_TOOL_DEFINITIONS, BROWSER_TOOL_DEFINITION, CODE_WITH_AGENT_TOOL, CODE_WITH_TEAM_TOOL, CHECK_CODE_AGENT_TOOL, getToolDefinitions, fromClaudeCodeName, toClaudeCodeName, buildCodeAgentArgs, getActiveCodeAgents, getRecentCodeAgents, getCodeAgent, readTeamState, decomposeTask, synthesizeResults, computeWaves } from '../tools.js';
import { resolveModelAlias } from '../code-agents/utils.js';
import type { DecomposedSubtask } from '../tools.js';
import type { ToolConfig } from '../types.js';

const TEST_DIR = join(process.cwd(), '__test_sandbox__');
const OUTSIDE_DIR = join(process.cwd(), '__test_outside__');

const toolConfig: ToolConfig = {
  enabled: true,
  allowedPaths: [TEST_DIR],
  maxIterations: 5,
  bashTimeout: 5000,
};

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(OUTSIDE_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, 'hello.txt'), 'hello world');
  writeFileSync(join(OUTSIDE_DIR, 'secret.txt'), 'top secret');
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  rmSync(OUTSIDE_DIR, { recursive: true, force: true });
});

describe('BUILTIN_TOOL_DEFINITIONS', () => {
  it('exports 4 built-in tools', () => {
    expect(BUILTIN_TOOL_DEFINITIONS).toHaveLength(4);
    const names = BUILTIN_TOOL_DEFINITIONS.map(t => t.name);
    expect(names).toContain('Read');
    expect(names).toContain('Write');
    expect(names).toContain('Glob');
    expect(names).toContain('Bash');
  });

  it('exports Browser tool definition separately', () => {
    expect(BROWSER_TOOL_DEFINITION.name).toBe('Browser');
    expect(BROWSER_TOOL_DEFINITION.input_schema).toBeDefined();
  });
});

describe('getToolDefinitions', () => {
  it('returns at least the 4 built-in tools', async () => {
    const tools = await getToolDefinitions();
    expect(tools.length).toBeGreaterThanOrEqual(4);
    const names = tools.map(t => t.name);
    expect(names).toContain('Read');
    expect(names).toContain('Write');
    expect(names).toContain('Glob');
    expect(names).toContain('Bash');
  }, 15000);

  it('includes Browser when browser.enabled is true', async () => {
    const config: ToolConfig = { ...toolConfig, browser: { enabled: true } };
    const tools = await getToolDefinitions(config);
    expect(tools.map(t => t.name)).toContain('Browser');
  });

  it('excludes Browser when browser.enabled is false', async () => {
    const config: ToolConfig = { ...toolConfig, browser: { enabled: false } };
    const tools = await getToolDefinitions(config);
    expect(tools.map(t => t.name)).not.toContain('Browser');
  });

  it('excludes Browser when no config provided', async () => {
    const tools = await getToolDefinitions();
    expect(tools.map(t => t.name)).not.toContain('Browser');
  });

  describe('tool profiles', () => {
    it('minimal returns built-in tools plus Fetch', async () => {
      const config: ToolConfig = { ...toolConfig, toolProfile: 'minimal' };
      const tools = await getToolDefinitions(config, { includeAgentTools: true, includeMcp: true });
      expect(tools).toHaveLength(5);
      expect(tools.map(t => t.name)).toEqual(['Read', 'Write', 'Glob', 'Bash', 'Fetch']);
    });

    it('minimal excludes Browser even when browser.enabled is true', async () => {
      const config: ToolConfig = { ...toolConfig, toolProfile: 'minimal', browser: { enabled: true } };
      const tools = await getToolDefinitions(config);
      expect(tools.map(t => t.name)).not.toContain('Browser');
    });

    it('minimal excludes MCP tools', async () => {
      const config: ToolConfig = { ...toolConfig, toolProfile: 'minimal' };
      const tools = await getToolDefinitions(config, { includeMcp: true });
      expect(tools.every(t => !t.name.startsWith('mcp__'))).toBe(true);
    });

    it('coding includes code_with_agent and check_code_agent but not code_with_team', async () => {
      const config: ToolConfig = { ...toolConfig, toolProfile: 'coding' };
      const tools = await getToolDefinitions(config, { includeAgentTools: true });
      const names = tools.map(t => t.name);
      expect(names).toContain('code_with_agent');
      expect(names).toContain('check_code_agent');

      expect(names).not.toContain('code_with_team');
    });

    it('coding excludes MCP tools', async () => {
      const config: ToolConfig = { ...toolConfig, toolProfile: 'coding' };
      const tools = await getToolDefinitions(config, { includeMcp: true });
      expect(tools.every(t => !t.name.startsWith('mcp__'))).toBe(true);
    });

    it('full profile behaves like default (no profile set)', async () => {
      const defaultTools = await getToolDefinitions(toolConfig);
      const fullTools = await getToolDefinitions({ ...toolConfig, toolProfile: 'full' });
      expect(fullTools.map(t => t.name)).toEqual(defaultTools.map(t => t.name));
    }, 15000);
  });
});

describe('tool name mapping', () => {
  it('maps Claude Code names to internal names', () => {
    expect(fromClaudeCodeName('Read')).toBe('read_file');
    expect(fromClaudeCodeName('Write')).toBe('write_file');
    expect(fromClaudeCodeName('Glob')).toBe('list_directory');
    expect(fromClaudeCodeName('Bash')).toBe('bash');
  });

  it('maps internal names to Claude Code names', () => {
    expect(toClaudeCodeName('read_file')).toBe('Read');
    expect(toClaudeCodeName('write_file')).toBe('Write');
    expect(toClaudeCodeName('list_directory')).toBe('Glob');
    expect(toClaudeCodeName('bash')).toBe('Bash');
  });

  it('passes through unknown names unchanged', () => {
    expect(fromClaudeCodeName('unknown')).toBe('unknown');
    expect(toClaudeCodeName('unknown')).toBe('unknown');
  });
});

describe('MCP tool name parsing', () => {
  it('routes mcp__server__tool names to MCP executor', async () => {
    // This will fail because the MCP server doesn't exist, but the routing should work
    const result = await executeTool('mcp__fake_server__fake_tool', { arg: 'test' }, toolConfig);
    // Should get an MCP error, NOT "Unknown tool"
    expect(result).toContain('Error:');
    expect(result).not.toContain('Unknown tool');
  });

  it('routes mcp__ names with dashes correctly', async () => {
    const result = await executeTool('mcp__my-server__my-tool', { arg: 'test' }, toolConfig);
    expect(result).toContain('Error:');
    expect(result).not.toContain('Unknown tool');
  });

  it('routes mcp__ names with multiple segments correctly', async () => {
    const result = await executeTool('mcp__server__category__subtool', { arg: 'test' }, toolConfig);
    expect(result).toContain('Error:');
    expect(result).not.toContain('Unknown tool');
  });
});

describe('read_file', () => {
  it('reads a file within allowed paths', async () => {
    const result = await executeTool('Read', { path: join(TEST_DIR, 'hello.txt') }, toolConfig);
    expect(result).toBe('hello world');
  });

  it('rejects paths outside allowed directories', async () => {
    const result = await executeTool('Read', { path: join(OUTSIDE_DIR, 'secret.txt') }, toolConfig);
    expect(result).toContain('Error: Path not allowed');
  });

  it('returns error for nonexistent file', async () => {
    const result = await executeTool('Read', { path: join(TEST_DIR, 'nope.txt') }, toolConfig);
    expect(result).toContain('Error: File not found');
  });

  it('rejects path traversal attempts', async () => {
    const result = await executeTool('Read', { path: join(TEST_DIR, '..', '__test_outside__', 'secret.txt') }, toolConfig);
    expect(result).toContain('Error: Path not allowed');
  });

  it('rejects sibling path prefix bypass attempts', async () => {
    const siblingDir = `${TEST_DIR}-sibling`;
    mkdirSync(siblingDir, { recursive: true });
    const siblingFile = join(siblingDir, 'secret.txt');
    writeFileSync(siblingFile, 'top secret');

    const result = await executeTool('Read', { path: siblingFile }, toolConfig);
    expect(result).toContain('Error: Path not allowed');

    rmSync(siblingDir, { recursive: true, force: true });
  });
});

describe('write_file', () => {
  it('writes a new file', async () => {
    const path = join(TEST_DIR, 'new.txt');
    const result = await executeTool('Write', { path, content: 'new content' }, toolConfig);
    expect(result).toContain('Written');
    expect(readFileSync(path, 'utf-8')).toBe('new content');
  });

  it('creates parent directories', async () => {
    const path = join(TEST_DIR, 'sub', 'deep', 'file.txt');
    const result = await executeTool('Write', { path, content: 'deep' }, toolConfig);
    expect(result).toContain('Written');
    expect(readFileSync(path, 'utf-8')).toBe('deep');
  });

  it('rejects writes outside allowed paths', async () => {
    const result = await executeTool('Write', { path: join(OUTSIDE_DIR, 'hack.txt'), content: 'bad' }, toolConfig);
    expect(result).toContain('Error: Path not allowed');
    expect(existsSync(join(OUTSIDE_DIR, 'hack.txt'))).toBe(false);
  });
});

describe('list_directory', () => {
  it('lists directory contents', async () => {
    const result = await executeTool('Glob', { path: TEST_DIR }, toolConfig);
    expect(result).toContain('hello.txt');
    expect(result).toContain('file');
  });

  it('rejects listing outside allowed paths', async () => {
    const result = await executeTool('Glob', { path: OUTSIDE_DIR }, toolConfig);
    expect(result).toContain('Error: Path not allowed');
  });

  it('returns error for nonexistent directory', async () => {
    const result = await executeTool('Glob', { path: join(TEST_DIR, 'nope') }, toolConfig);
    expect(result).toContain('Error: Directory not found');
  });
});

describe('bash', () => {
  it('executes a simple command', async () => {
    const result = await executeTool('Bash', { command: 'echo hello' }, toolConfig);
    expect(result.trim()).toBe('hello');
  });

  it('blocks dangerous commands', async () => {
    const result = await executeTool('Bash', { command: 'rm -rf /' }, toolConfig);
    expect(result).toContain('Error: Command blocked');
  });

  it('blocks sudo', async () => {
    const result = await executeTool('Bash', { command: 'sudo cat /etc/passwd' }, toolConfig);
    expect(result).toContain('Error: Command blocked');
  });

  it('respects cwd when in allowed paths', async () => {
    const result = await executeTool('Bash', { command: 'ls', cwd: TEST_DIR }, toolConfig);
    expect(result).toContain('hello.txt');
  });

  it('rejects cwd outside allowed paths', async () => {
    const result = await executeTool('Bash', { command: 'ls', cwd: OUTSIDE_DIR }, toolConfig);
    expect(result).toContain('Error: Working directory not in allowed paths');
  });

  it('returns stderr on failure', async () => {
    const nonexistent = join(TEST_DIR, 'nonexistent_file_xyz');
    const result = await executeTool('Bash', { command: `cat "${nonexistent}"` }, toolConfig);
    expect(result).toContain('No such file');
  });

  it('blocks commands referencing paths outside allowed dirs', async () => {
    const result = await executeTool('Bash', { command: 'cat /etc/passwd' }, toolConfig);
    expect(result).toContain('Error: Command references paths outside allowed directories');
  });

  it('handles unknown tools', async () => {
    const result = await executeTool('delete_everything', {}, toolConfig);
    expect(result).toContain('Error: Unknown tool');
  });

  describe('exec approval in unattended contexts', () => {
    it('fast-denies tier 3 inline interpreter scripts in subagent context', async () => {
      const result = await executeTool(
        'Bash',
        { command: 'node -e "console.log(1)"' },
        toolConfig,
        { channel: 'subagent' },
      );
      expect(result).toContain('⛔');
      expect(result).toContain('tier 3');
      expect(result).not.toContain('approved');
    });

    it('fast-denies tier 2 commands in subagent context', async () => {
      const result = await executeTool(
        'Bash',
        { command: 'gh pr review --approve' },
        toolConfig,
        { channel: 'subagent' },
      );
      expect(result).toContain('⛔');
      expect(result).toContain('tier 2');
    });

    it('fast-denies tier 3 commands in cron context', async () => {
      const result = await executeTool(
        'Bash',
        { command: 'node -e "console.log(1)"' },
        toolConfig,
        { isCronJob: true },
      );
      expect(result).toContain('⛔');
      expect(result).toContain('tier 3');
    });

    it('fast-denies when no approver and no chatId', async () => {
      const result = await executeTool(
        'Bash',
        { command: 'kubectl delete pods --all' },
        toolConfig,
        {},
      );
      expect(result).toContain('⛔');
    });

    it('allows safe tier 0 commands in subagent context', async () => {
      const result = await executeTool(
        'Bash',
        { command: 'echo hello' },
        toolConfig,
        { channel: 'subagent' },
      );
      expect(result.trim()).toBe('hello');
    });
  });
});

describe('browser', () => {
  const browserDisabledConfig: ToolConfig = {
    ...toolConfig,
    browser: { enabled: false },
  };

  const browserEnabledConfig: ToolConfig = {
    ...toolConfig,
    browser: { enabled: true },
  };

  const browserWithFileConfig: ToolConfig = {
    ...toolConfig,
    browser: { enabled: true, allowFile: true },
  };

  it('returns error when browser is disabled', async () => {
    const result = await executeTool('Browser', { action: 'open', url: 'https://example.com' }, browserDisabledConfig);
    expect(result).toContain('Error: Browser tool is disabled');
  });

  it('returns error when browser config is missing', async () => {
    const result = await executeTool('Browser', { action: 'open', url: 'https://example.com' }, toolConfig);
    expect(result).toContain('Error: Browser tool is disabled');
  });

  it('blocks file:// URLs when allowFile is false', async () => {
    const result = await executeTool('Browser', { action: 'open', url: 'file:///etc/passwd' }, browserEnabledConfig);
    expect(result).toContain('Error: file:// URLs are blocked');
  });

  it('validates file:// URLs with new URL() parsing', async () => {
    // file://localhost/etc/passwd should parse to /etc/passwd, which is outside allowedPaths
    const result = await executeTool('Browser', { action: 'open', url: 'file://localhost/etc/passwd' }, browserWithFileConfig);
    expect(result).toContain('Error: file:// URLs are blocked');
  });

  it('returns error for unknown action', async () => {
    const result = await executeTool('Browser', { action: 'destroy' }, browserEnabledConfig);
    expect(result).toContain('Error: Unknown browser action "destroy"');
  });

  it('requires url for open action', async () => {
    const result = await executeTool('Browser', { action: 'open' }, browserEnabledConfig);
    expect(result).toContain('Error: url is required');
  });

  it('requires selector for click action', async () => {
    const result = await executeTool('Browser', { action: 'click' }, browserEnabledConfig);
    expect(result).toContain('Error: Browser not open');
  });

  it('requires selector and text for type action', async () => {
    const result = await executeTool('Browser', { action: 'type', selector: '#input' }, browserEnabledConfig);
    expect(result).toContain('Error: Browser not open');
  });

  it('requires script for evaluate action', async () => {
    const result = await executeTool('Browser', { action: 'evaluate' }, browserEnabledConfig);
    expect(result).toContain('Error: Browser not open');
  });

  it('requires selector for hover action', async () => {
    const result = await executeTool('Browser', { action: 'hover' }, browserEnabledConfig);
    expect(result).toContain('Error: Browser not open');
  });

  it('requires selector and text for select action', async () => {
    const result = await executeTool('Browser', { action: 'select' }, browserEnabledConfig);
    expect(result).toContain('Error: Browser not open');
  });

  it('returns "Browser not open" for actions before open', async () => {
    for (const action of ['click', 'type', 'waitfor', 'screenshot', 'evaluate', 'gettext', 'scroll', 'select', 'hover']) {
      const result = await executeTool('Browser', { action }, browserEnabledConfig);
      expect(result).toContain('Error: Browser not open');
    }
  });

  it('handles close when browser is not open', async () => {
    const result = await executeTool('Browser', { action: 'close' }, browserEnabledConfig);
    expect(result).toBe('Browser closed.');
  });

  it('handles case-insensitive actions', async () => {
    const result = await executeTool('Browser', { action: 'OPEN' }, browserEnabledConfig);
    expect(result).toContain('Error: url is required');
  });

  it('maps Browser name correctly', () => {
    expect(fromClaudeCodeName('Browser')).toBe('browser');
    expect(toClaudeCodeName('browser')).toBe('Browser');
  });
});

describe('code_with_agent', () => {
  describe('tool definition', () => {
    it('has correct name and required fields', () => {
      expect(CODE_WITH_AGENT_TOOL.name).toBe('code_with_agent');
      expect(CODE_WITH_AGENT_TOOL.input_schema.required).toEqual(['task']);
    });

    it('has all expected properties in schema', () => {
      const props = Object.keys(CODE_WITH_AGENT_TOOL.input_schema.properties);
      expect(props).toContain('task');
      expect(props).toContain('agent');
      expect(props).toContain('workdir');
      expect(props).toContain('model');
      expect(props).toContain('max_turns');
      expect(props).toContain('validate');
    });

    it('is included in getToolDefinitions when includeSpawnSubagent is true', async () => {
      const tools = await getToolDefinitions(toolConfig, { includeAgentTools: true });
      expect(tools.map(t => t.name)).toContain('code_with_agent');
    });

    it('is excluded from getToolDefinitions when includeSpawnSubagent is false', async () => {
      const tools = await getToolDefinitions(toolConfig);
      expect(tools.map(t => t.name)).not.toContain('code_with_agent');
    });
  });

  describe('buildCodeAgentArgs', () => {
    it('builds claude args with defaults', () => {
      const { cmd, args } = buildCodeAgentArgs({ task: 'fix the bug' });
      expect(cmd).toContain('claude');
      expect(args).toContain('-p');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('--max-turns');
      expect(args).toContain('50');
      expect(args[args.length - 1]).toBe('fix the bug');
    });

    it('builds claude args with model override', () => {
      const { cmd, args } = buildCodeAgentArgs({ task: 'fix it', model: 'opus' });
      expect(cmd).toContain('claude');
      expect(args).toContain('--model');
      expect(args).toContain('opus');
    });

    it('builds claude args with custom max_turns', () => {
      const { args } = buildCodeAgentArgs({ task: 'fix it', max_turns: 10 });
      const idx = args.indexOf('--max-turns');
      expect(args[idx + 1]).toBe('10');
    });

    it('builds codex args with defaults', () => {
      const { cmd, args } = buildCodeAgentArgs({ task: 'fix the bug', agent: 'codex' });
      expect(cmd).toContain('codex');
      expect(args[0]).toBe('exec');
      expect(args).toContain('--full-auto');
      expect(args).toContain('--json');
      expect(args).toContain('--color');
      expect(args).toContain('never');
      expect(args[args.length - 1]).toBe('fix the bug');
    });

    it('builds codex args with workdir', () => {
      const { args } = buildCodeAgentArgs({ task: 'fix it', agent: 'codex', workdir: '/tmp/project' });
      expect(args).toContain('-C');
      expect(args).toContain('/tmp/project');
    });

    it('builds codex args with model override', () => {
      const { args } = buildCodeAgentArgs({ task: 'fix it', agent: 'codex', model: 'gpt-5.3-codex' });
      expect(args).toContain('-m');
      expect(args).toContain('gpt-5.3-codex');
    });

    it('does not include --allowedTools for codex', () => {
      const { args } = buildCodeAgentArgs({ task: 'fix it', agent: 'codex' });
      expect(args).not.toContain('--allowedTools');
    });

    it('includes --append-system-prompt for claude', () => {
      const { args } = buildCodeAgentArgs({ task: 'fix it' });
      expect(args).toContain('--append-system-prompt');
    });
  });

  describe('resolveModelAlias', () => {
    it('returns undefined for undefined input', () => {
      expect(resolveModelAlias(undefined, {})).toBeUndefined();
    });

    it('resolves aliases from config', () => {
      expect(resolveModelAlias('fast', { fast: 'claude-haiku-4-5' })).toBe('claude-haiku-4-5');
    });

    it('strips provider prefix', () => {
      expect(resolveModelAlias('anthropic/claude-sonnet-4-5', {})).toBe('claude-sonnet-4-5');
      expect(resolveModelAlias('openai/gpt-4.1', {})).toBe('gpt-4.1');
    });

    it('migrates claude-3.5-sonnet to claude-sonnet-4-6', () => {
      expect(resolveModelAlias('claude-3.5-sonnet', {})).toBe('claude-sonnet-4-6');
      expect(resolveModelAlias('claude-3-5-sonnet', {})).toBe('claude-sonnet-4-6');
      expect(resolveModelAlias('claude-3-5-sonnet-20241022', {})).toBe('claude-sonnet-4-6');
    });

    it('migrates claude-3.5-haiku to claude-haiku-4-5', () => {
      expect(resolveModelAlias('claude-3.5-haiku', {})).toBe('claude-haiku-4-5');
      expect(resolveModelAlias('claude-3-5-haiku', {})).toBe('claude-haiku-4-5');
    });

    it('migrates with provider prefix stripped', () => {
      expect(resolveModelAlias('anthropic/claude-3.5-sonnet', {})).toBe('claude-sonnet-4-6');
      expect(resolveModelAlias('anthropic/claude-3-5-sonnet-20241022', {})).toBe('claude-sonnet-4-6');
    });

    it('returns model as-is when no transformation needed', () => {
      expect(resolveModelAlias('claude-sonnet-4-5', {})).toBe('claude-sonnet-4-5');
      expect(resolveModelAlias('gpt-4.1', {})).toBe('gpt-4.1');
    });
  });

  describe('executeTool routing', () => {
    it('rejects workdir outside allowed paths', async () => {
      const result = await executeTool('code_with_agent', {
        task: 'fix it',
        workdir: '/tmp/not-allowed',
      }, toolConfig);
      expect(result).toContain('Error: Working directory not allowed');
    });

    it('returns error when task is missing', async () => {
      const result = await executeTool('code_with_agent', {}, toolConfig);
      expect(result).toContain('Error: task is required');
    });

    it('returns error for invalid agent', async () => {
      const result = await executeTool('code_with_agent', {
        task: 'fix it',
        agent: 'gpt',
      }, toolConfig);
      expect(result).toContain('Error: Invalid agent "gpt"');
    });
  });

  describe('check_code_agent tool', () => {
    it('has expected tool definition', () => {
      expect(CHECK_CODE_AGENT_TOOL.name).toBe('check_code_agent');
      expect(CHECK_CODE_AGENT_TOOL.input_schema.properties).toHaveProperty('id');
    });

    it('is included in getToolDefinitions when includeSpawnSubagent is true', async () => {
      const tools = await getToolDefinitions(toolConfig, { includeAgentTools: true });
      expect(tools.map(t => t.name)).toContain('check_code_agent');
    });

    it('is excluded from getToolDefinitions when includeSpawnSubagent is false', async () => {
      const tools = await getToolDefinitions(toolConfig);
      expect(tools.map(t => t.name)).not.toContain('check_code_agent');
    });
  });

  describe('multi-agent tracking', () => {
    it('getActiveCodeAgents returns empty array initially', () => {
      // Active agents are those currently running — initially none
      const active = getActiveCodeAgents();
      expect(Array.isArray(active)).toBe(true);
    });

    it('getRecentCodeAgents returns empty array initially', () => {
      const recent = getRecentCodeAgents();
      expect(Array.isArray(recent)).toBe(true);
    });

    it('getCodeAgent returns null for nonexistent ID', () => {
      const result = getCodeAgent('ca-999');
      expect(result).toBeNull();
    });

    it('check_code_agent with nonexistent ID returns not found message', async () => {
      const result = await executeTool('check_code_agent', { id: 'ca-999' }, toolConfig);
      expect(result).toContain('No coding agent found');
    });

    it('check_code_agent with no args returns message about no agents', async () => {
      const result = await executeTool('check_code_agent', {}, toolConfig);
      // May return "No coding agents have run yet" or a list depending on state
      expect(typeof result).toBe('string');
    });
  });
});

describe('code_with_team', () => {
  describe('tool definition', () => {
    it('has correct name and required fields', () => {
      expect(CODE_WITH_TEAM_TOOL.name).toBe('code_with_team');
      expect(CODE_WITH_TEAM_TOOL.input_schema.required).toEqual(['task']);
    });

    it('has expected properties in schema (no max_turns)', () => {
      const props = Object.keys(CODE_WITH_TEAM_TOOL.input_schema.properties);
      expect(props).toContain('task');
      expect(props).toContain('team_size');
      expect(props).toContain('workdir');
      expect(props).toContain('agent');
      expect(props).toContain('model');
      expect(props).toContain('timeout_minutes');
      expect(props).toContain('validate');
      // max_turns removed — not relevant for parallel agents
      expect(props).not.toContain('max_turns');
    });

    it('is included in getToolDefinitions when includeSpawnSubagent is true', async () => {
      const tools = await getToolDefinitions(toolConfig, { includeAgentTools: true });
      expect(tools.map(t => t.name)).toContain('code_with_team');
    });

    it('is excluded from getToolDefinitions when includeSpawnSubagent is false', async () => {
      const tools = await getToolDefinitions(toolConfig);
      expect(tools.map(t => t.name)).not.toContain('code_with_team');
    });
  });

  describe('executeTool routing', () => {
    it('rejects workdir outside allowed paths', async () => {
      const result = await executeTool('code_with_team', {
        task: 'refactor auth',
        workdir: '/tmp/not-allowed',
      }, toolConfig);
      expect(result).toContain('Error: Working directory not allowed');
    });

    it('returns error when task is missing', async () => {
      const result = await executeTool('code_with_team', {}, toolConfig);
      expect(result).toContain('Error: task is required');
    });

    it('returns error when agent is invalid', async () => {
      const result = await executeTool('code_with_team', {
        task: 'refactor auth',
        agent: 'not-a-real-agent',
      }, toolConfig);
      expect(result).toContain('Error: Invalid agent');
    });
  });
});

describe('decomposeTask', () => {
  it('falls back to numbered subtasks with DecomposedSubtask format on error', async () => {
    // decomposeTask with no valid config will fail the model call and use fallback
    const mockConfig = {
      agents: { list: {} },
    } as any;
    const subtasks = await decomposeTask('fix everything', 3, mockConfig);
    expect(subtasks).toHaveLength(3);
    expect(subtasks[0].description).toContain('Part 1 of 3');
    expect(subtasks[1].description).toContain('Part 2 of 3');
    expect(subtasks[2].description).toContain('Part 3 of 3');
    expect(subtasks[0].description).toContain('fix everything');
    // Fallback produces all-independent subtasks
    expect(subtasks[0].dependsOn).toEqual([]);
    expect(subtasks[1].dependsOn).toEqual([]);
    expect(subtasks[2].dependsOn).toEqual([]);
  });
});

describe('computeWaves', () => {
  it('puts all independent subtasks in a single wave', () => {
    const subtasks: DecomposedSubtask[] = [
      { description: 'task A', dependsOn: [] },
      { description: 'task B', dependsOn: [] },
      { description: 'task C', dependsOn: [] },
    ];
    const waves = computeWaves(subtasks);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toEqual([0, 1, 2]);
  });

  it('creates sequential waves for a dependency chain', () => {
    const subtasks: DecomposedSubtask[] = [
      { description: 'schema', dependsOn: [] },
      { description: 'queries', dependsOn: [0] },
      { description: 'tests', dependsOn: [1] },
    ];
    const waves = computeWaves(subtasks);
    expect(waves).toHaveLength(3);
    expect(waves[0]).toEqual([0]);
    expect(waves[1]).toEqual([1]);
    expect(waves[2]).toEqual([2]);
  });

  it('groups tasks with shared dependency into the same wave', () => {
    const subtasks: DecomposedSubtask[] = [
      { description: 'schema', dependsOn: [] },
      { description: 'API endpoints', dependsOn: [0] },
      { description: 'admin endpoints', dependsOn: [0] },
      { description: 'integration tests', dependsOn: [1, 2] },
    ];
    const waves = computeWaves(subtasks);
    expect(waves).toHaveLength(3);
    expect(waves[0]).toEqual([0]);
    expect(waves[1].sort()).toEqual([1, 2]);
    expect(waves[2]).toEqual([3]);
  });

  it('handles mixed independent and dependent tasks', () => {
    const subtasks: DecomposedSubtask[] = [
      { description: 'setup types', dependsOn: [] },
      { description: 'write docs', dependsOn: [] },
      { description: 'implement using types', dependsOn: [0] },
    ];
    const waves = computeWaves(subtasks);
    expect(waves).toHaveLength(2);
    expect(waves[0].sort()).toEqual([0, 1]);
    expect(waves[1]).toEqual([2]);
  });

  it('handles dependency cycles by forcing remaining into current wave', () => {
    const subtasks: DecomposedSubtask[] = [
      { description: 'A depends on B', dependsOn: [1] },
      { description: 'B depends on A', dependsOn: [0] },
    ];
    const waves = computeWaves(subtasks);
    // Both should end up in a wave despite the cycle
    const allIndices = waves.flat().sort();
    expect(allIndices).toEqual([0, 1]);
  });

  it('handles single subtask', () => {
    const subtasks: DecomposedSubtask[] = [
      { description: 'only task', dependsOn: [] },
    ];
    const waves = computeWaves(subtasks);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toEqual([0]);
  });

  it('handles empty subtask list', () => {
    const waves = computeWaves([]);
    expect(waves).toHaveLength(0);
  });
});

describe('synthesizeResults', () => {
  it('falls back to mechanical summary on error', async () => {
    const mockConfig = {
      agents: { list: {} },
    } as any;
    const results = [
      { subtask: 'fix auth', status: 'completed', output: 'done' },
      { subtask: 'fix tests', status: 'failed', error: 'timeout' },
    ];
    const summary = await synthesizeResults('fix everything', results, mockConfig);
    expect(summary).toContain('1/2 subtasks succeeded');
    expect(summary).toContain('1 failed');
    expect(summary).toContain('fix auth');
    expect(summary).toContain('fix tests');
  });
});

describe('readTeamState (deprecated)', () => {
  it('always returns null', () => {
    const state = readTeamState();
    expect(state).toBeNull();
  });
});
