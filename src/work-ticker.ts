import { listWorkItems, tickWorkItem } from './code-agents/review-loop.js';
import type { WorkStatus } from './code-agents/review-loop-types.js';

const TICKABLE: WorkStatus[] = ['planning', 'revising', 'implementing', 'reviewing'];

export interface WorkTickerOptions {
  intervalMs?: number;
}

export function startWorkTicker(opts: WorkTickerOptions = {}): () => void {
  const interval = opts.intervalMs ?? 3000;

  async function tickAll() {
    try {
      const items = listWorkItems();
      const tickable = items.filter(i => TICKABLE.includes(i.status as WorkStatus));
      await Promise.allSettled(
        tickable.map(i => tickWorkItem(i.id).catch(err => {
          console.error(`[work-ticker] ${i.id} tick failed:`, err);
        })),
      );
    } catch (err) {
      console.error('[work-ticker] list failed:', err);
    }
  }

  const handle = setInterval(() => { void tickAll(); }, interval);
  return () => clearInterval(handle);
}
