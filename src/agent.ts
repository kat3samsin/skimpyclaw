// Agent runner: loads templates, calls models, manages memory

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getAgentDir } from './config.js';
import { buildSafeSystemPrompt, sanitizeUserInput } from './security.js';
import type { Config, ChatMessage, ChatOptions, ToolConfig, AgentRunContext, ContentBlock } from './types.js';
import { getToolDefinitions, type ExecuteToolContext } from './tools.js';
import { startTrace, endTrace } from './audit.js';
import { loadSkills, getSkillsForContext, formatSkillsPrompt } from './skills.js';
import type { SkillConfig } from './skills-types.js';
import { getLangfuseConfig, isLangfuseEnabled } from './langfuse.js';
import { startActiveObservation, updateActiveTrace } from '@langfuse/tracing';
import { TTLCache } from './cache.js';

// Import from providers module
import {
  initProviders,
  chat,
  chatWithTools,
  setUsingOAuth,
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

export const TEMPLATE_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'BOOT.md', 'HEARTBEAT.md', 'MEMORY.md'];

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
    skillsSection = formatSkillsPrompt(contextSkills, skillsContext?.skillConfig?.maxPromptTokens);
  }

  const base = [soul, identity, tools, skillsSection].filter(Boolean).join('\n\n---\n\n');
  const userContext = [user, memory].filter(Boolean).join('\n\n');

  const prompt = buildSafeSystemPrompt(base, userContext);

  return prompt;
}

// --- Memory Management ---

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
    mkdirSync(memoryDir, { recursive: true });
  }

  const path = getTodayMemoryPath(agentId);
  const timestamp = new Date().toISOString();
  const content = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const newContent = content + `\n## ${timestamp}\n\n${entry}\n`;
  writeFileSync(path, newContent.trim() + '\n');
}

// --- Agent Turn ---

// Langfuse app tagging
const LANGFUSE_APP_NAME = 'skimpyclaw';
const LANGFUSE_APP_TAG = 'app:skimpyclaw';

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
      telegram: `\n\n## Output Channel: Telegram\nTelegram does NOT render markdown. Use plain text only.\n- No **bold**, _italic_, or \`code blocks\`\n- Use CAPS or spacing for emphasis\n- Use plain dashes for lists\n- Include full URLs as plain text (no markdown links)`,
      discord: `\n\n## Output Channel: Discord\nDiscord renders markdown. Use it for formatting.\n- Use **bold**, *italic*, \`code\`, and \`\`\`code blocks\`\`\`\n- Use markdown links: [text](url)\n- Use bullet lists and headers`,
    };
    systemPrompt += channelHints[context.channel] || '';
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
  const chatOptions: ChatOptions = { model, thinking: agentConfig.thinking };

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
    lockTaskId: context?.sessionId,
    auditTraceId,
    channel: context?.channel,
    channelTargetId,
    approverUserId: context?.userId,
    approverUsername: (context?.metadata as any)?.username,
    sandboxConfig: config.sandbox,
    sessionId: context?.sessionId || String(chatIdNum ?? 'default'),
    isCronJob: (context?.metadata as any)?.isCronJob === true,
  };

  const runTurn = async (): Promise<string> => {
    if (toolConfig?.enabled) {
      // Provider-specific routing is centralized in providers/chatWithTools.
      console.log(
        `[agent] Running with tools (provider: ${provider}, model: ${modelId}, paths: ${toolConfig.allowedPaths.join(', ')})`
      );
      const result = await chatWithTools(messages, chatOptions, config, toolConfig, toolCtx);
      response = result.response;
      toolCalls = result.toolCalls;
    } else {
      response = await chat(messages, chatOptions, config);
    }

    // Log to memory with tool usage summary
    let memoryEntry = `**User:** ${sanitizedMessage}\n\n`;
    if (toolCalls.length > 0) {
      memoryEntry += `**Tools used (${toolCalls.length}):**\n${toolCalls.map(t => `- ${t}`).join('\n')}\n\n`;
    }
    memoryEntry += `**Assistant:** ${response}`;
    appendToMemory(agentId, memoryEntry);

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

  return startActiveObservation(
    traceName,
    async (agentObs) => {
      updateActiveTrace({
        name: traceName,
        userId: context?.userId,
        sessionId: context?.sessionId,
        input: traceInput,
        metadata: traceMetadata,
        tags: [...new Set([...(context?.tags || []), LANGFUSE_APP_TAG])],
        environment: lfConfig?.environment,
        release: lfConfig?.release,
      });

      agentObs.update({
        input: traceInput,
        metadata: traceMetadata,
        environment: lfConfig?.environment,
      });

      try {
        const result = await runTurn();
        agentObs.update({
          output: { response: result, toolCalls },
          metadata: { toolCallsCount: toolCalls.length },
        });
        updateActiveTrace({
          output: { response: result },
          metadata: { toolCallsCount: toolCalls.length },
        });
        await endTrace(auditTraceId, 'ok');
        return result;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        agentObs.update({
          level: 'ERROR',
          statusMessage: errorMessage,
          output: { error: errorMessage },
        });
        updateActiveTrace({ output: { error: errorMessage } });
        await endTrace(auditTraceId, 'error');
        throw err;
      }
    },
    { asType: 'agent' }
  );
}

// --- Bootstrap Check ---

export function hasBootstrap(agentId: string): boolean {
  const path = join(getAgentDir(agentId), 'BOOTSTRAP.md');
  return existsSync(path);
}

export function deleteBootstrap(agentId: string): void {
  const path = join(getAgentDir(agentId), 'BOOTSTRAP.md');
  if (existsSync(path)) {
    unlinkSync(path);
  }
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
