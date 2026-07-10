/**
 * Unified agentic tool loop - works with any provider adapter.
 * Handles iteration control, tool execution, guard logic, compaction, and observability.
 */

import type { ChatMessage, ChatOptions, Config, ToolConfig, AuditTrace } from '../types.js';
import type { ToolChatResult } from './types.js';
import type { ExecuteToolContext } from '../tools.js';
import type { ProviderAdapter, NormalizedResponse, NormalizedToolCall } from './adapter.js';
import { getToolDefinitions, executeTool } from '../tools.js';
import { ToolCallGuard } from './tool-guard.js';
import { splitToolResult } from './utils.js';
import { startTrace, addEvent, endTrace } from '../audit.js';
import { toErrorMessage } from '../utils.js';
import { buildToolLogEntry, logIteration, logCompaction } from './loop-utils.js';
import { sanitizeLangfusePayload } from '../langfuse.js';

/** Start a Langfuse observation (lazy import to avoid circular deps). Returns null if disabled. */
async function tryStartObservation(name: string, params: any, type: 'generation' | 'tool') {
  try {
    const { isLangfuseEnabled } = await import('../langfuse.js');
    if (!isLangfuseEnabled()) return null;
    const { startObservation } = await import('@langfuse/tracing');
    return startObservation(name, sanitizeLangfusePayload(params), { asType: type } as any);
  } catch {
    return null;
  }
}

/**
 * Run the unified agentic tool loop with any provider adapter.
 */
export async function runToolLoop(
  adapter: ProviderAdapter,
  messages: ChatMessage[],
  options: ChatOptions,
  config: Config,
  toolConfig: ToolConfig,
  toolContext?: ExecuteToolContext,
): Promise<ToolChatResult> {
  const finalizationInterval = toolConfig.maxIterations && toolConfig.maxIterations > 0
    ? toolConfig.maxIterations
    : undefined;
  const guard = new ToolCallGuard(toolConfig.maxTurnTokens);
  const toolLog: string[] = [];

  // Resolve tool definitions once
  const includeSpawn = !!(toolContext?.fullConfig && (toolContext?.chatId || toolContext?.isCronJob));
  const providerToolDefOptions = adapter.getToolDefinitionOptions?.(toolContext, config) || {};
  const rawToolDefs = await getToolDefinitions(toolConfig, {
    includeAgentTools: includeSpawn,
    includeMcp: providerToolDefOptions.includeMcp,
    projects: toolContext?.fullConfig?.projects,
  });

  // Build provider-specific tool definitions
  const providerToolDefs = adapter.buildToolDefs(rawToolDefs, config);

  // Build initial provider messages
  const providerMessages = adapter.buildMessages(messages, options, config);

  // Start audit trace if not already started
  const trigger = (toolContext?.trigger || 'api') as AuditTrace['trigger'];
  const ownTrace = !toolContext?.auditTraceId;
  const auditTraceId = toolContext?.auditTraceId || startTrace(trigger);

  // Cumulative usage and cost across all iterations
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const totalCost = { input: 0, output: 0, total: 0 };
  let usageComplete = true;
  let traceStatus: 'ok' | 'error' = 'ok';
  let pendingFinalizationCheckpoint = false;

  const recordResponseMetrics = (
    response: Pick<NormalizedResponse, 'usage' | 'cost'>,
  ): ReturnType<ToolCallGuard['recordTokens']> => {
    const inputTokens = response.usage?.inputTokens;
    const outputTokens = response.usage?.outputTokens;
    const validUsage = Number.isFinite(inputTokens)
      && Number.isFinite(outputTokens)
      && (inputTokens as number) >= 0
      && (outputTokens as number) >= 0;
    if (validUsage) {
      adapter.recordUsage(
        options.model,
        response.usage,
        toolContext?.trigger || 'api',
        toolContext?.agentId,
      );
      totalInputTokens += inputTokens as number;
      totalOutputTokens += outputTokens as number;
    } else {
      usageComplete = false;
    }

    if (response.cost) {
      totalCost.input += response.cost.input;
      totalCost.output += response.cost.output;
      totalCost.total += response.cost.total;
    }

    return guard.recordTokens(
      validUsage ? inputTokens : undefined,
      validUsage ? outputTokens : undefined,
    );
  };

  const requestFinalization = async (
    reason: string,
  ): Promise<{ text?: string; tokenResult?: ReturnType<ToolCallGuard['recordTokens']> }> => {
    if (!adapter.onEmptyFinalResponse) return {};
    try {
      const finalized = await adapter.onEmptyFinalResponse(
        providerMessages, providerToolDefs, options, config,
      );
      if (!finalized) {
        usageComplete = false;
        return { tokenResult: guard.recordTokens(undefined, undefined) };
      }
      const tokenResult = recordResponseMetrics(finalized);
      if (finalized.hasToolCalls) {
        console.warn(`[${adapter.name}] ${reason} finalization unexpectedly requested tools`);
        return { tokenResult };
      }
      return { text: finalized.textContent.trim() || undefined, tokenResult };
    } catch (err) {
      usageComplete = false;
      console.warn(`[${adapter.name}] ${reason} finalization pass failed: ${toErrorMessage(err)}`);
      return { tokenResult: guard.recordTokens(undefined, undefined) };
    }
  };

  const buildResult = (response: string): ToolChatResult => ({
    response,
    toolCalls: toolLog,
    usage: usageComplete ? {
      prompt_tokens: totalInputTokens,
      completion_tokens: totalOutputTokens,
      total_tokens: totalInputTokens + totalOutputTokens,
    } : undefined,
    cost: totalCost.total > 0 ? totalCost : undefined,
  });

  try {
    // Agentic loop
    for (let i = 0; ; i++) {
      const iteration = i + 1;

      // Check abort signal before each iteration
      if (toolContext?.abortSignal?.aborted) {
        return {
          response: `[Cancelled after ${toolLog.length} tool calls]`,
          toolCalls: toolLog,
        };
      }

      // Compact messages if needed
      const compactionResult = await adapter.compactMessages(
        providerMessages,
        toolConfig.contextManagement,
        iteration,
        config,
      );
      if (compactionResult.compacted) {
        logCompaction(adapter.name, compactionResult.method || 'unknown', i);
        toolLog.push(`[context compacted via ${compactionResult.method}]`);
      }

      if (pendingFinalizationCheckpoint && adapter.onEmptyFinalResponse) {
        pendingFinalizationCheckpoint = false;
        const finalization = await requestFinalization('checkpoint');
        if (finalization.text) return buildResult(finalization.text);
        if (finalization.tokenResult?.exceeded) {
          return buildResult(`[Stopped: ${finalization.tokenResult.warning}]`);
        }
      }

      // Make API call
      logIteration(adapter.name, i, options.model);

      const genObs = await tryStartObservation(`${adapter.name}:${options.model}`, {
        input: sanitizeLangfusePayload({ messages: providerMessages.messages }),
        model: options.model,
        modelParameters: { max_tokens: options.maxTokens },
        metadata: { provider: adapter.name, iteration: i + 1 },
      }, 'generation');

      let response;
      let tokenResult: ReturnType<ToolCallGuard['recordTokens']> = { exceeded: false };
      try {
        response = await adapter.call(providerMessages, providerToolDefs, options, config);
        tokenResult = recordResponseMetrics(response);
        if (tokenResult.warning) {
          console.warn(`[${adapter.name}:tools:guard] ${tokenResult.warning}`);
        }

        genObs?.update({ output: sanitizeLangfusePayload(response.textContent) });
        genObs?.end();
      } catch (err) {
        const errorMessage = toErrorMessage(err);
        genObs?.update({
          level: 'ERROR',
          statusMessage: errorMessage,
          output: sanitizeLangfusePayload({ error: errorMessage }),
        });
        genObs?.end();
        traceStatus = 'error';
        throw err;
      }

      // If no tool calls, we're done
      if (!response.hasToolCalls) {
        let responseText = response.textContent;
        // Fallback when model returned no text
        if (!responseText) {
          const emptyResponseDetail = `stop_reason: ${(response.rawResponse as any)?.stop_reason}, content blocks: ${JSON.stringify(((response.rawResponse as any)?.content || []).map((b: any) => b.type))}`;
          if (toolLog.length > 0) {
            console.log(`[${adapter.name}] empty text response after ${toolLog.length} tool calls (${emptyResponseDetail})`);
            // Let adapter attempt a finalization pass (e.g. Codex re-asks without tools)
            if (adapter.onEmptyFinalResponse) {
              const finalization = await requestFinalization('empty-response');
              if (finalization.text) responseText = finalization.text;
            }
            if (!responseText) {
              responseText = `[Completed with ${toolLog.length} tool calls, no text response]`;
            }
          } else {
            console.warn(`[${adapter.name}] empty text response (${emptyResponseDetail})`);
            responseText = '[Model returned empty response — please try again]';
          }
        }
        return buildResult(responseText);
      }

      // A complete text response is still useful at the limit. Only stop when
      // the model is asking to spend more budget by executing another tool.
      if (tokenResult.exceeded) {
        adapter.appendAssistantResponse(providerMessages, response.rawResponse);
        const blockedResults = response.toolCalls.map((toolCall) => {
          toolLog.push(`${toolCall.name} [BLOCKED: token budget]`);
          return {
            toolCallId: toolCall.id,
            result: `[Tool execution skipped: ${tokenResult.warning}]`,
            isError: true,
          };
        });
        if (adapter.appendToolResults && blockedResults.length > 1) {
          adapter.appendToolResults(providerMessages, blockedResults);
        } else {
          for (const blocked of blockedResults) {
            adapter.appendToolResult(
              providerMessages,
              blocked.toolCallId,
              blocked.result,
              blocked.isError,
            );
          }
        }
        const finalization = await requestFinalization('token-budget');
        return buildResult(finalization.text || `[Stopped: ${tokenResult.warning}]`);
      }

      // Append assistant's response to history
      adapter.appendAssistantResponse(providerMessages, response.rawResponse);

      // Execute each tool call, collecting results for batching
      const toolResults: { toolCallId: string; result: string; isError: boolean }[] = [];
      for (const toolCall of response.toolCalls) {
        const result = await executeToolCall(
          toolCall,
          guard,
          toolConfig,
          toolContext,
          toolLog,
          adapter.name,
        );
        toolResults.push(result);
      }

      // Append all tool results — batch if adapter supports it, otherwise one at a time
      if (adapter.appendToolResults && toolResults.length > 1) {
        adapter.appendToolResults(providerMessages, toolResults);
      } else {
        for (const tr of toolResults) {
          adapter.appendToolResult(providerMessages, tr.toolCallId, tr.result, tr.isError);
        }
      }

      pendingFinalizationCheckpoint = !!(
        finalizationInterval
        && iteration % finalizationInterval === 0
        && toolLog.length > 0
        && adapter.onEmptyFinalResponse
      );
    }
  } finally {
    // End the audit trace if we created it
    if (ownTrace) {
      await endTrace(auditTraceId, traceStatus).catch(() => {});
    }
  }
}

/** Result of executing a single tool call. */
interface ToolCallResult {
  toolCallId: string;
  result: string;
  isError: boolean;
}

/**
 * Execute a single tool call and return the result (does NOT append to messages).
 */
async function executeToolCall(
  toolCall: NormalizedToolCall,
  guard: ToolCallGuard,
  toolConfig: ToolConfig,
  toolContext: ExecuteToolContext | undefined,
  toolLog: string[],
  providerName: string,
): Promise<ToolCallResult> {
  const inputStr = toolCall.rawArgs.slice(0, 200);
  console.log(`[${providerName}:tools] -> ${toolCall.name}(${inputStr})`);

  // Guard: spin detection
  const guardResult = guard.recordCall(toolCall.name, toolCall.args);
  if (guardResult.warning) {
    console.warn(`[${providerName}:tools:guard] ${guardResult.warning}`);
  }
  if (guardResult.blocked) {
    toolLog.push(`${toolCall.name} [BLOCKED: spin detected]`);
    return {
      toolCallId: toolCall.id,
      result: guardResult.warning || 'Blocked: repeated identical call',
      isError: true,
    };
  }

  // Execute tool
  const toolObs = await tryStartObservation(
    `tool:${toolCall.name}`,
    {
      input: sanitizeLangfusePayload(toolCall.args),
      metadata: { app: 'skimpyclaw', tool: toolCall.name },
    },
    'tool',
  );
  const toolStart = Date.now();

  try {
    const result = await executeTool(toolCall.name, toolCall.args, toolConfig, toolContext);
    const truncatedResult = splitToolResult(toolCall.name, toolCall.args, result);
    const resultPreview = result.slice(0, 200) + (result.length > 200 ? '...' : '');

    console.log(`[${providerName}:tools] <- ${resultPreview}`);
    toolLog.push(buildToolLogEntry(toolCall.name, inputStr, resultPreview));

    toolObs?.update({ output: sanitizeLangfusePayload(result) });
    toolObs?.end();

    // Record audit event
    if (toolContext?.auditTraceId) {
      addEvent(toolContext.auditTraceId, {
        type: 'tool_use',
        summary: `${toolCall.name}(${inputStr})`,
        durationMs: Date.now() - toolStart,
      });
    }

    // Guard: no-progress detection
    const progressResult = guard.recordResult(result);
    let finalResult = truncatedResult;
    if (progressResult.nudge) {
      console.warn(`[${providerName}:tools:guard] ${progressResult.nudge}`);
      finalResult += `\n\n[System: ${progressResult.nudge}]`;
    }

    return { toolCallId: toolCall.id, result: finalResult, isError: false };
  } catch (err) {
    const errorMessage = toErrorMessage(err);
    toolObs?.update({
      level: 'ERROR',
      statusMessage: errorMessage,
      output: sanitizeLangfusePayload({ error: errorMessage }),
    });
    toolObs?.end();

    if (toolContext?.auditTraceId) {
      addEvent(toolContext.auditTraceId, {
        type: 'tool_error',
        summary: `${toolCall.name} error: ${errorMessage.slice(0, 150)}`,
        durationMs: Date.now() - toolStart,
      });
    }

    const errorResult = `[Tool Error] ${toolCall.name}: ${errorMessage}`;
    console.error(`[${providerName}:tools] tool error: ${errorMessage}`);
    toolLog.push(`${toolCall.name} [ERROR: ${errorMessage.slice(0, 100)}]`);
    return { toolCallId: toolCall.id, result: errorResult, isError: true };
  }
}
