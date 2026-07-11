import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeBash } from '../tools/bash-tool.js';
import {
  approveRequest,
  clearApprovalListeners,
  clearApprovals,
  listApprovals,
} from '../exec-approval.js';
import type { ToolConfig } from '../types.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skimpyclaw-bash-cancel-'));
  clearApprovals();
  clearApprovalListeners();
});

afterEach(() => {
  clearApprovalListeners();
  clearApprovals();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Bash tool cancellation', () => {
  it('terminates the process group and waits for close', async () => {
    const controller = new AbortController();
    const config = {
      enabled: true,
      allowedPaths: [tempDir],
      bashTimeout: 5_000,
      execApproval: { enabled: false },
    } as ToolConfig;
    const outputPath = join(tempDir, 'late.txt');
    const command = `node -e "setTimeout(() => require('fs').writeFileSync('late.txt', 'late'), 300)"`;

    const run = executeBash(command, tempDir, config, { abortSignal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 30));
    controller.abort();

    await expect(run).resolves.toContain('cancelled');
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(existsSync(outputPath)).toBe(false);
  });

  it('keeps the SIGKILL fallback alive for descendants that ignore SIGTERM', async () => {
    const controller = new AbortController();
    const config = {
      enabled: true,
      allowedPaths: [tempDir],
      bashTimeout: 5_000,
      execApproval: { enabled: false },
    } as ToolConfig;
    const childScript = join(tempDir, 'resistant-child.cjs');
    const parentScript = join(tempDir, 'parent.cjs');
    const readyPath = join(tempDir, 'ready.txt');
    const latePath = join(tempDir, 'orphan.txt');
    writeFileSync(childScript, [
      "const fs = require('fs');",
      "process.on('SIGTERM', () => {});",
      "fs.writeFileSync('ready.txt', 'ready');",
      "setTimeout(() => fs.writeFileSync('orphan.txt', 'late'), 1500);",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    writeFileSync(parentScript, [
      "const { spawn } = require('child_process');",
      `spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1000);',
    ].join('\n'));

    const run = executeBash(`node ${parentScript}`, tempDir, config, {
      abortSignal: controller.signal,
    });
    await vi.waitFor(() => expect(existsSync(readyPath)).toBe(true));
    const abortedAt = Date.now();
    controller.abort();

    await expect(run).resolves.toContain('cancelled');
    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(800);
    expect(existsSync(latePath)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(existsSync(latePath)).toBe(false);
  });

  it('denies a pending approval so a late approval cannot start the command', async () => {
    const controller = new AbortController();
    const config = {
      enabled: true,
      allowedPaths: [tempDir],
      execApproval: { enabled: true, requireForTiers: [3], ttlMs: 10_000 },
    } as ToolConfig;
    const outputPath = join(tempDir, 'late-approval.txt');
    const command = `node -e "require('fs').writeFileSync('late-approval.txt', 'late')"`;
    const run = executeBash(command, tempDir, config, {
      abortSignal: controller.signal,
      channel: 'discord',
      channelTargetId: 'channel-1',
      approverUserId: 'user-1',
    });

    await vi.waitFor(() => expect(listApprovals()).toHaveLength(1));
    const approval = listApprovals()[0];
    controller.abort();

    await expect(run).resolves.toContain('cancelled');
    expect(listApprovals({ includeResolved: true })[0].status).toBe('denied');
    expect(approveRequest(approval.id, 'late-user')).toBe(false);
    expect(existsSync(outputPath)).toBe(false);
  });
});
