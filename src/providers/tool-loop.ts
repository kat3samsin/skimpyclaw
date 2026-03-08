/**
 * Unified agentic tool loop - works with any provider adapter.
 * Handles iteration control, tool execution, guard logic, compaction, and observability.
 */

import type { ChatMessage, ChatOptions, Config, ToolConfig, AuditTrace } from '../types.js';
import type { ToolChatResult } from './types.js';
import type { ExecuteToolContext } from '../tools.js';
import type { ProviderAdapter, NormalizedToolCall } from './adapter.js';
import { getToolDefinitions, executeTool } from '../tools.js';
import { ToolCallGuard } from './tool-guard.js';
import { splitToolResult } from './utils.js';
import { startTrace, addEvent, endTrace } from '../audit.js';
import { toErrorMessage } from '../utils.js';
import { buildToolLogEntry, logIteration, logCompaction, logMaxIterations } from './loop-utils.js';

/** Start a Langfuse observation (lazy import to avoid circular deps). Returns null if disabled. */
async function tryStartObservation(name: string, params: any, type: 'generation' | 'tool') {
  try {
    const { isLangfuseEnabled } = await import('../langfuse.js');
    if (!isLangfuseEnabled()) return null;
    const { startObservation } = await import('@langfuse/tracing');
    return startObservation(name, params, { asType: type } as any);
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
  const maxIterations = toolConfig.maxIterations || 20;
  const guard = new ToolCallGuard(toolConfig.maxTurnTokens);
  const toolLog: string[] = [];

  // Resolve tool definitions once
  const includeSpawn = !!(toolContext?.fullConfig && (toolContext?.chatId || toolContext?.isCronJob));
  const rawToolDefs = await getToolDefinitions(toolConfig, {
    includeAgentTools: includeSpawn,
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
  let totalCost = { input: 0, output: 0, total: 0 };
  let traceStatus: 'ok' | 'error' = 'ok';

  try {
    // Agentic loop
    for (let i = 0; i < maxIterations; i++) {
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
        i + 1,
        config,
      );
      if (compactionResult.compacted) {
        logCompaction(adapter.name, compactionResult.method || 'unknown', i);
        toolLog.push(`[context compacted via ${compactionResult.method}]`);
      }

      // Make API call
      logIteration(adapter.name, i, maxIterations, options.model);

      const genObs = await tryStartObservation(`${adapter.name}:${options.model}`, {
        input: { messages: providerMessages.messages },
        model: options.model,
        modelParameters: { max_tokens: options.maxTokens },
        metadata: { provider: adapter.name, iteration: i + 1 },
      }, 'generation');

      let response;
      try {
        response = await adapter.call(providerMessages, providerToolDefs, options, config);

        // Record usage
        adapter.recordUsage(
          options.model,
          response.usage,
          toolContext?.trigger || 'api',
          toolContext?.agentId,
        );

        // Accumulate usage across iterations
        totalInputTokens += response.usage?.inputTokens ?? 0;
        totalOutputTokens += response.usage?.outputTokens ?? 0;

        // Accumulate cost
        if (response.cost) {
          totalCost.input += response.cost.input;
          totalCost.output += response.cost.output;
          totalCost.total += response.cost.total;
        }

        // Track tokens in guard (for stats only, no enforcement)
        guard.recordTokens(
          response.usage?.inputTokens ?? 0,
          response.usage?.outputTokens ?? 0,
        );

        genObs?.update({ output: response.textContent });
        genObs?.end();
      } catch (err) {
        const errorMessage = toErrorMessage(err);
        genObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
        genObs?.end();
        traceStatus = 'error';
        throw err;
      }

      // If no tool calls, we're done
      if (!response.hasToolCalls) {
        let responseText = response.textContent;
        // Fallback when model did tool work but returned no text summary
        if (!responseText && toolLog.length > 0) {
          responseText = `[Completed with ${toolLog.length} tool calls, no text response]`;
        }
        return {
          response: responseText,
          toolCalls: toolLog,
          usage: {
            prompt_tokens: totalInputTokens,
            completion_tokens: totalOutputTokens,
            total_tokens: totalInputTokens + totalOutputTokens,
          },
          cost: totalCost.total > 0 ? totalCost : undefined,
        };
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
    }

    // Max iterations reached
    logMaxIterations(adapter.name, maxIterations);
    return {
      response: '[Tool use loop reached maximum iterations]',
      toolCalls: toolLog,
    };
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
    { input: toolCall.args, metadata: { app: 'skimpyclaw', tool: toolCall.name } },
    'tool',
  );
  const toolStart = Date.now();

  try {
    const result = await executeTool(toolCall.name, toolCall.args, toolConfig, toolContext);
    const truncatedResult = splitToolResult(toolCall.name, toolCall.args, result);
    const resultPreview = result.slice(0, 200) + (result.length > 200 ? '...' : '');

    console.log(`[${providerName}:tools] <- ${resultPreview}`);
    toolLog.push(buildToolLogEntry(toolCall.name, inputStr, resultPreview));

    toolObs?.update({ output: result });
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
    toolObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
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
