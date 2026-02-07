// SkimpyClaw - Lightweight Personal AI Assistant
// Main entry point

import { loadConfig } from './config.js';
import { startRuntime } from './service.js';

async function main(): Promise<void> {
  console.log('👙🦞 SkimpyClaw starting...');

  const config = loadConfig();
  console.log('[config] Loaded');

  const runtime = await startRuntime(config);
  console.log(`[gateway] Listening on http://127.0.0.1:${config.gateway.port}`);

  const shutdown = async (signal: string) => {
    console.log(`\n[shutdown] Received ${signal}`);
    await runtime.stop();
    console.log('👙🦞 SkimpyClaw stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  console.log('👙🦞 SkimpyClaw running');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
