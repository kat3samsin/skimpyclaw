// OpenAI-Compatible Provider (OpenAI, OpenRouter, Groq, etc.)

import OpenAI from 'openai';
import { startObservation } from '@langfuse/tracing';
import type { ProviderChatParams, ProviderToolChatParams, ToolChatResult } from './types.js';
import { stripProvider, toOpenAITools } from './utils.js';
import { toOpenAIContent } from './content.js';
import { toUsageDetails, toCostDetails } from './observability.js';
import { getToolDefinitions, executeTool } from '../tools.js';
import { addEvent } from '../audit.js';

// Map of provider name → OpenAI client
const openaiClients = new Map<string, OpenAI>();

export function addOpenAIClient(name: string, client: OpenAI): void {
  openaiClients.set(name, client);
}

export function getOpenAIClient(name: string): OpenAI | undefined {
  return openaiClients.get(name);
}

export function hasOpenAIClient(name: string): boolean {
  return openaiClients.has(name);
}

export function clearOpenAIClients(): void {
  openaiClients.clear();
}

export function resetOpenAIProviderState(): void {
  openaiClients.clear();
}

export function isOpenAIAvailable(provider: string): boolean {
  return openaiClients.has(provider);
}

const LANGFUSE_APP_NAME = 'skimpyclaw';

async function startGenerationObservation(name: string, attributes: Record<string, any>) {
  const { isLangfuseEnabled } = await import('../langfuse.js');
  if (!isLangfuseEnabled()) return null;
  attributes.metadata = { app: LANGFUSE_APP_NAME, ...attributes.metadata };
  return startObservation(name, attributes, { asType: 'generation' });
}

export async function chatOpenAI(params: ProviderChatParams, provider: string): Promise<string> {
  const client = openaiClients.get(provider);
  if (!client) {
    throw new Error(`OpenAI client not initialized for provider: ${provider}`);
  }

  const { messages, options, config } = params;
  const modelId = stripProvider(options.model, openaiClients);

  const openaiMessages: any[] = messages.map(m => ({
    role: m.role,
    content: toOpenAIContent(m.content),
  }));

  const genObs = await startGenerationObservation(`${provider}:${modelId}`, {
    input: { messages: openaiMessages },
    model: modelId,
    modelParameters: {
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature,
    },
    metadata: { provider },
  });

  try {
    const response = await client.chat.completions.create({
      model: modelId,
      messages: openaiMessages,
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature,
    });

    let content = response.choices[0]?.message?.content || '';
    // Strip <think>...</think> reasoning blocks (e.g. MiniMax M2.x)
    content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    
    genObs?.update({
      output: response.choices[0]?.message,
      usageDetails: toUsageDetails(response.usage),
      costDetails: toCostDetails(modelId, response.usage),
    });
    genObs?.end();

    return content;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    genObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
    genObs?.end();
    throw err;
  }
}

export async function chatWithToolsOpenAI(params: ProviderToolChatParams, provider: string): Promise<ToolChatResult> {
  const client = openaiClients.get(provider);
  if (!client) {
    throw new Error(`OpenAI client not initialized for provider: ${provider}`);
  }

  const { messages, options, config, toolConfig, toolContext } = params;
  const modelId = stripProvider(options.model, openaiClients);
  const maxIterations = toolConfig.maxIterations || 20;

  // Resolve tools once at start
  const includeSpawn = !!(toolContext?.chatId && toolContext?.fullConfig);
  const toolDefs = await getToolDefinitions(toolConfig, { 
    includeSpawnSubagent: includeSpawn, 
    includeMcp: false, 
    projects: toolContext?.fullConfig?.projects 
  });
  const openaiTools: any[] = toOpenAITools(toolDefs);

  // Inject Kimi $web_search builtin tool when using Moonshot/Kimi provider
  const providerBaseURL = config.models.providers[provider]?.baseURL || '';
  if (providerBaseURL.includes('kimi.com') || providerBaseURL.includes('moonshot.ai')) {
    openaiTools.push({ type: 'builtin_function', function: { name: '$web_search' } });
    console.log('[agent:openai-tools] Injected Kimi $web_search builtin tool');
  }

  // Build messages for OpenAI format — preserve images for vision models
  const apiMessages: any[] = messages.map(m => ({
    role: m.role,
    content: toOpenAIContent(m.content),
  }));

  const toolLog: string[] = [];

  for (let i = 0; i < maxIterations; i++) {
    // Check abort signal
    if (toolContext?.abortSignal?.aborted) {
      return {
        response: `[Cancelled after ${toolLog.length} tool calls]`,
        toolCalls: toolLog,
      };
    }

    console.log(`[agent:openai-tools] Iteration ${i + 1}/${maxIterations} (provider: ${provider}, model: ${modelId})`);

    const genObs = await startGenerationObservation(`${provider}:${modelId}`, {
      input: { messages: apiMessages },
      model: modelId,
      modelParameters: {
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature,
      },
      metadata: { provider, iteration: i + 1 },
    });

    let completion: any;
    try {
      completion = await client.chat.completions.create({
        model: modelId,
        messages: apiMessages,
        tools: openaiTools,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature,
      });
      genObs?.update({
        output: completion.choices[0]?.message,
        usageDetails: toUsageDetails(completion.usage),
        costDetails: toCostDetails(modelId, completion.usage),
      });
      genObs?.end();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      genObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
      genObs?.end();
      throw err;
    }

    const message = completion.choices[0]?.message;
    if (!message) {
      return { response: '[No response from model]', toolCalls: toolLog };
    }

    // No tool calls — return the text response
    if (completion.choices[0]?.finish_reason !== 'tool_calls' || !message.tool_calls?.length) {
      let content = message.content || '';
      // Strip <think>...</think> reasoning blocks (e.g. MiniMax M2.x)
      content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
      if (!content && toolLog.length > 0) {
        content = `[Completed with ${toolLog.length} tool calls, no text response]`;
      }
      return { response: content, toolCalls: toolLog };
    }

    // Append assistant message with tool_calls to conversation
    apiMessages.push(message);

    // Execute each tool call
    for (const toolCall of message.tool_calls) {
      const fnName = toolCall.function.name;
      let args: Record<string, any>;
      try {
        args = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        args = {};
      }

      const inputStr = JSON.stringify(args).slice(0, 200);
      console.log(`[agent:openai-tools] -> ${fnName}(${inputStr})`);

      const { isLangfuseEnabled } = await import('../langfuse.js');
      const toolObs = isLangfuseEnabled()
        ? startObservation(`tool:${fnName}`, { input: args, metadata: { app: LANGFUSE_APP_NAME, tool: fnName } }, { asType: 'tool' })
        : null;

      const toolStart = Date.now();
      try {
        const result = await executeTool(fnName, args, toolConfig, toolContext) || '';
        const resultPreview = result.slice(0, 200) + (result.length > 200 ? '...' : '');
        console.log(`[agent:openai-tools] <- ${resultPreview}`);
        toolLog.push(`${fnName}(${inputStr}) → ${resultPreview}`);

        toolObs?.update({ output: result });
        toolObs?.end();

        if (toolContext?.auditTraceId) {
          addEvent(toolContext.auditTraceId, {
            type: 'tool_use',
            summary: `${fnName}(${inputStr})`,
            durationMs: Date.now() - toolStart,
          });
        }

        // Add tool result in OpenAI format
        apiMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        toolObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
        toolObs?.end();

        if (toolContext?.auditTraceId) {
          addEvent(toolContext.auditTraceId, {
            type: 'tool_error',
            summary: `${fnName} error: ${errorMessage.slice(0, 150)}`,
            durationMs: Date.now() - toolStart,
          });
        }
        throw err;
      }
    }
  }

  console.warn(`[agent:openai-tools] Max iterations (${maxIterations}) reached`);
  return {
    response: '[Tool use loop reached maximum iterations]',
    toolCalls: toolLog,
  };
}
