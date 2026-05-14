/**
 * Shared utility functions for the tool loop.
 * Extracted to eliminate duplication across provider implementations.
 */

/**
 * Build a standardized tool log entry.
 */
export function buildToolLogEntry(
  toolName: string,
  inputStr: string,
  resultPreview: string,
): string {
  const truncatedInput = inputStr.length > 100 ? inputStr.slice(0, 100) + '...' : inputStr;
  const truncatedResult = resultPreview.length > 200 ? resultPreview.slice(0, 200) + '...' : resultPreview;
  return `${toolName}(${truncatedInput}) → ${truncatedResult}`;
}

/**
 * Log iteration progress to console.
 */
export function logIteration(
  provider: string,
  iteration: number,
  modelId: string,
): void {
  console.log(`[${provider}] Iteration ${iteration + 1} (model: ${modelId})`);
}

/**
 * Log compaction event.
 */
export function logCompaction(
  provider: string,
  method: string,
  iteration: number,
): void {
  console.log(`[${provider}] Compacted messages (${method}) at iteration ${iteration + 1}`);
}
