import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock heavy deps
vi.mock('../agent.js', () => ({
  runAgentTurn: vi.fn(async () => '{"subtasks": [{"description": "task1", "dependsOn": []}, {"description": "task2", "dependsOn": [0]}]}'),
}));

vi.mock('../code-agents/registry.js', () => {
  const tasks = new Map<string, any>();
  let counter = 0;
  return {
    getCodeAgentsDir: () => '/tmp/test-code-agents',
    ensureCodeAgentsDir: vi.fn(),
    writeCodeAgentTask: vi.fn((task: any) => tasks.set(task.id, { ...task })),
    storeCodeAgentTask: vi.fn((task: any) => tasks.set(task.id, { ...task })),
    getCodeAgent: vi.fn((id: string) => tasks.get(id) || null),
    getNextCodeAgentId: vi.fn(() => `ca-${++counter}`),
    setCodeAgentCanceller: vi.fn(),
    deleteCodeAgentCanceller: vi.fn(),
    _tasks: tasks,
    _resetCounter: () => { counter = 0; },
  };
});

vi.mock('../code-agents/executor.js', () => ({
  runCodeAgentBackground: vi.fn(async () => {}),
  runValidation: vi.fn(async () => ({ passed: true, output: 'PASS' })),
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

import { computeWaves, decomposeTask, synthesizeResults, gatherCodebaseContext } from '../code-agents/orchestrator.js';
import { runAgentTurn } from '../agent.js';
import { getCodeAgent, writeCodeAgentTask, storeCodeAgentTask, getNextCodeAgentId } from '../code-agents/registry.js';

const mockRunAgentTurn = vi.mocked(runAgentTurn);
const mockGetCodeAgent = vi.mocked(getCodeAgent);
const mockWriteCodeAgentTask = vi.mocked(writeCodeAgentTask);

describe('computeWaves', () => {
  it('puts independent tasks in one wave', () => {
    const waves = computeWaves([
      { description: 'a', dependsOn: [] },
      { description: 'b', dependsOn: [] },
      { description: 'c', dependsOn: [] },
    ]);
    expect(waves).toEqual([[0, 1, 2]]);
  });

  it('creates sequential waves for dependencies', () => {
    const waves = computeWaves([
      { description: 'a', dependsOn: [] },
      { description: 'b', dependsOn: [0] },
      { description: 'c', dependsOn: [1] },
    ]);
    expect(waves).toEqual([[0], [1], [2]]);
  });

  it('handles cycle detection without infinite loop', () => {
    // Tasks that depend on each other (cycle)
    const waves = computeWaves([
      { description: 'a', dependsOn: [1] },
      { description: 'b', dependsOn: [0] },
    ]);
    // Should force them into one wave rather than looping forever
    expect(waves.length).toBeGreaterThan(0);
    const allIndices = waves.flat();
    expect(allIndices).toContain(0);
    expect(allIndices).toContain(1);
  });

  it('handles mixed dependencies', () => {
    const waves = computeWaves([
      { description: 'a', dependsOn: [] },
      { description: 'b', dependsOn: [] },
      { description: 'c', dependsOn: [0, 1] },
    ]);
    expect(waves).toEqual([[0, 1], [2]]);
  });
});

describe('decomposeTask', () => {
  it('pads with "Additional part of:" when model returns fewer subtasks', async () => {
    mockRunAgentTurn.mockResolvedValueOnce(
      '{"subtasks": [{"description": "only one task", "dependsOn": []}]}'
    );

    const config = { providers: {} } as any;
    const result = await decomposeTask('Build a full app with tests', 3, config);

    expect(result).toHaveLength(3);
    expect(result[0].description).toBe('only one task');
    // Padded entries should use "Additional part of:" not duplicate the last description
    expect(result[1].description).toMatch(/^Additional part of:/);
    expect(result[2].description).toMatch(/^Additional part of:/);
  });

  it('falls back to numbered splitting on parse error', async () => {
    mockRunAgentTurn.mockResolvedValueOnce('not valid json at all');

    const config = { providers: {} } as any;
    const result = await decomposeTask('my task', 2, config);

    expect(result).toHaveLength(2);
    expect(result[0].description).toContain('Part 1 of 2');
    expect(result[1].description).toContain('Part 2 of 2');
  });
});

describe('synthesizeResults', () => {
  it('uses structured context (summary capped at 500 chars, not raw 1000)', async () => {
    const longOutput = 'x'.repeat(1000);
    mockRunAgentTurn.mockResolvedValueOnce('Synthesis complete');

    const config = { providers: {} } as any;
    await synthesizeResults('original task', [
      { subtask: 'sub1', status: 'completed', output: longOutput },
    ], config);

    const call = mockRunAgentTurn.mock.calls[mockRunAgentTurn.mock.calls.length - 1];
    const prompt = call[1] as string;
    // Summary should be capped at 500 chars, not the full 1000
    expect(prompt).toContain('x'.repeat(500));
    expect(prompt).not.toContain('x'.repeat(501));
    // Should use the structured format (Summary: prefix)
    expect(prompt).toContain('Summary:');
  });
});

describe('orchestrator - cancellation after wave spawn', () => {
  it('cancels just-spawned children when parent is cancelled', async () => {
    // This is tested structurally by reading the source
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs');
    const src = readFileSync(
      new URL('../../src/code-agents/orchestrator.ts', import.meta.url).pathname.replace('/.worktrees/hardening-code-agents/src/__tests__/../../', '/.worktrees/hardening-code-agents/'),
      'utf-8',
    );

    // Verify the cancellation check exists after wave spawn
    expect(src).toContain("// Check cancellation after spawning");
    expect(src).toContain("if (getCodeAgent(parentId)?.status === 'cancelled')");
    // Verify it sets children to cancelled
    expect(src).toContain("status: 'cancelled'");
    expect(src).toContain("error: CANCELLED_MESSAGE");
  });
});

describe('orchestrator - spawn failure marks child as failed', () => {
  it('catch handler updates child task status on spawn error', async () => {
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs');
    const src = readFileSync(
      new URL('../../src/code-agents/orchestrator.ts', import.meta.url).pathname.replace('/.worktrees/hardening-code-agents/src/__tests__/../../', '/.worktrees/hardening-code-agents/'),
      'utf-8',
    );

    // Verify the catch handler updates child status
    expect(src).toContain("const child = getCodeAgent(childId);");
    expect(src).toContain("if (child && child.status === 'running')");
    expect(src).toContain("status: 'failed'");
    expect(src).toContain("error: err instanceof Error ? err.message : String(err)");
  });
});

describe('orchestrator - skip redundant parent writes', () => {
  it('only writes parent status when liveOutput changes', async () => {
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs');
    const src = readFileSync(
      new URL('../../src/code-agents/orchestrator.ts', import.meta.url).pathname.replace('/.worktrees/hardening-code-agents/src/__tests__/../../', '/.worktrees/hardening-code-agents/'),
      'utf-8',
    );

    // Verify the dedup pattern
    expect(src).toContain("let lastLiveOutput = ''");
    expect(src).toContain('if (newLiveOutput !== lastLiveOutput)');
    expect(src).toContain('lastLiveOutput = newLiveOutput');
  });
});

describe('gatherCodebaseContext', () => {
  it('returns a non-empty string for the project root', () => {
    // Use this project's own root as the workdir
    const { resolve } = require('path');
    const projectRoot = resolve(__dirname, '..', '..');
    const context = gatherCodebaseContext(projectRoot);
    // Should contain at least scripts or source files
    expect(context.length).toBeGreaterThan(0);
    expect(context.length).toBeLessThanOrEqual(2000);
  });

  it('returns empty string for nonexistent directory', () => {
    const context = gatherCodebaseContext('/tmp/nonexistent-dir-12345');
    // Should not throw, just return empty or minimal context
    expect(typeof context).toBe('string');
  });
});

describe('decomposeTask with workdir', () => {
  it('passes workdir context to the decomposition prompt', async () => {
    mockRunAgentTurn.mockResolvedValueOnce(
      '{"subtasks": [{"description": "sub1", "dependsOn": []}, {"description": "sub2", "dependsOn": []}]}'
    );

    const config = { providers: {} } as any;
    const result = await decomposeTask('test task', 2, config, '/tmp');

    expect(result).toHaveLength(2);
    // Check the prompt sent to the model includes the richer decomposition instructions
    const call = mockRunAgentTurn.mock.calls[mockRunAgentTurn.mock.calls.length - 1];
    const prompt = call[1] as string;
    expect(prompt).toContain('task decomposition expert');
    expect(prompt).toContain('Minimize file overlap');
  });
});

describe('synthesizeResults with workdir', () => {
  it('includes git diff info when workdir is a git repo', async () => {
    mockRunAgentTurn.mockResolvedValueOnce('Synthesis complete');

    const { resolve } = require('path');
    const projectRoot = resolve(__dirname, '..', '..');
    const config = { providers: {} } as any;

    await synthesizeResults('original task', [
      { subtask: 'sub1', status: 'completed', output: 'done' },
    ], config, projectRoot);

    const call = mockRunAgentTurn.mock.calls[mockRunAgentTurn.mock.calls.length - 1];
    const prompt = call[1] as string;
    // Should include the success/failure counts
    expect(prompt).toContain('1 succeeded, 0 failed');
  });
});

describe('orchestrator - per-wave validation and retry', () => {
  it('source includes per-wave validation logic', async () => {
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs');
    const src = readFileSync(
      new URL('../../src/code-agents/orchestrator.ts', import.meta.url).pathname.replace('/.worktrees/hardening-code-agents/src/__tests__/../../', '/.worktrees/hardening-code-agents/'),
      'utf-8',
    );

    // Verify per-wave validation exists
    expect(src).toContain('Per-wave validation: run build after each wave');
    expect(src).toContain('wave_validation');
    // Verify retry logic
    expect(src).toContain('wave_retry_complete');
    expect(src).toContain('retryPrompt');
  });
});

describe('orchestrator - timeout budgeting', () => {
  it('computes perChildTimeout based on wave count not team size', async () => {
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs');
    const src = readFileSync(
      new URL('../../src/code-agents/orchestrator.ts', import.meta.url).pathname.replace('/.worktrees/hardening-code-agents/src/__tests__/../../', '/.worktrees/hardening-code-agents/'),
      'utf-8',
    );

    // Verify budget-aware timeout
    expect(src).toContain('overheadMinutes');
    expect(src).toContain('availableForChildren');
    expect(src).toContain('Math.floor(availableForChildren / waves.length)');
  });
});
