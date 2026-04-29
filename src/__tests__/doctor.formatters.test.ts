import { describe, expect, it } from 'vitest';
import { formatDoctorHuman, formatDoctorJson } from '../doctor/formatters.js';

describe('doctor formatters', () => {
  const report = {
    ok: false,
    exitCode: 1,
    startedAt: '2026-02-12T10:00:00.000Z',
    finishedAt: '2026-02-12T10:00:02.000Z',
    checks: [
      {
        name: 'node_version',
        category: 'environment',
        ok: true,
        detail: 'v20.11.0',
      },
      {
        name: 'config_json_valid',
        category: 'configuration',
        ok: false,
        detail: 'Unexpected token } in JSON at position 10',
        remedy: 'Fix ~/.skimpyclaw/config.json to valid JSON and rerun doctor.',
      },
      {
        name: 'provider_anthropic_auth',
        category: 'provider_auth',
        ok: false,
        detail: '401 Unauthorized',
        remedy: 'Check ANTHROPIC_API_KEY and provider base URL.',
      },
    ],
  } as const;

  it('formats human output with status symbols, check ids, details, and remediation', () => {
    const output = formatDoctorHuman(report as any);

    expect(output).toContain('environment');
    expect(output).toContain('configuration');
    expect(output).toContain('provider_auth');

    expect(output).toContain('✓ node_version');
    expect(output).toContain('✗ config_json_valid');
    expect(output).toContain('✗ provider_anthropic_auth');

    expect(output).toContain('Unexpected token } in JSON at position 10');
    expect(output).toContain('401 Unauthorized');
    expect(output).toContain('Fix ~/.skimpyclaw/config.json to valid JSON and rerun doctor.');
    expect(output).toContain('Check ANTHROPIC_API_KEY and provider base URL.');
  });

  it('does not print undefined when a failed check has no remedy', () => {
    const output = formatDoctorHuman({
      ...report,
      checks: [
        {
          name: 'gateway_port_available',
          category: 'runtime',
          ok: false,
          detail: 'Port 18790 already in use',
        },
      ],
    } as any);

    expect(output).toContain('gateway_port_available');
    expect(output).not.toContain('undefined');
  });

  it('formats strict JSON with no extra text', () => {
    const output = formatDoctorJson(report as any);

    expect(() => JSON.parse(output)).not.toThrow();
    expect(JSON.parse(output)).toEqual(report);
  });
});
