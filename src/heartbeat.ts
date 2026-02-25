/*
 * Heartbeat module — periodically pings the AI agent to confirm the service
 * is alive and responsive. Sends alerts via the active Telegram channel if
 * the agent fails to reply with the expected HEARTBEAT_OK response.
 */

import type { Config, ToolConfig } from './types.js';
import { join } from 'path';
import { homedir } from 'os';
import { runAgentTurn } from './agent.js';
import { pruneIdle, SANDBOX_DEFAULTS } from './sandbox/index.js';
import {
  getActiveChannelId,
  isActiveChannelSilenced,
  sendActiveChannelProactiveMessage,
} from './channels.js';

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

const DEFAULT_HEARTBEAT_TOOLS: ToolConfig = {
  enabled: true,
  allowedPaths: [join(homedir(), '.skimpyclaw')],
  maxIterations: 100,
  bashTimeout: 15000,
};

function getHeartbeatTools(config: Config): ToolConfig {
  if (config.heartbeat.tools) {
    return config.heartbeat.tools;
  }

  const defaultAllowedPaths = config.channels.active === 'discord'
    ? config.channels.discord?.defaultAllowedPaths
    : config.channels.telegram.defaultAllowedPaths || config.channels.discord?.defaultAllowedPaths;

  if (defaultAllowedPaths?.length) {
    return {
      ...DEFAULT_HEARTBEAT_TOOLS,
      allowedPaths: defaultAllowedPaths,
    };
  }

  return DEFAULT_HEARTBEAT_TOOLS;
}

function getHeartbeatFilePath(config: Config): string {
  return join(homedir(), '.skimpyclaw', 'agents', config.agents.default, 'HEARTBEAT.md');
}

function getHeartbeatPrompt(config: Config): string {
  const heartbeatPath = getHeartbeatFilePath(config);
  const basePrompt = config.heartbeat.prompt || '';

  // Normalize any explicit HEARTBEAT.md path token (legacy /workspace, /Users/*, ~/...)
  // to the active agent heartbeat template path.
  const normalized = basePrompt.replace(/(?:~|\/)\S*HEARTBEAT\.md/g, heartbeatPath);

  if (normalized.includes('HEARTBEAT.md')) {
    return normalized;
  }

  if (normalized.trim().length === 0) {
    return `Read ${heartbeatPath}. Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.`;
  }

  return `Read ${heartbeatPath}. Follow it strictly.\n\n${normalized}`;
}

export function initHeartbeat(config: Config): void {
  const { heartbeat } = config;
  if (!heartbeat?.prompt || !heartbeat?.intervalMs) {
    console.log('[heartbeat] Disabled (no prompt or interval configured)');
    return;
  }

  const intervalMs = heartbeat.intervalMs;
  console.log(`[heartbeat] Started (interval: ${Math.round(intervalMs / 60000)}min)`);

  // Run first check after a short delay (let everything else initialize).
  // Never let async heartbeat failures bubble out of timer callbacks.
  setTimeout(() => {
    void runHeartbeatCheck(config).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[heartbeat] Initial check failed: ${msg}`);
    });
  }, 10_000);

  heartbeatTimer = setInterval(() => {
    void runHeartbeatCheck(config).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[heartbeat] Scheduled check failed: ${msg}`);
    });
  }, intervalMs);
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    console.log('[heartbeat] Stopped');
  }
}

export async function runHeartbeatCheck(config: Config): Promise<string> {
  // Prune idle sandbox containers
  pruneIdle(config.sandbox?.idleTimeoutMs ?? SANDBOX_DEFAULTS.idleTimeoutMs ?? 3_600_000).catch(() => {});

  if (running) {
    console.log('[heartbeat] Skipping — previous check still running');
    return 'Skipped — previous check still running';
  }

  running = true;
  try {
    console.log('[heartbeat] Running check...');
    const response = await runAgentTurn(
      config.agents.default,
      getHeartbeatPrompt(config),
      config,
      config.heartbeat.model,
      getHeartbeatTools(config),
      undefined,
      {
        channel: 'heartbeat',
        sessionId: undefined,
      }
    );

    if (response.includes('HEARTBEAT_OK')) {
      console.log('[heartbeat] OK — nothing to report');
      return response;
    }

    // Something needs attention — send to active channel
    if (isActiveChannelSilenced()) {
      console.log('[heartbeat] Alert suppressed (silenced)');
      return response;
    }

    const sent = await sendActiveChannelProactiveMessage(config, `🫀 Heartbeat alert:\n\n${response}`);
    if (!sent) {
      console.log('[heartbeat] No proactive target available, logging alert:');
      console.log(response);
      return response;
    }

    console.log(`[heartbeat] Alert sent to ${getActiveChannelId() || 'active channel'}`);
    return response;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[heartbeat] Error: ${msg}`);
    throw error;
  } finally {
    running = false;
  }
}
