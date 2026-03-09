import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolConfig } from '../types.js';

const PRECHECK_ERROR = 'Error: No supported coding CLI found on PATH. Install Codex CLI (`codex`), Claude Code CLI (`claude` or `claude-code`), or Kimi CLI (`kimi`).';

const toolConfig: ToolConfig = {
  enabled: true,
  allowedPaths: [process.cwd()],
  maxIterations: 5,
  bashTimeout: 5000,
};

async function loadSubject(preflightError: string | null) {
  vi.resetModules();

  const runCodeAgentBackground = vi.fn().mockResolvedValue(undefined);
  const runTeamOrchestrator = vi.fn().mockResolvedValue(undefined);

  vi.doMock('../code-agents/utils.js', async () => {
    const actual = await vi.importActual<typeof import('../code-agents/utils.js')>('../code-agents/utils.js');
    return {
      ...actual,
      getCodingCliPreflightError: () => preflightError,
    };
  });

  vi.doMock('../code-agents/executor.js', () => ({
    runCodeAgentBackground,
    runValidation: vi.fn(),
    buildValidationCommand: vi.fn(() => 'pnpm build && pnpm test'),
  }));

  vi.doMock('../code-agents/orchestrator.js', () => ({
    runTeamOrchestrator,
    computeWaves: vi.fn(),
    decomposeTask: vi.fn(),
    synthesizeResults: vi.fn(),
    gatherCodebaseContext: vi.fn(),
  }));

  vi.doMock('../code-agents/registry.js', () => ({
    getNextCodeAgentId: vi.fn(() => 'ca_test_1'),
    storeCodeAgentTask: vi.fn(),
    writeCodeAgentTask: vi.fn(),
    getActiveCodeAgents: vi.fn(() => []),
    getRecentCodeAgents: vi.fn(() => []),
    getAllCodeAgents: vi.fn(() => []),
    getCodeAgent: vi.fn(() => null),
    cancelCodeAgent: vi.fn(),
    restoreCodeAgentTasks: vi.fn(),
    getCodeAgentsDir: vi.fn(() => process.cwd()),
  }));

  const subject = await import('../code-agents/index.js');
  return { ...subject, runCodeAgentBackground, runTeamOrchestrator };
}

afterEach(() => {
  vi.doUnmock('../code-agents/utils.js');
  vi.doUnmock('../code-agents/executor.js');
  vi.doUnmock('../code-agents/orchestrator.js');
  vi.doUnmock('../code-agents/registry.js');
  vi.clearAllMocks();
  vi.resetModules();
});

describe('coding CLI preflight guard', { timeout: 15000 }, () => {
  it('fails code_with_agent before spawning when no supported CLI is available', async () => {
    const { executeCodeWithAgent, runCodeAgentBackground } = await loadSubject(PRECHECK_ERROR);
    const result = await executeCodeWithAgent({ task: 'Fix bug', workdir: process.cwd() }, toolConfig, {
      fullConfig: { codeAgents: { maxConcurrent: 99 } } as any,
    } as any);

    expect(result).toBe(PRECHECK_ERROR);
    expect(runCodeAgentBackground).not.toHaveBeenCalled();
  });

  it('fails code_with_team before spawning when no supported CLI is available', async () => {
    const { executeCodeWithTeam, runTeamOrchestrator } = await loadSubject(PRECHECK_ERROR);
    const result = await executeCodeWithTeam({ task: 'Refactor auth', workdir: process.cwd() }, toolConfig, {
      fullConfig: { codeAgents: { maxConcurrent: 99 } } as any,
    } as any);

    expect(result).toBe(PRECHECK_ERROR);
    expect(runTeamOrchestrator).not.toHaveBeenCalled();
  });

  it('allows code_with_agent when at least one supported CLI exists', async () => {
    const { executeCodeWithAgent, runCodeAgentBackground } = await loadSubject(null);
    const result = await executeCodeWithAgent({ task: 'Fix bug', workdir: process.cwd() }, toolConfig, {
      fullConfig: { codeAgents: { maxConcurrent: 99 } } as any,
    } as any);

    expect(result).toContain('Started coding agent');
    expect(runCodeAgentBackground).toHaveBeenCalledTimes(1);
  });

  it('allows code_with_team when at least one supported CLI exists', async () => {
    const { executeCodeWithTeam, runTeamOrchestrator } = await loadSubject(null);
    const result = await executeCodeWithTeam({ task: 'Refactor auth', workdir: process.cwd() }, toolConfig, {
      fullConfig: { codeAgents: { maxConcurrent: 99 } } as any,
    } as any);

    expect(result).toContain('Started coding team');
    expect(runTeamOrchestrator).toHaveBeenCalledTimes(1);
  });
});
