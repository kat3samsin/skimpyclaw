// SkimpyClaw - Lightweight Personal AI Assistant
// Main entry point

import { loadConfig } from './config.js';
import { createGateway } from './gateway.js';
import { initCron, stopCron } from './cron.js';
import { initHeartbeat, stopHeartbeat } from './heartbeat.js';
import { initTelegram, startTelegram, stopTelegram } from './telegram.js';
import { initProviders } from './agent.js';

async function main(): Promise<void> {
  console.log('👙🦞 SkimpyClaw starting...');

  // Load configuration
  const config = loadConfig();
  console.log('[config] Loaded');

  // Initialize model providers
  initProviders(config);
  console.log('[providers] Initialized');

  // Create and start gateway server
  const gateway = await createGateway(config);
  await gateway.listen({ port: config.gateway.port, host: '127.0.0.1' });
  console.log(`[gateway] Listening on http://127.0.0.1:${config.gateway.port}`);

  // Initialize cron scheduler
  initCron(config);

  // Initialize heartbeat
  initHeartbeat(config);

  // Initialize and start Telegram bot
  const telegramBot = await initTelegram(config);
  if (telegramBot) {
    await startTelegram();
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[shutdown] Received ${signal}`);
    stopCron();
    stopHeartbeat();
    await stopTelegram();
    await gateway.close();
    console.log('👙🦞 SkimpyClaw stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log('👙🦞 SkimpyClaw running');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
