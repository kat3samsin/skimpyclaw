import { execSync } from 'child_process';

const MAX_DIFF_BYTES = 10 * 1024 * 1024;

export function getHeadSha(workdir: string): string | null {
  try {
    const out = execSync('git rev-parse HEAD', { cwd: workdir, encoding: 'buffer' });
    return out.toString('utf-8').trim();
  } catch {
    return null;
  }
}

export function getChangedFiles(workdir: string, fromRef: string, toRef: string): string[] {
  try {
    const out = execSync(`git diff --name-only ${fromRef}..${toRef}`, { cwd: workdir, encoding: 'buffer' });
    const text = out.toString('utf-8').trim();
    if (!text) return [];
    return text.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function getReviewDiff(workdir: string, fromRef: string, toRef: string): string | null {
  try {
    const out = execSync(`git diff ${fromRef}..${toRef}`, { cwd: workdir, encoding: 'buffer', maxBuffer: MAX_DIFF_BYTES });
    return out.toString('utf-8');
  } catch {
    return null;
  }
}
