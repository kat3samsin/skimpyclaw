// Langfuse tracing integration (optional)

import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider } from '@langfuse/tracing';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { Config } from './types.js';

export interface LangfuseConfig {
  enabled?: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  environment?: string;
  release?: string;
  exportMode?: 'immediate' | 'batched';
}

let enabled = false;
let tracerProvider: NodeTracerProvider | null = null;
let langfuseConfig: LangfuseConfig | null = null;

export function initLangfuse(config: Config): void {
  const cfg = config.langfuse as LangfuseConfig | undefined;
  if (!cfg?.enabled) return;

  tracerProvider = new NodeTracerProvider({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: cfg.publicKey,
        secretKey: cfg.secretKey,
        baseUrl: cfg.baseUrl,
        environment: cfg.environment,
        release: cfg.release,
        exportMode: cfg.exportMode,
      }),
    ],
  });

  tracerProvider.register();
  setLangfuseTracerProvider(tracerProvider);

  enabled = true;
  langfuseConfig = cfg;

  console.log(`[langfuse] Enabled (${cfg.baseUrl || 'https://cloud.langfuse.com'})`);
}

export function isLangfuseEnabled(): boolean {
  return enabled;
}

export function getLangfuseConfig(): LangfuseConfig | null {
  return langfuseConfig;
}

export async function shutdownLangfuse(): Promise<void> {
  if (!tracerProvider) return;
  try {
    await tracerProvider.shutdown();
  } catch (err) {
    console.warn('[langfuse] Shutdown failed:', err);
  }
}
