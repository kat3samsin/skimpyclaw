import type { DoctorCategory, DoctorReport } from './types.js';

const CATEGORY_ORDER: DoctorCategory[] = [
  'environment',
  'configuration',
  'provider_auth',
  'channels',
  'runtime',
];

function groupChecks(report: DoctorReport) {
  const groups = new Map<DoctorCategory, DoctorReport['checks']>();
  for (const category of CATEGORY_ORDER) {
    groups.set(category, []);
  }

  for (const check of report.checks) {
    const group = groups.get(check.category) || [];
    group.push(check);
    groups.set(check.category, group);
  }

  return groups;
}

export function formatDoctorHuman(report: DoctorReport): string {
  const lines: string[] = [];
  const groups = groupChecks(report);

  for (const category of CATEGORY_ORDER) {
    const checks = groups.get(category) || [];
    if (checks.length === 0) continue;

    lines.push(category);

    for (const check of checks) {
      const symbol = check.ok ? '✓' : '✗';
      lines.push(`${symbol} ${check.name}: ${check.detail}`);
      if (!check.ok && check.remedy) {
        lines.push(`  → ${check.remedy}`);
      }
    }

    lines.push('');
  }

  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}

export function formatDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}
