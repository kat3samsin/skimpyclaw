import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRunnerRunDoctor,
  mockFormatDoctorHuman,
  mockFormatDoctorJson,
} = vi.hoisted(() => ({
  mockRunnerRunDoctor: vi.fn(),
  mockFormatDoctorHuman: vi.fn(),
  mockFormatDoctorJson: vi.fn(),
}));

vi.mock('../doctor/runner.js', () => ({
  runDoctor: mockRunnerRunDoctor,
}));

vi.mock('../doctor/formatters.js', () => ({
  formatDoctorHuman: mockFormatDoctorHuman,
  formatDoctorJson: mockFormatDoctorJson,
}));

import { runDoctor } from '../doctor/index.js';

describe('doctor index integration', () => {
  const report = {
    ok: false,
    exitCode: 1,
    startedAt: '2026-02-12T10:00:00.000Z',
    finishedAt: '2026-02-12T10:00:02.000Z',
    checks: [
      { name: 'node_version', category: 'environment', ok: true, detail: 'v20.11.0' },
      { name: 'provider_openai_auth', category: 'provider_auth', ok: false, detail: '401 Unauthorized' },
    ],
  };

  beforeEach(() => {
    mockRunnerRunDoctor.mockReset();
    mockFormatDoctorHuman.mockReset();
    mockFormatDoctorJson.mockReset();

    mockRunnerRunDoctor.mockResolvedValue({ report, exitCode: report.exitCode });
    mockFormatDoctorHuman.mockReturnValue('HUMAN OUTPUT');
    mockFormatDoctorJson.mockReturnValue('{"ok":false}');
  });

  it('uses human formatter by default', async () => {
    const result = await runDoctor({ json: false });

    expect(mockRunnerRunDoctor).toHaveBeenCalledTimes(1);
    expect(mockFormatDoctorHuman).toHaveBeenCalledWith(report);
    expect(mockFormatDoctorJson).not.toHaveBeenCalled();
    expect(result).toEqual({ output: 'HUMAN OUTPUT', exitCode: 1 });
  });

  it('uses JSON formatter when --json mode is requested', async () => {
    const result = await runDoctor({ json: true });

    expect(mockRunnerRunDoctor).toHaveBeenCalledTimes(1);
    expect(mockFormatDoctorJson).toHaveBeenCalledWith(report);
    expect(mockFormatDoctorHuman).not.toHaveBeenCalled();
    expect(result).toEqual({ output: '{"ok":false}', exitCode: 1 });
  });
});
