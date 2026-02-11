import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { executeTool, BUILTIN_TOOL_DEFINITIONS, BROWSER_TOOL_DEFINITION, getToolDefinitions, fromClaudeCodeName, toClaudeCodeName } from '../tools.js';
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
    const result = await executeTool('Bash', { command: 'cat /nonexistent_file_xyz' }, toolConfig);
    expect(result).toContain('No such file');
  });

  it('handles unknown tools', async () => {
    const result = await executeTool('delete_everything', {}, toolConfig);
    expect(result).toContain('Error: Unknown tool');
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
