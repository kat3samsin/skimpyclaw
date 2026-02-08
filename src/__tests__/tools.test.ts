import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { executeTool, TOOL_DEFINITIONS, fromClaudeCodeName, toClaudeCodeName } from '../tools.js';
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

describe('TOOL_DEFINITIONS', () => {
  it('exports 4 tools with Claude Code names', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(4);
    const names = TOOL_DEFINITIONS.map(t => t.name);
    expect(names).toContain('Read');
    expect(names).toContain('Write');
    expect(names).toContain('Glob');
    expect(names).toContain('Bash');
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

  it('rejects symlink traversal outside allowed paths', async () => {
    const linkPath = join(TEST_DIR, 'link-out');
    symlinkSync(OUTSIDE_DIR, linkPath);

    const result = await executeTool('Read', { path: join(linkPath, 'secret.txt') }, toolConfig);
    expect(result).toContain('Error: Path not allowed');
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
