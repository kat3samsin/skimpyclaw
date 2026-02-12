import { formatDoctorHuman, formatDoctorJson } from './formatters.js';
import { runDoctor as runDoctorChecks } from './runner.js';

export interface RunDoctorOptions {
  json?: boolean;
}

export interface RunDoctorCommandResult {
  output: string;
  exitCode: 0 | 1 | 2;
}

export async function runDoctor(options: RunDoctorOptions = {}): Promise<RunDoctorCommandResult> {
  const { report, exitCode } = await runDoctorChecks();
  const output = options.json ? formatDoctorJson(report) : formatDoctorHuman(report);
  return { output, exitCode };
}
