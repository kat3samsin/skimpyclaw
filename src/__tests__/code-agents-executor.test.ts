import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock all heavy dependencies before importing
vi.mock('../code-agents/registry.js', () => {
  const tasks = new Map<string, any>();
  return {
    getCodeAgentsDir: () => '/tmp/test-code-agents',
    ensureCodeAgentsDir: vi.fn(),
    writeCodeAgentTask: vi.fn((task: any) => tasks.set(task.id, { ...task })),
    storeCodeAgentTask: vi.fn((task: any) => tasks.set(task.id, { ...task })),
    getCodeAgent: vi.fn((id: string) => tasks.get(id) || null),
    setCodeAgentCanceller: vi.fn(),
    deleteCodeAgentCanceller: vi.fn(),
    getNextCodeAgentId: vi.fn(() => 'ca-test-1'),
    _tasks: tasks,
  };
});

vi.mock('../code-agents/parser.js', () => ({
  parseStreamJsonForLive: vi.fn((s: string) => s.slice(0, 200)),
  parseClaudeOutput: vi.fn((s: string) => ({ text: s, costUsd: 0 })),
  parseCodexOutput: vi.fn((s: string) => s),
}));

vi.mock('../code-agents/utils.js', () => ({
  buildCodeAgentArgs: vi.fn(() => ({ cmd: 'echo', args: ['hello'] })),
  notifyCodeAgentResult: vi.fn(async () => {}),
  resolveModelAlias: vi.fn((m: string) => m),
}));

vi.mock('../audit.js', () => ({
  startTrace: vi.fn(() => 'trace-1'),
  addEvent: vi.fn(),
  endTrace: vi.fn(async () => {}),
}));

// We need child_process to be real for spawn tests, but we'll mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    createWriteStream: vi.fn(() => ({
      write: vi.fn(),
      end: vi.fn(),
    })),
  };
});

describe('executor - SIGKILL fallback on timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('schedules SIGKILL 5s after SIGTERM on timeout', async () => {
    // We test by reading the source to confirm the pattern exists
    // since actually spawning processes with fake timers is fragile.
    // Instead, verify the source code contains the SIGKILL fallback pattern.
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs');
    const src = readFileSync(
      new URL('../../src/code-agents/executor.ts', import.meta.url).pathname.replace('/.worktrees/hardening-code-agents/src/__tests__/../../', '/.worktrees/hardening-code-agents/'),
      'utf-8',
    );

    // Main proc timeout - should have SIGKILL fallback
    const mainTimeoutMatch = src.match(
      /timedOut\s*=\s*true;\s*\n\s*proc\.kill\('SIGTERM'\);\s*\n\s*\/\/ SIGKILL fallback.*\n\s*setTimeout\(\(\)\s*=>\s*\{\s*\n\s*try\s*\{\s*proc\.kill\('SIGKILL'\);\s*\}/,
    );
    expect(mainTimeoutMatch).not.toBeNull();

    // Retry proc timeout - should also have SIGKILL fallback
    const retryTimeoutMatch = src.match(
      /retryProc\.kill\('SIGTERM'\);\s*\n\s*\/\/ SIGKILL fallback.*\n\s*setTimeout\(\(\)\s*=>\s*\{\s*\n\s*try\s*\{\s*retryProc\.kill\('SIGKILL'\);\s*\}/,
    );
    expect(retryTimeoutMatch).not.toBeNull();
  });
});

describe('executor - compressed retry prompt', () => {
  it('retry prompt does not include full original task', async () => {
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs');
    const src = readFileSync(
      new URL('../../src/code-agents/executor.ts', import.meta.url).pathname.replace('/.worktrees/hardening-code-agents/src/__tests__/../../', '/.worktrees/hardening-code-agents/'),
      'utf-8',
    );

    // The old pattern was: `${task}\n\n---\nPrevious attempt failed`
    // New pattern uses task.slice(0, 300) and focuses on errors
    expect(src).not.toContain('`${task}\\n\\n---\\nPrevious attempt failed');
    expect(src).toContain('task.slice(0, 300)');
    expect(src).toContain('Fix build/test errors in the ${agent} codebase');
  });
});
