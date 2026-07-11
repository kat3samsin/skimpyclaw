// Agent runner: loads templates, calls models, manages memory

import { readFileSync, writeFileSync, appendFileSync, chmodSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getAgentDir } from './config.js';
import { buildSafeSystemPrompt, sanitizeUserInput, redactSecretText } from './security.js';
import { toErrorMessage } from './utils.js';
import type { Config, ChatMessage, ChatOptions, ToolConfig, AgentRunContext, ContentBlock, ThinkingLevel } from './types.js';
import type { ExecuteToolContext } from './tools.js';
import { startTrace, endTrace } from './audit.js';
import { loadSkills, getSkillsForContext, formatSkillsPrompt } from './skills.js';
import type { SkillConfig } from './skills-types.js';
import { getLangfuseConfig, isLangfuseEnabled, sanitizeLangfusePayload } from './langfuse.js';
import { startActiveObservation, updateActiveTrace } from '@langfuse/tracing';
import { TTLCache } from './cache.js';

// Import from providers module
import {
  chat,
  chatWithTools,
  resolveProviderRoute,
} from './providers/index.js';

// Re-export providers for backward compatibility
export {
  initProviders,
  setUsingOAuth,
  resolveModel,
  getProvider,
  stripProvider,
  // Re-export utility functions that tests expect from agent.ts
  buildSystemParam,
  addToolCacheBreakpoint,
  toOpenAITools,
} from './providers/index.js';

// Re-export types for backward compatibility
export type { ToolChatResult } from './providers/types.js';

// --- Template Loading ---

export const TEMPLATE_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'MEMORY.md'];

const templateCache = new TTLCache<Record<string, string>>(60_000);

export function loadAgentTemplates(agentId: string): Record<string, string> {
  const cached = templateCache.get(agentId);
  if (cached) return cached;

  const agentDir = getAgentDir(agentId);
  const templates: Record<string, string> = {};

  for (const file of TEMPLATE_FILES) {
    const path = join(agentDir, file);
    if (existsSync(path)) {
      templates[file.replace('.md', '')] = readFileSync(path, 'utf-8');
    }
  }

  templateCache.set(agentId, templates);
  return templates;
}

export function clearTemplateCache(): void {
  templateCache.clear();
}

/** Context for skills injection into the system prompt */
export interface SkillsPromptContext {
  channel?: string;
  cronJobId?: string;
  tags?: string[];
  toolConfig?: ToolConfig;
  skillConfig?: SkillConfig;
}

export function buildSystemPrompt(agentId: string, skillsContext?: SkillsPromptContext): string {
  const templates = loadAgentTemplates(agentId);

  const soul = templates.SOUL || '';
  const identity = templates.IDENTITY || '';
  const user = templates.USER || '';
  const tools = templates.TOOLS || '';
  const memory = templates.MEMORY || '';

  // Load and filter skills
  let skillsSection = '';
  if (skillsContext?.skillConfig?.enabled !== false) {
    const allSkills = loadSkills(skillsContext?.skillConfig, skillsContext?.toolConfig);
    const contextSkills = getSkillsForContext(allSkills, {
      channel: skillsContext?.channel,
      cronJobId: skillsContext?.cronJobId,
      tags: skillsContext?.tags,
    });
    skillsSection = formatSkillsPrompt(contextSkills, skillsContext?.skillConfig?.maxPromptTokens, skillsContext?.skillConfig?.dynamicLoading);
  }

  const base = [soul, identity, tools, skillsSection].filter(Boolean).join('\n\n---\n\n');
  const userContext = [user, memory].filter(Boolean).join('\n\n');

  const prompt = buildSafeSystemPrompt(base, userContext);

  return prompt;
}

// --- Memory Management ---

const MEMORY_FIELD_MAX_CHARS = 20_000;
const MEMORY_TOOL_LOG_MAX = 50;

export function getMemoryDir(agentId: string): string {
  return join(getAgentDir(agentId), 'memory', 'logs');
}

export function getTodayMemoryPath(agentId: string): string {
  const date = new Date().toISOString().split('T')[0];
  return join(getMemoryDir(agentId), `${date}.md`);
}

export function appendToMemory(agentId: string, entry: string): void {
  const memoryDir = getMemoryDir(agentId);
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
  }
  chmodSync(memoryDir, 0o700);

  const path = getTodayMemoryPath(agentId);
  const timestamp = new Date().toISOString();
  appendFileSync(path, `\n## ${timestamp}\n\n${entry}\n`, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function truncateForMemory(value: string, maxChars: number = MEMORY_FIELD_MAX_CHARS): string {
  const redacted = redactSecretText(value);
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}\n[truncated ${redacted.length - maxChars} chars]`;
}

export function formatMemoryEntry(userMessage: string, assistantMessage: string, toolCalls: string[]): string {
  let entry = `**User:** ${truncateForMemory(userMessage)}\n\n`;
  if (toolCalls.length > 0) {
    const shownTools = toolCalls.slice(0, MEMORY_TOOL_LOG_MAX);
    entry += `**Tools used (${toolCalls.length}):**\n${shownTools.map(t => `- ${truncateForMemory(t, 1_000)}`).join('\n')}`;
    if (toolCalls.length > shownTools.length) {
      entry += `\n- [truncated ${toolCalls.length - shownTools.length} additional tool calls]`;
    }
    entry += '\n\n';
  }
  entry += `**Assistant:** ${truncateForMemory(assistantMessage)}`;
  return entry;
}

// --- Agent Turn ---

// Langfuse app tagging
const LANGFUSE_APP_NAME = 'skimpyclaw';
const LANGFUSE_APP_TAG = 'app:skimpyclaw';
const THINKING_LEVELS = new Set<ThinkingLevel>(['none', 'low', 'medium', 'high', 'xhigh']);

function metadataThinking(value: unknown): ThinkingLevel | undefined {
  return typeof value === 'string' && THINKING_LEVELS.has(value as ThinkingLevel)
    ? value as ThinkingLevel
    : undefined;
}

export async function runAgentTurn(
  agentId: string,
  userMessage: string | ContentBlock[],
  config: Config,
  modelOverride?: string,
  toolConfig?: ToolConfig,
  history?: ChatMessage[],
  context?: AgentRunContext
): Promise<string> {
  const agentConfig = config.agents.list[agentId];
  if (!agentConfig) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  let systemPrompt = buildSystemPrompt(agentId, {
    channel: context?.channel,
    tags: context?.tags,
    toolConfig,
    skillConfig: config.skills,
  });

  // Inject channel-specific formatting context
  if (context?.channel) {
    const channelHints: Record<string, string> = {
      telegram: `\n\n## Channel: Telegram\nPlain text only. No markdown. Use CAPS for emphasis, plain URLs.`,
      discord: `\n\n## Channel: Discord\nUse markdown: **bold**, *italic*, \`code\`, \`\`\`blocks\`\`\`, [links](url).`,
    };
    systemPrompt += channelHints[context.channel] || '';
  }

  const metadata = context?.metadata as Record<string, unknown> | undefined;
  const threadAgentAlias = typeof metadata?.threadAgentAlias === 'string'
    ? metadata.threadAgentAlias.trim()
    : '';
  const threadAgentPrompt = typeof metadata?.threadAgentPromptOverlay === 'string'
    ? metadata.threadAgentPromptOverlay.trim()
    : '';
  if (threadAgentAlias || threadAgentPrompt) {
    systemPrompt += `\n\n## Discord Thread Agent`;
    if (threadAgentAlias) {
      systemPrompt += `\nAlias: ${threadAgentAlias}`;
    }
    if (threadAgentPrompt) {
      systemPrompt += `\nFollow this additional thread-specific prompt:\n${threadAgentPrompt}`;
    }
  }

  // Build user content — support both string and content arrays (for images)
  let userContent: string | ContentBlock[];
  let sanitizedMessage: string;
  if (typeof userMessage === 'string') {
    sanitizedMessage = sanitizeUserInput(userMessage);
    userContent = sanitizedMessage;
  } else {
    // Content array (image + text) — sanitize text blocks only
    userContent = userMessage.map(block => {
      if (block.type === 'text') {
        return { ...block, text: sanitizeUserInput(block.text) };
      }
      return block;
    });
    const textBlock = userMessage.find(b => b.type === 'text');
    sanitizedMessage = textBlock?.type === 'text' ? textBlock.text : '[Image]';
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(history || []),
    { role: 'user', content: userContent },
  ];

  const model = modelOverride || agentConfig.model;
  const thinking = metadataThinking(metadata?.threadAgentThinking)
    ?? metadataThinking(metadata?.thinkingOverride)
    ?? agentConfig.thinking;
  const chatOptions: ChatOptions = {
    model,
    thinking,
    abortSignal: context?.abortSignal,
    trigger: context?.trigger || 'system',
    agentId,
  };

  const route = resolveProviderRoute(model, config);
  const { resolvedModel, provider, modelId } = route;

  let response: string = '';
  let toolCalls: string[] = [];

  // Start audit trace
  const auditTraceId = startTrace(context?.trigger || 'system');

  // Build tool context once
  const chatIdNum = (context?.metadata as any)?.chatId
    ?? (context?.sessionId ? parseInt(context.sessionId, 10) : undefined);

  // Determine channel target ID
  let channelTargetId: string | number | undefined;
  if (context?.channel === 'telegram') {
    channelTargetId = (context.metadata as any)?.chatId;
  } else if (context?.channel === 'discord') {
    channelTargetId = context.sessionId;
  }

  const toolCtx: ExecuteToolContext = {
    chatId: Number.isFinite(chatIdNum) ? chatIdNum : undefined,
    fullConfig: config,
    history,
    abortSignal: context?.abortSignal,
    lockTaskId: auditTraceId,
    auditTraceId,
    channel: context?.channel,
    channelTargetId,
    approverUserId: context?.userId,
    approverUsername: (context?.metadata as any)?.username,
    sessionId: context?.sessionId || String(chatIdNum ?? 'default'),
    isCronJob: (context?.metadata as any)?.isCronJob === true,
    discordThreadId: (context?.metadata as any)?.discordThreadId,
    discordChannelId: (context?.metadata as any)?.discordChannelId,
    isDm: (context?.metadata as any)?.isDm === true,
    threadAgentAlias,
    trigger: context?.trigger || 'system',
    agentId,
    delegationDepth: typeof (context?.metadata as any)?.delegationDepth === 'number'
      ? (context?.metadata as any).delegationDepth
      : 0,
  };

  const runTurn = async (): Promise<string> => {
    if (context?.abortSignal?.aborted) {
      throw new Error('Agent turn cancelled');
    }

    if (toolConfig?.enabled) {
      // Provider-specific routing is centralized in providers/chatWithTools.
      console.log(
        `[agent] Running with tools (provider: ${provider}, model: ${modelId}, paths: ${(toolConfig.allowedPaths ?? []).join(', ')})`
      );
      const result = await chatWithTools(messages, chatOptions, config, toolConfig, toolCtx);
      response = result.response;
      toolCalls = result.toolCalls;
    } else {
      response = await chat(messages, chatOptions, config);
    }

    if (context?.abortSignal?.aborted) {
      throw new Error('Agent turn cancelled');
    }

    try {
      appendToMemory(agentId, formatMemoryEntry(sanitizedMessage, response, toolCalls));
    } catch (err) {
      console.warn(`[agent] Failed to append memory: ${toErrorMessage(err)}`);
    }

    return response;
  };

  if (!isLangfuseEnabled()) {
    try {
      const result = await runTurn();
      await endTrace(auditTraceId, 'ok');
      return result;
    } catch (err) {
      await endTrace(auditTraceId, 'error');
      throw err;
    }
  }

  const lfConfig = getLangfuseConfig();
  const traceName = `agent:${agentId}`;
  const traceInput = { message: sanitizedMessage };
  const traceMetadata = {
    app: LANGFUSE_APP_NAME,
    agentId,
    model: resolvedModel,
    provider,
    toolEnabled: !!toolConfig?.enabled,
    channel: context?.channel,
    ...context?.metadata,
  };
  const langfuseTraceInput = sanitizeLangfusePayload(traceInput);
  const langfuseTraceMetadata = sanitizeLangfusePayload(traceMetadata);

  return startActiveObservation(
    traceName,
    async (agentObs) => {
      updateActiveTrace({
        name: traceName,
        userId: context?.userId,
        sessionId: context?.sessionId,
        input: langfuseTraceInput,
        metadata: langfuseTraceMetadata,
        tags: [...new Set([...(context?.tags || []), LANGFUSE_APP_TAG])],
        environment: lfConfig?.environment,
        release: lfConfig?.release,
      });

      agentObs.update({
        input: langfuseTraceInput,
        metadata: langfuseTraceMetadata,
        environment: lfConfig?.environment,
      });

      try {
        const result = await runTurn();
        agentObs.update({
          output: sanitizeLangfusePayload({ response: result, toolCalls }),
          metadata: { toolCallsCount: toolCalls.length },
        });
        updateActiveTrace({
          output: sanitizeLangfusePayload({ response: result }),
          metadata: { toolCallsCount: toolCalls.length },
        });
        await endTrace(auditTraceId, 'ok');
        return result;
      } catch (err) {
        const errorMessage = toErrorMessage(err);
        const redactedError = redactSecretText(errorMessage);
        agentObs.update({
          level: 'ERROR',
          statusMessage: redactedError,
          output: sanitizeLangfusePayload({ error: redactedError }),
        });
        updateActiveTrace({ output: sanitizeLangfusePayload({ error: redactedError }) });
        await endTrace(auditTraceId, 'error');
        throw err;
      }
    },
    { asType: 'agent' }
  );
}

export function getAgentTemplateContent(agentId: string, templateName: string): string | null {
  if (!TEMPLATE_FILES.includes(templateName)) {
    return null;
  }

  const filePath = join(getAgentDir(agentId), templateName);
  if (!existsSync(filePath)) {
    return null;
  }

  return readFileSync(filePath, 'utf-8');
}

export function saveAgentTemplate(agentId: string, templateName: string, content: string): void {
  if (!TEMPLATE_FILES.includes(templateName)) {
    throw new Error(`Invalid template name: ${templateName}. Must be one of: ${TEMPLATE_FILES.join(', ')}`);
  }

  const filePath = join(getAgentDir(agentId), templateName);
  writeFileSync(filePath, content, 'utf-8');
}
