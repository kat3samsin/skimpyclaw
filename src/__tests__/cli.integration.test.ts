import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';

describe('cli integration', () => {
  it('onboard --dry-run exits successfully without prompting', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'onboard', '--dry-run'],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Onboarding dry run successful');
    expect(result.stdout).toContain('Would create config under');
    expect(result.stderr).toBe('');
  });
});
