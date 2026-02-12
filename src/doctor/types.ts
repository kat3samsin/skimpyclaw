export type DoctorCategory =
  | 'environment'
  | 'configuration'
  | 'provider_auth'
  | 'channels'
  | 'runtime';

export interface DoctorCheckResult {
  name: string;
  category: DoctorCategory;
  ok: boolean;
  detail: string;
  remedy?: string;
  fatal?: boolean;
}

export interface DoctorReport {
  ok: boolean;
  exitCode: 0 | 1 | 2;
  startedAt: string;
  finishedAt: string;
  checks: DoctorCheckResult[];
}

export interface DoctorRunResult {
  report: DoctorReport;
  exitCode: 0 | 1 | 2;
}
