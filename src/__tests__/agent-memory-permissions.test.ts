import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  appendFileSync: vi.fn(),
  chmodSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs')>(),
  ...fsMocks,
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config.js')>(),
  getAgentDir: (agentId: string) => `/private-home/.skimpyclaw/agents/${agentId}`,
}));

import { appendToMemory } from '../agent.js';

describe('agent memory permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.existsSync.mockReturnValue(false);
  });

  it('creates and corrects owner-only memory storage', () => {
    appendToMemory('main', 'private memory');

    const dir = '/private-home/.skimpyclaw/agents/main/memory/logs';
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith(dir, { recursive: true, mode: 0o700 });
    expect(fsMocks.chmodSync).toHaveBeenCalledWith(dir, 0o700);
    expect(fsMocks.appendFileSync).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${dir}/\\d{4}-\\d{2}-\\d{2}\\.md$`)),
      expect.stringContaining('private memory'),
      { encoding: 'utf-8', mode: 0o600 },
    );
    expect(fsMocks.chmodSync).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${dir}/\\d{4}-\\d{2}-\\d{2}\\.md$`)),
      0o600,
    );
  });
});
