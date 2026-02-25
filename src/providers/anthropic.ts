// Anthropic Provider

import Anthropic from '@anthropic-ai/sdk';
import { startObservation } from '@langfuse/tracing';
import type { ProviderChatParams, ProviderToolChatParams, ToolChatResult } from './types.js';
import { buildSystemParam, addToolCacheBreakpoint, contentToText, stripProvider, buildThinkingConfig, truncateToolResult } from './utils.js';
import { toAnthropicUsageDetails, toCostDetails } from './observability.js';
import { getToolDefinitions, executeTool, type ExecuteToolContext } from '../tools.js';
import { ToolCallGuard } from './tool-guard.js';
import { startTrace, addEvent, endTrace } from '../audit.js';
import { buildUsageRecord, recordUsage } from '../usage.js';

let anthropicClient: Anthropic | null = null;

export function setAnthropicClient(client: Anthropic | null): void {
  anthropicClient = client;
}

export function getAnthropicClient(): Anthropic | null {
  return anthropicClient;
}

export function isAnthropicAvailable(): boolean {
  return anthropicClient !== null;
}

const LANGFUSE_APP_NAME = 'skimpyclaw';

function recordAnthropicUsage(params: {
  model: string;
  usage: any;
  trigger?: string;
  agentId?: string;
}): void {
  const usage = params.usage;
  const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0;
  if (inputTokens === 0 && outputTokens === 0) return;

  const cost = toCostDetails(params.model, usage);
  recordUsage(buildUsageRecord({
    model: params.model,
    provider: 'anthropic',
    inputTokens,
    outputTokens,
    inputCost: cost?.input ?? 0,
    outputCost: cost?.output ?? 0,
    totalCost: cost?.total ?? 0,
    trigger: params.trigger || 'api',
    agentId: params.agentId,
    cacheReadTokens: typeof usage?.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined,
    cacheCreationTokens: typeof usage?.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined,
  }));
}

async function startGenerationObservation(name: string, attributes: Record<string, any>) {
  // Check langfuse enabled through dynamic import to avoid circular deps
  const { isLangfuseEnabled } = await import('../langfuse.js');
  if (!isLangfuseEnabled()) return null;
  attributes.metadata = { app: LANGFUSE_APP_NAME, ...attributes.metadata };
  return startObservation(name, attributes, { asType: 'generation' });
}

export async function chatAnthropic(params: ProviderChatParams): Promise<string> {
  if (!anthropicClient) {
    throw new Error('Anthropic client not initialized');
  }

  const { messages, options, config } = params;
  const modelId = stripProvider(options.model);
  
  const systemMessage = messages.find(m => m.role === 'system');
  const chatMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content as any,
    }));

  // Build request parameters
  const cacheEnabled = config.models?.promptCaching !== false;
  const anthropicParams: Anthropic.MessageCreateParams = {
    model: modelId,
    max_tokens: options.maxTokens || 4096,
    messages: chatMessages,
  };

  const systemParam = buildSystemParam(contentToText(systemMessage?.content || ''), cacheEnabled);
  if (systemParam) {
    anthropicParams.system = systemParam;
  }

  // Add extended thinking if requested
  const thinkingConfig = buildThinkingConfig(options.thinking);
  if (thinkingConfig) {
    anthropicParams.thinking = {
      type: 'enabled',
      budget_tokens: thinkingConfig.budget,
    };
    anthropicParams.max_tokens = Math.max(anthropicParams.max_tokens, thinkingConfig.maxTokens);
  }

  const genObs = await startGenerationObservation(`anthropic:${modelId}`, {
    input: { system: systemMessage?.content, messages: chatMessages },
    model: modelId,
    modelParameters: {
      max_tokens: anthropicParams.max_tokens,
      ...(options.thinking && options.thinking !== 'none' ? { thinking: options.thinking } : {}),
    },
    metadata: { provider: 'anthropic' },
  });

  try {
    const response = await anthropicClient.messages.create(anthropicParams);
    const usage = (response as any).usage;

    // Log cache metrics
    if (usage?.cache_read_input_tokens > 0 || usage?.cache_creation_input_tokens > 0) {
      console.log(`[cache] read=${usage.cache_read_input_tokens || 0} created=${usage.cache_creation_input_tokens || 0}`);
    }
    recordAnthropicUsage({ model: modelId, usage, trigger: 'api' });

    // Extract text content
    const textContent = response.content.find(c => c.type === 'text');
    const text = textContent?.text || '';
    
    genObs?.update({
      output: { text },
      usageDetails: toAnthropicUsageDetails(usage),
      costDetails: toCostDetails(modelId, usage),
    });
    genObs?.end();

    return text;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    genObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
    genObs?.end();
    throw err;
  }
}

export async function chatWithToolsAnthropic(params: ProviderToolChatParams): Promise<ToolChatResult> {
  if (!anthropicClient) {
    throw new Error('Anthropic client not initialized');
  }

  const { messages, options, config, toolConfig, toolContext } = params;
  const modelId = stripProvider(options.model);
  const maxIterations = toolConfig.maxIterations || 20;

  // Resolve tools once at start of agent loop
  const includeSpawn = !!(toolContext?.chatId && toolContext?.fullConfig);
  const toolDefs = await getToolDefinitions(toolConfig, { includeSpawnSubagent: includeSpawn, projects: toolContext?.fullConfig?.projects });

  // Enable prompt caching for system + tools
  const cacheEnabled = config.models?.promptCaching !== false;
  if (cacheEnabled) addToolCacheBreakpoint(toolDefs);

  // Build system param with OAuth identity guard
  const systemMessage = messages.find(m => m.role === 'system');
  const systemParam = buildSystemParam(contentToText(systemMessage?.content || ''), cacheEnabled);

  // Build initial messages (exclude system)
  const apiMessages: any[] = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));

  // Track tool calls for logging
  const toolLog: string[] = [];

  // Guard: spin detection, no-progress detection, token budget
  const guard = new ToolCallGuard(toolConfig.maxTurnTokens);

  // Start audit trace
  const auditTraceId = toolContext?.auditTraceId || startTrace((toolContext?.trigger || 'api') as any);

  for (let i = 0; i < maxIterations; i++) {
    // Check abort signal before each iteration
    if (toolContext?.abortSignal?.aborted) {
      return {
        response: `[Cancelled after ${toolLog.length} tool calls]`,
        toolCalls: toolLog,
      };
    }

    const anthropicParams: any = {
      model: modelId,
      max_tokens: options.maxTokens || 16384,
      messages: apiMessages,
      tools: toolDefs,
    };

    if (systemParam) {
      anthropicParams.system = systemParam;
    }

    // Add thinking if configured
    const thinkingConfig = buildThinkingConfig(options.thinking);
    if (thinkingConfig) {
      anthropicParams.thinking = { type: 'enabled', budget_tokens: thinkingConfig.budget };
      anthropicParams.max_tokens = Math.max(anthropicParams.max_tokens, thinkingConfig.maxTokens);
    }

    console.log(`[agent:tools] Iteration ${i + 1}/${maxIterations}`);

    const genObs = await startGenerationObservation(`anthropic:${modelId}`, {
      input: { messages: apiMessages },
      model: modelId,
      modelParameters: { max_tokens: anthropicParams.max_tokens },
      metadata: { provider: 'anthropic', iteration: i + 1 },
    });

    let response: any;
    try {
      response = await anthropicClient.messages.create(anthropicParams);
      const usage = (response as any).usage;

      // Log cache metrics
      if (usage?.cache_read_input_tokens > 0 || usage?.cache_creation_input_tokens > 0) {
        console.log(`[cache] read=${usage.cache_read_input_tokens || 0} created=${usage.cache_creation_input_tokens || 0}`);
      }
      recordAnthropicUsage({
        model: modelId,
        usage,
        trigger: toolContext?.trigger || 'api',
        agentId: toolContext?.agentId,
      });

      genObs?.update({
        output: response.content,
        usageDetails: toAnthropicUsageDetails(usage),
        costDetails: toCostDetails(modelId, usage),
      });
      genObs?.end();

      // Guard: track token usage (stats only, no enforcement)
      guard.recordTokens(
        (response as any).usage?.input_tokens ?? 0,
        (response as any).usage?.output_tokens ?? 0,
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      genObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
      genObs?.end();
      throw err;
    }

    // If no tool use, we're done — extract text
    if (response.stop_reason !== 'tool_use') {
      const textBlocks = response.content.filter((c: any) => c.type === 'text');
      let responseText = textBlocks.map((b: any) => b.text).join('\n') || '';
      // Fallback when model did tool work but returned no text summary
      if (!responseText && toolLog.length > 0) {
        responseText = `[Completed with ${toolLog.length} tool calls, no text response]`;
      }
      const usage = (response as any).usage;
      return {
        response: responseText,
        toolCalls: toolLog,
        usage: {
          prompt_tokens: usage?.input_tokens ?? 0,
          completion_tokens: usage?.output_tokens ?? 0,
          total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
        },
        cost: toCostDetails(modelId, usage),
      };
    }

    // Add assistant response (full content including tool_use blocks)
    apiMessages.push({ role: 'assistant', content: response.content });

    // Execute each tool_use block
    const toolResults: any[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      const inputStr = JSON.stringify(block.input).slice(0, 200);
      console.log(`[agent:tools] -> ${block.name}(${inputStr})`);

      // Dynamic import to avoid circular dependency
      const { isLangfuseEnabled } = await import('../langfuse.js');
      const { startObservation } = await import('@langfuse/tracing');
      const toolObs = isLangfuseEnabled()
        ? startObservation(`tool:${block.name}`, { input: block.input, metadata: { app: LANGFUSE_APP_NAME, tool: block.name } }, { asType: 'tool' })
        : null;

      // Guard: spin detection
      const guardResult = guard.recordCall(block.name, block.input as Record<string, any>);
      if (guardResult.warning) console.warn(`[agent:tools:guard] ${guardResult.warning}`);
      if (guardResult.blocked) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: guardResult.warning || 'Blocked: repeated identical call',
          is_error: true,
        });
        toolLog.push(`${block.name} [BLOCKED: spin detected]`);
        continue;
      }

      const toolStart = Date.now();
      try {
        const result = await executeTool(block.name, block.input as Record<string, any>, toolConfig, toolContext);
        const truncatedResult = truncateToolResult(result);
        const resultPreview = result.slice(0, 200) + (result.length > 200 ? '...' : '');
        console.log(`[agent:tools] <- ${resultPreview}`);
        toolLog.push(`${block.name}(${inputStr}) → ${resultPreview}`);

        toolObs?.update({ output: result });
        toolObs?.end();

        // Record audit event
        if (toolContext?.auditTraceId) {
          addEvent(toolContext.auditTraceId, {
            type: 'tool_use',
            summary: `${block.name}(${inputStr})`,
            durationMs: Date.now() - toolStart,
          });
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: truncatedResult,
        });

        // Guard: no-progress detection
        const progressResult = guard.recordResult(result);
        if (progressResult.nudge) {
          console.warn(`[agent:tools:guard] ${progressResult.nudge}`);
          toolResults[toolResults.length - 1].content += `\n\n[System: ${progressResult.nudge}]`;
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        toolObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
        toolObs?.end();

        if (toolContext?.auditTraceId) {
          addEvent(toolContext.auditTraceId, {
            type: 'tool_error',
            summary: `${block.name} error: ${errorMessage.slice(0, 150)}`,
            durationMs: Date.now() - toolStart,
          });
        }
        throw err;
      }
    }

    // Send tool results back
    apiMessages.push({ role: 'user', content: toolResults });
  }

  console.warn(`[agent:tools] Max iterations (${maxIterations}) reached`);
  return {
    response: '[Tool use loop reached maximum iterations]',
    toolCalls: toolLog,
  };
}

/** Build UsageDetails from Anthropic usage response */
function buildUsageDetails(usage: any) {
  return {
    prompt_tokens: usage?.input_tokens ?? 0,
    completion_tokens: usage?.output_tokens ?? 0,
    total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
  };
}
