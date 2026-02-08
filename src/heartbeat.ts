// Heartbeat: periodic health check that alerts via Telegram when something needs attention

import type { Config, ToolConfig } from './types.js';
import { join } from 'path';
import { homedir } from 'os';
import { runAgentTurn } from './agent.js';
import { sendProactiveMessage, isSilenced } from './telegram.js';

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

  if (config.channels.telegram.defaultAllowedPaths?.length) {
    return {
      ...DEFAULT_HEARTBEAT_TOOLS,
      allowedPaths: config.channels.telegram.defaultAllowedPaths,
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

  // Run first check after a short delay (let everything else initialize)
  setTimeout(() => runHeartbeatCheck(config), 10_000);

  heartbeatTimer = setInterval(() => runHeartbeatCheck(config), intervalMs);
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
    const chatId = getChatId(config);
    const response = await runAgentTurn(
      config.agents.default,
      config.heartbeat.prompt,
      config,
      config.heartbeat.model,
      getHeartbeatTools(config),
      undefined,
      {
        channel: 'heartbeat',
        sessionId: chatId ? String(chatId) : undefined,
      }
    );

    if (response.includes('HEARTBEAT_OK')) {
      console.log('[heartbeat] OK — nothing to report');
      return response;
    }

    // Something needs attention — send to Telegram
    if (isSilenced()) {
      console.log('[heartbeat] Alert suppressed (silenced)');
      return response;
    }

    if (!chatId) {
      console.log('[heartbeat] No chat ID available, logging alert:');
      console.log(response);
      return response;
    }

    await sendProactiveMessage(chatId, `🫀 Heartbeat alert:\n\n${response}`);
    console.log('[heartbeat] Alert sent to Telegram');
    return response;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[heartbeat] Error: ${msg}`);
    throw error;
  } finally {
    running = false;
  }
}

function getChatId(config: Config): number | null {
  const allowFrom = config.channels.telegram.allowFrom;
  for (const entry of allowFrom) {
    if (typeof entry === 'number') return entry;
    const num = Number(entry);
    if (!isNaN(num)) return num;
  }
  return null;
}
