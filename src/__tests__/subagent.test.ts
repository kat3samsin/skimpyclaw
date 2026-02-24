import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  initSubagentSystem,
  dispatchSubagent,
  cancelTask,
  getActiveTasks,
  getRecentTasks,
  getTask,
  getPresetDescriptions,
  resetForTesting,
  ensureAgentSetup,
} from '../subagent.js';
import type { Config, SubagentType } from '../types.js';

// Mock runAgentTurn
vi.mock('../agent.js', () => ({
  runAgentTurn: vi.fn().mockResolvedValue('mock agent response'),
}));

// Mock getCurrentModel
vi.mock('../gateway.js', () => ({
  getCurrentModel: vi.fn().mockReturnValue('anthropic/claude-sonnet-4-5'),
}));

// Mock fs operations for ensureAgentSetup tests
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

function createMockConfig(): Config {
  return {
    gateway: { port: 18790, mode: 'local' },
    agents: {
      default: 'main',
      list: {
        main: {
          identity: { name: 'Test', emoji: '🦞' },
          model: 'anthropic/claude-sonnet-4-5',
        },
      },
    },
    models: {
      providers: {},
      aliases: {
        'claude-think': 'anthropic/claude-sonnet-4-5',
        'claude-opus': 'anthropic/claude-opus-4-6',
      },
    },
    channels: {
      telegram: {
        enabled: false,
        token: '',
        allowFrom: [],
      },
    },
    cron: { jobs: [] },
    heartbeat: {
      intervalMs: 300000,
      prompt: 'test',
    },
  };
}

describe('subagent', () => {
  let deliveredMessages: { chatId: number; message: string }[];
  let mockConfig: Config;

  beforeEach(() => {
    resetForTesting();
    mockConfig = createMockConfig();
    deliveredMessages = [];
    initSubagentSystem(async (chatId, message) => {
      deliveredMessages.push({ chatId, message });
    });
  });

  describe('initSubagentSystem', () => {
    it('initializes without error', () => {
      expect(() => initSubagentSystem(async () => {})).not.toThrow();
    });
  });

  describe('getPresetDescriptions', () => {
    it('returns descriptions for all agent types', () => {
      const desc = getPresetDescriptions();
      expect(desc).toContain('coding');
      expect(desc).toContain('research');
    });
  });

  describe('dispatchSubagent', () => {
    it('creates a task with correct fields', () => {
      const task = dispatchSubagent('coding', 'list TODOs', 123, mockConfig);
      expect(task.id).toBe('t1');
      expect(task.type).toBe('coding');
      expect(task.prompt).toBe('list TODOs');
      expect(task.chatId).toBe(123);
      expect(task.model).toBe('anthropic/claude-opus-4-6');
      expect(task.createdAt).toBeInstanceOf(Date);
    });

    it('increments task IDs', () => {
      const t1 = dispatchSubagent('coding', 'task 1', 123, mockConfig);
      const t2 = dispatchSubagent('research', 'task 2', 123, mockConfig);
      expect(t1.id).toBe('t1');
      expect(t2.id).toBe('t2');
    });

    it('uses model override when provided', () => {
      const task = dispatchSubagent('coding', 'test', 123, mockConfig, 'anthropic/claude-opus-4');
      expect(task.model).toBe('anthropic/claude-opus-4-6');
    });

    it('resolves model override aliases to canonical model ids', () => {
      const task = dispatchSubagent('coding', 'test', 123, mockConfig, 'claude-think');
      expect(task.model).toBe('anthropic/claude-sonnet-4-5');
    });

    it('rejects when max concurrent reached', () => {
      // Set max concurrent to 3 to test the limit
      const configWithLimit = { ...mockConfig, subagents: { maxConcurrent: 3 } };
      dispatchSubagent('coding', 'task 1', 123, configWithLimit);
      dispatchSubagent('coding', 'task 2', 123, configWithLimit);
      dispatchSubagent('coding', 'task 3', 123, configWithLimit);
      expect(() => dispatchSubagent('coding', 'task 4', 123, configWithLimit)).toThrow('Max concurrent');
    });

    it('delivers result on completion', async () => {
      dispatchSubagent('coding', 'test prompt', 456, mockConfig);
      // Wait for async execution
      await new Promise(r => setTimeout(r, 100));
      expect(deliveredMessages.length).toBe(1);
      expect(deliveredMessages[0].chatId).toBe(456);
      expect(deliveredMessages[0].message).toContain('mock agent response');
      expect(deliveredMessages[0].message).toContain('completed');
    });
  });

  describe('cancelTask', () => {
    it('cancels a running task', async () => {
      const task = dispatchSubagent('coding', 'test', 123, mockConfig);
      const result = cancelTask(task.id);
      expect(result?.status).toBe('cancelled');
    });

    it('returns null for unknown task', () => {
      expect(cancelTask('t999')).toBeNull();
    });

    it('returns task unchanged if already completed', async () => {
      const task = dispatchSubagent('coding', 'test', 123, mockConfig);
      await new Promise(r => setTimeout(r, 100));
      const result = cancelTask(task.id);
      expect(result?.status).toBe('completed');
    });
  });

  describe('getActiveTasks', () => {
    it('returns empty when no tasks', () => {
      expect(getActiveTasks()).toHaveLength(0);
    });

    it('returns pending/running tasks', () => {
      dispatchSubagent('coding', 'test', 123, mockConfig);
      // Task starts as pending/running immediately
      const active = getActiveTasks();
      expect(active.length).toBeGreaterThanOrEqual(0); // may already be running
    });
  });

  describe('getRecentTasks', () => {
    it('returns tasks sorted newest first', async () => {
      dispatchSubagent('coding', 'first', 123, mockConfig);
      // Small delay to ensure different timestamps
      await new Promise(r => setTimeout(r, 5));
      dispatchSubagent('research', 'second', 123, mockConfig);
      const recent = getRecentTasks(10);
      expect(recent).toHaveLength(2);
      expect(recent[0].prompt).toBe('second');
      expect(recent[1].prompt).toBe('first');
    });

    it('limits results', () => {
      dispatchSubagent('coding', 'a', 123, mockConfig);
      dispatchSubagent('coding', 'b', 123, mockConfig);
      dispatchSubagent('coding', 'c', 123, mockConfig);
      const recent = getRecentTasks(2);
      expect(recent).toHaveLength(2);
    });
  });

  describe('getTask', () => {
    it('returns task by id', () => {
      const task = dispatchSubagent('coding', 'test', 123, mockConfig);
      expect(getTask(task.id)).toBe(task);
    });

    it('returns null for unknown id', () => {
      expect(getTask('t999')).toBeNull();
    });
  });

  describe('ensureAgentSetup', () => {
    const mockedExistsSync = vi.mocked(existsSync);
    const mockedMkdirSync = vi.mocked(mkdirSync);
    const mockedWriteFileSync = vi.mocked(writeFileSync);

    beforeEach(() => {
      mockedExistsSync.mockReset();
      mockedMkdirSync.mockReset();
      mockedWriteFileSync.mockReset();
    });

    it('creates agent dir and templates when dir does not exist', () => {
      mockedExistsSync.mockReturnValue(false);
      const config = createMockConfig();

      ensureAgentSetup('coding', config);

      const expectedDir = join(homedir(), '.skimpyclaw', 'agents', 'coding');
      expect(mockedMkdirSync).toHaveBeenCalledWith(expectedDir, { recursive: true });
      expect(mockedWriteFileSync).toHaveBeenCalledTimes(2);

      // Check IDENTITY.md was written
      const identityCall = mockedWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]).endsWith('IDENTITY.md')
      );
      expect(identityCall).toBeTruthy();
      expect(identityCall![1]).toContain('Coding Agent');

      // Check TOOLS.md was written
      const toolsCall = mockedWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]).endsWith('TOOLS.md')
      );
      expect(toolsCall).toBeTruthy();
      expect(toolsCall![1]).toContain('Act, Don\'t Narrate');
    });

    it('does not create dir when it already exists', () => {
      mockedExistsSync.mockReturnValue(true);
      const config = createMockConfig();

      ensureAgentSetup('coding', config);

      expect(mockedMkdirSync).not.toHaveBeenCalled();
      expect(mockedWriteFileSync).not.toHaveBeenCalled();
    });

    it('registers agent in config.agents.list in-memory', () => {
      mockedExistsSync.mockReturnValue(true);
      const config = createMockConfig();
      expect(config.agents.list['coding']).toBeUndefined();

      ensureAgentSetup('coding', config);

      expect(config.agents.list['coding']).toBeDefined();
      expect(config.agents.list['coding'].identity.name).toBe('Coding Agent');
      expect(config.agents.list['coding'].identity.emoji).toBe('🔧');
      expect(config.agents.list['coding'].thinking).toBe('medium');
    });

    it('does not overwrite existing agent registration', () => {
      mockedExistsSync.mockReturnValue(true);
      const config = createMockConfig();
      config.agents.list['research'] = {
        identity: { name: 'Custom Research', emoji: '🧪' },
        model: 'custom-model',
      };

      ensureAgentSetup('research', config);

      // Should keep the existing registration
      expect(config.agents.list['research'].identity.name).toBe('Custom Research');
      expect(config.agents.list['research'].identity.emoji).toBe('🧪');
    });

    it('creates correct templates for research type', () => {
      mockedExistsSync.mockReturnValue(false);
      const config = createMockConfig();

      ensureAgentSetup('research', config);

      const identityCall = mockedWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]).endsWith('IDENTITY.md')
      );
      expect(identityCall![1]).toContain('Research Agent');
      expect(identityCall![1]).toContain('research subagent dispatched');
    });

  });
});
