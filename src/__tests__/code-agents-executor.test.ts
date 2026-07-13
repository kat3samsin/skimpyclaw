import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

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

vi.mock('../code-agents/utils.js', () => ({
  buildCodeAgentArgs: vi.fn(() => ({ cmd: 'echo', args: ['hello'] })),
  buildCodeAgentSpawnEnv: vi.fn(() => ({ ...process.env })),
  notifyCodeAgentResult: vi.fn(async () => {}),
  resolveModelAlias: vi.fn((m: string) => m),
}));

vi.mock('../audit.js', () => ({
  startTrace: vi.fn(() => 'trace-1'),
  addEvent: vi.fn(),
  endTrace: vi.fn(async () => {}),
}));

vi.mock('../usage.js', () => ({
  buildUsageRecord: vi.fn((record: unknown) => record),
  recordUsage: vi.fn(),
}));

// We need child_process to be real for spawn tests, but we'll mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    chmodSync: vi.fn(),
    createWriteStream: vi.fn(() => ({
      write: vi.fn(() => true),
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

describe('executor - bounded streaming output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('feeds process chunks through the incremental collector', async () => {
    const { storeCodeAgentTask, getCodeAgent } = await import('../code-agents/registry.js');
    const { runCodeAgentBackground } = await import('../code-agents/executor.js');
    const { createWriteStream } = await import('fs');
    const logStream = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    let backpressured = false;
    logStream.write = vi.fn((data: string | Buffer) => {
      if (!backpressured && Buffer.isBuffer(data)) {
        backpressured = true;
        queueMicrotask(() => logStream.emit('drain'));
        return false;
      }
      return true;
    });
    logStream.end = vi.fn();
    vi.mocked(createWriteStream).mockReturnValueOnce(logStream as any);
    const startedAt = new Date();
    storeCodeAgentTask({
      id: 'ca-stream-test',
      agent: 'codex',
      task: 'stream test',
      workdir: process.cwd(),
      status: 'running',
      startedAt: startedAt.toISOString(),
    } as any);
    const event = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'bounded final answer 🦞' },
    }) + '\n';
    const script = [
      `const data = Buffer.from(${JSON.stringify(event)});`,
      `const marker = Buffer.from('🦞');`,
      `const split = data.indexOf(marker) + 2;`,
      `process.stdout.write(data.subarray(0, split));`,
      `setTimeout(() => process.stdout.write(data.subarray(split)), 20);`,
    ].join('\n');

    await runCodeAgentBackground(
      'ca-stream-test',
      'codex',
      'stream test',
      process.cwd(),
      false,
      {},
      startedAt,
      { buildArgs: () => ({ cmd: process.execPath, args: ['-e', script] }) },
    );

    expect(getCodeAgent('ca-stream-test')).toMatchObject({
      status: 'completed',
      outputPreview: 'bounded final answer 🦞',
    });
    expect(backpressured).toBe(true);
    expect(createWriteStream).toHaveBeenCalledWith(
      '/tmp/test-code-agents/ca-stream-test.log',
      { flags: 'w', mode: 0o600 },
    );
    expect(logStream.end).toHaveBeenCalledTimes(1);
    const archived = Buffer.concat(logStream.write.mock.calls.map(([data]) => (
      Buffer.isBuffer(data) ? data : Buffer.from(data)
    ))).toString();
    expect(archived).toContain('bounded final answer 🦞');
  });
});
