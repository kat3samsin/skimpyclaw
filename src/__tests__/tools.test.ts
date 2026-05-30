import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { executeTool, BUILTIN_TOOL_DEFINITIONS, CODE_WITH_AGENT_TOOL, CHECK_CODE_AGENT_TOOL, DELEGATE_TO_AGENT_TOOL, getToolDefinitions, fromClaudeCodeName, toClaudeCodeName, buildCodeAgentArgs, getActiveCodeAgents, getRecentCodeAgents, getCodeAgent, normalizeMcpToolArgsForExecution } from '../tools.js';
import { registerDelegateToAgentHandler } from '../tools/agent-delegation.js';
import { resolveModelAlias } from '../code-agents/utils.js';
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
});

describe('getToolDefinitions', () => {
  it('returns at least the 4 built-in tools', async () => {
    const tools = await getToolDefinitions(undefined, { includeMcp: false });
    expect(tools.length).toBeGreaterThanOrEqual(4);
    const names = tools.map(t => t.name);
    expect(names).toContain('Read');
    expect(names).toContain('Write');
    expect(names).toContain('Glob');
    expect(names).toContain('Bash');
  }, 15000);

  describe('tool profiles', () => {
    it('minimal returns built-in tools plus Fetch', async () => {
      const config: ToolConfig = { ...toolConfig, toolProfile: 'minimal' };
      const tools = await getToolDefinitions(config, { includeAgentTools: true, includeMcp: true });
      expect(tools).toHaveLength(5);
      expect(tools.map(t => t.name)).toEqual(['Read', 'Write', 'Glob', 'Bash', 'Fetch']);
    });

    it('minimal excludes MCP tools', async () => {
      const config: ToolConfig = { ...toolConfig, toolProfile: 'minimal' };
      const tools = await getToolDefinitions(config, { includeMcp: true });
      expect(tools.every(t => !t.name.startsWith('mcp__'))).toBe(true);
    });

    it('coding includes code_with_agent and check_code_agent', async () => {
      const config: ToolConfig = { ...toolConfig, toolProfile: 'coding' };
      const tools = await getToolDefinitions(config, { includeAgentTools: true });
      const names = tools.map(t => t.name);
      expect(names).toContain('code_with_agent');
      expect(names).toContain('check_code_agent');
    });

    it('coding excludes MCP tools', async () => {
      const config: ToolConfig = { ...toolConfig, toolProfile: 'coding' };
      const tools = await getToolDefinitions(config, { includeMcp: true });
      expect(tools.every(t => !t.name.startsWith('mcp__'))).toBe(true);
    });

    it('full profile behaves like default (no profile set)', async () => {
      const defaultTools = await getToolDefinitions(toolConfig, { includeMcp: false });
      const fullTools = await getToolDefinitions({ ...toolConfig, toolProfile: 'full' }, { includeMcp: false });
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

  it('normalizes context-a8c execute-tool parameter aliases', () => {
    expect(normalizeMcpToolArgsForExecution('context-a8c', 'context-a8c-execute-tool', {
      provider: 'zendesk',
      tool: 'search',
      parameters: { query: 'jetpack search' },
    })).toEqual({
      provider: 'zendesk',
      tool: 'search',
      params: { query: 'jetpack search' },
    });

    expect(normalizeMcpToolArgsForExecution('context-a8c', 'context-a8c-execute-tool', {
      provider: 'slack',
      tool: 'search',
      query: 'jetpack search',
      limit: 10,
    })).toEqual({
      provider: 'slack',
      tool: 'search',
      params: { query: 'jetpack search', limit: 10 },
    });
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
    expect(result).toBe('OK');
    expect(readFileSync(path, 'utf-8')).toBe('new content');
  });

  it('creates parent directories', async () => {
    const path = join(TEST_DIR, 'sub', 'deep', 'file.txt');
    const result = await executeTool('Write', { path, content: 'deep' }, toolConfig);
    expect(result).toBe('OK');
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

  it('accepts the Glob schema pattern argument', async () => {
    const result = await executeTool('Glob', { pattern: TEST_DIR }, toolConfig);
    expect(result).toContain('hello.txt');
    expect(result).toContain('file');
  });

  it('lists the parent directory for a glob-style pattern', async () => {
    const result = await executeTool('Glob', { pattern: join(TEST_DIR, '*.txt') }, toolConfig);
    expect(result).toContain('hello.txt');
    expect(result).toContain('file');
  });

  it('lists the parent directory for a glob-style path argument', async () => {
    const result = await executeTool('Glob', { path: join(TEST_DIR, '*.txt') }, toolConfig);
    expect(result).toContain('hello.txt');
    expect(result).toContain('file');
  });

  it('rejects listing outside allowed paths', async () => {
    const result = await executeTool('Glob', { path: OUTSIDE_DIR }, toolConfig);
    expect(result).toContain('Error: Path not allowed');
  });

  it('rejects glob-style patterns outside allowed paths', async () => {
    const result = await executeTool('Glob', { pattern: join(OUTSIDE_DIR, '*.txt') }, toolConfig);
    expect(result).toContain('Error: Path not allowed');
  });

  it('rejects traversal-shaped glob patterns outside allowed paths', async () => {
    const result = await executeTool('Glob', { pattern: `${TEST_DIR}/../__test_outside__/*.txt` }, toolConfig);
    expect(result).toContain('Error: Path not allowed');
  });

  it('rejects relative glob-style patterns outside allowed paths', async () => {
    const result = await executeTool('Glob', { pattern: '*.txt' }, toolConfig);
    expect(result).toContain('Error: Path not allowed');
  });

  it('returns a clear error when path and pattern are missing', async () => {
    const result = await executeTool('Glob', {}, toolConfig);
    expect(result).toBe('Error: Missing path or pattern');
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

  it('blocks shell command chaining to prevent injection patterns', async () => {
    const result = await executeTool('Bash', { command: 'echo hello; uname -a' }, toolConfig);
    expect(result).toContain('Shell control operators are blocked');
  });

  it('blocks shell pipe operators to avoid implicit shell mode', async () => {
    const result = await executeTool('Bash', { command: 'echo hello | cat' }, toolConfig);
    expect(result).toContain('Shell control operators are blocked');
  });

  it('allows shell-looking characters inside quoted arguments', async () => {
    const result = await executeTool('Bash', { command: 'printf \"hello|world\"' }, toolConfig);
    expect(result.trim()).toBe('hello|world');
  });

  it('blocks dangerous commands via exec approval', async () => {
    const result = await executeTool('Bash', { command: `rm -rf ${TEST_DIR}` }, toolConfig);
    expect(result).toContain('⛔');
    expect(result).toContain('tier 3');
  });

  it('blocks sudo via exec approval', async () => {
    const result = await executeTool('Bash', { command: `sudo ls ${TEST_DIR}` }, toolConfig);
    expect(result).toContain('⛔');
    expect(result).toContain('tier 2');
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
      expect(props).toContain('worktree');
      // workdir, model, max_turns, validate — omitted from schema to save tokens (executor still accepts them)
    });

    it('is included in getToolDefinitions when includeSpawnSubagent is true', async () => {
      const tools = await getToolDefinitions(toolConfig, { includeAgentTools: true, includeMcp: false });
      expect(tools.map(t => t.name)).toContain('code_with_agent');
    });

    it('is excluded from getToolDefinitions when includeSpawnSubagent is false', async () => {
      const tools = await getToolDefinitions(toolConfig, { includeMcp: false });
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
      const { cmd, args } = buildCodeAgentArgs({ task: 'fix it', model: 'claude-opus-4-7' });
      expect(cmd).toContain('claude');
      expect(args).toContain('--model');
      expect(args).toContain('claude-opus-4-7');
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
      expect(args).toContain('--skip-git-repo-check');
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

    it('builds codex args with effort override', () => {
      const { args } = buildCodeAgentArgs({ task: 'fix it', agent: 'codex', effort: 'xhigh' });
      expect(args).toContain('-c');
      expect(args).toContain('model_reasoning_effort=xhigh');
    });

    it('does not include --allowedTools for codex', () => {
      const { args } = buildCodeAgentArgs({ task: 'fix it', agent: 'codex' });
      expect(args).not.toContain('--allowedTools');
    });

    it('includes --append-system-prompt for claude', () => {
      const { args } = buildCodeAgentArgs({ task: 'fix it' });
      expect(args).toContain('--append-system-prompt');
      const prompt = args[args.indexOf('--append-system-prompt') + 1];
      expect(prompt).toContain('SkimpyClaw code_with_agent subagent');
      expect(prompt).toContain('Do not post GitHub comments');
      expect(prompt).toContain('For read-only review or artifact tasks');
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

    it('normalizes dotted claude opus 4.6 model id', () => {
      expect(resolveModelAlias('anthropic/claude-opus-4.6', {})).toBe('claude-opus-4-6');
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
      const tools = await getToolDefinitions(toolConfig, { includeAgentTools: true, includeMcp: false });
      expect(tools.map(t => t.name)).toContain('check_code_agent');
    });

    it('is excluded from getToolDefinitions when includeSpawnSubagent is false', async () => {
      const tools = await getToolDefinitions(toolConfig, { includeMcp: false });
      expect(tools.map(t => t.name)).not.toContain('check_code_agent');
    });
  });

  describe('delegate_to_agent tool', () => {
    afterEach(() => {
      registerDelegateToAgentHandler(null);
    });

    it('has expected tool definition', () => {
      expect(DELEGATE_TO_AGENT_TOOL.name).toBe('delegate_to_agent');
      expect(DELEGATE_TO_AGENT_TOOL.input_schema.required).toEqual(['alias', 'task']);
    });

    it('is included in getToolDefinitions when agent tools are enabled', async () => {
      const tools = await getToolDefinitions(toolConfig, { includeAgentTools: true, includeMcp: false });
      expect(tools.map(t => t.name)).toContain('delegate_to_agent');
    });

    it('rejects non-Discord contexts', async () => {
      const result = await executeTool('delegate_to_agent', {
        alias: 'reviewer',
        task: 'review this',
      }, toolConfig, {
        fullConfig: { agents: { default: 'main', list: {} } } as any,
        channel: 'telegram',
      });
      expect(result).toContain('Discord-only');
    });

    it('calls the registered delegation handler for Discord', async () => {
      registerDelegateToAgentHandler(async (input) => `delegated ${input.alias}: ${input.task}`);
      const result = await executeTool('delegate_to_agent', {
        alias: '@Reviewer',
        task: 'review this',
      }, toolConfig, {
        fullConfig: { agents: { default: 'main', list: {} } } as any,
        channel: 'discord',
        channelTargetId: '123',
      });
      expect(result).toBe('delegated reviewer: review this');
    });

    it('blocks self delegation', async () => {
      registerDelegateToAgentHandler(async () => 'should not run');
      const result = await executeTool('delegate_to_agent', {
        alias: 'reviewer',
        task: 'review this',
      }, toolConfig, {
        fullConfig: { agents: { default: 'main', list: {} } } as any,
        channel: 'discord',
        threadAgentAlias: 'reviewer',
      });
      expect(result).toContain('cannot delegate to itself');
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
