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

vi.mock('os', () => ({ homedir: () => '/private-home' }));

import { writeAuditTrace } from '../audit.js';

describe('audit storage permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.existsSync.mockReturnValue(false);
  });

  it('creates and corrects owner-only audit storage', async () => {
    await writeAuditTrace({
      traceId: 'trace-1',
      trigger: 'api',
      status: 'ok',
      startedAt: '2026-07-11T12:00:00.000Z',
      endedAt: '2026-07-11T12:00:01.000Z',
      durationMs: 1_000,
      events: [],
    });

    const dir = '/private-home/.skimpyclaw/logs/audit';
    const file = `${dir}/2026-07-11.jsonl`;
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith(dir, { recursive: true, mode: 0o700 });
    expect(fsMocks.chmodSync).toHaveBeenCalledWith(dir, 0o700);
    expect(fsMocks.appendFileSync).toHaveBeenCalledWith(
      file,
      expect.any(String),
      { encoding: 'utf-8', mode: 0o600 },
    );
    expect(fsMocks.chmodSync).toHaveBeenCalledWith(file, 0o600);
  });
});
