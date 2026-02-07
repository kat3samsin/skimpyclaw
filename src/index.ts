// SkimpyClaw - Lightweight Personal AI Assistant
// Main entry point

import { createWriteStream, mkdirSync, existsSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadConfig } from './config.js';
import { startRuntime } from './service.js';

// --- File logging: tee stdout/stderr to ~/.skimpyclaw/logs/gateway.log ---

const LOG_DIR = join(homedir(), '.skimpyclaw', 'logs');
const LOG_FILE = join(LOG_DIR, 'gateway.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB — rotate when exceeded

function initLogging(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }

  // Rotate if log file exceeds max size
  if (existsSync(LOG_FILE)) {
    try {
      const stat = statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        const rotated = LOG_FILE + '.1';
        renameSync(LOG_FILE, rotated);
      }
    } catch {
      // Ignore rotation errors
    }
  }

  const logStream = createWriteStream(LOG_FILE, { flags: 'a' });

  const timestamp = () => new Date().toISOString();

  // Tee stdout
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    logStream.write(`${timestamp()} ${str}`);
    return origStdoutWrite(chunk, ...args);
  }) as typeof process.stdout.write;

  // Tee stderr
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    logStream.write(`${timestamp()} [ERR] ${str}`);
    return origStderrWrite(chunk, ...args);
  }) as typeof process.stderr.write;
}

// Initialize logging before anything else
initLogging();

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
