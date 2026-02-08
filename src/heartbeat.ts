// Heartbeat: periodic health check that alerts via the active chat channel when needed

import type { Config, ToolConfig } from './types.js';
import { join } from 'path';
import { homedir } from 'os';
import { runAgentTurn } from './agent.js';
import {
  getActiveChannelId,
  isActiveChannelSilenced,
  sendActiveChannelProactiveMessage,
} from './channels.js';

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

const DEFAULT_HEARTBEAT_TOOLS: ToolConfig = {
  enabled: true,
  allowedPaths: [join(homedir(), '.skimpyclaw'), process.cwd()],
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
  if (running) {
    console.log('[heartbeat] Skipping — previous check still running');
    return 'Skipped — previous check still running';
  }

  running = true;
  try {
    console.log('[heartbeat] Running check...');
    const response = await runAgentTurn(
      config.agents.default,
      config.heartbeat.prompt,
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
