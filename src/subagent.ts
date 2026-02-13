// Subagent system: background task dispatch with concurrency control

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import type {
  Config,
  SubagentType,
  SubagentStatus,
  SubagentTask,
  ToolConfig,
  ChatMessage
} from './types.js';
import { runAgentTurn } from './agent.js';
import { getCurrentModel } from './gateway.js';
import { getAgentDir } from './config.js';
import { releaseAllLocks } from './file-lock.js';

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_MAX_RETRIES = 2;
const REGISTRY_PATH = join(homedir(), '.skimpyclaw', 'logs', 'subagent-runs.jsonl');

// Preset configs per agent type
interface SubagentPreset {
  agentId: SubagentType; // matches the type name, used as agent dir name
  defaultModel: string; // alias from config.models.aliases
  toolConfig: ToolConfig;
  description: string;
}

const PRESETS: Record<SubagentType, SubagentPreset> = {
  coding: {
    agentId: 'coding',
    defaultModel: 'claude-opus',
    toolConfig: {
      enabled: true,
      allowedPaths: [join(homedir(), '.skimpyclaw')],
      maxIterations: 100,
      bashTimeout: 30000
    },
    description: 'Code tasks with broad file + bash access'
  },
  research: {
    agentId: 'research',
    defaultModel: 'claude-think',
    toolConfig: {
      enabled: true,
      allowedPaths: [join(homedir(), '.skimpyclaw')],
      maxIterations: 50,
      bashTimeout: 15000
    },
    description: 'Research tasks with configurable file access'
  },
  general: {
    agentId: 'general',
    defaultModel: '', // uses current model
    toolConfig: {
      enabled: true,
      allowedPaths: [join(homedir(), '.skimpyclaw')],
      maxIterations: 100,
      bashTimeout: 15000
    },
    description: 'General tasks with config access'
  }
};

// --- Starter Templates ---

const STARTER_TEMPLATES: Record<
  SubagentType,
  { identity: string; tools: string }
> = {
  coding: {
    identity: `# IDENTITY.md - Coding Subagent

Name: Coding Agent
Emoji: 🔧

You are a coding subagent dispatched for a specific task. You have file and bash access
across ~/.skimpyclaw and ~/Sites.

## Your Role
- Execute coding tasks: write code, fix bugs, refactor, run commands
- Act on instructions directly — don't narrate what you're going to do
- Return concise results when done

## Your Limitations
- You are short-lived: complete the task and return the result
- You have ONLY 4 tools: Read, Write, Glob, Bash
- Do NOT invent or hallucinate tools that don't exist
`,
    tools: `# TOOLS.md - Coding Subagent Tools

## CRITICAL: Act, Don't Narrate

**NEVER say "let me write the code" or "now I'll update the file" — just call the tool.**
You have a LIMITED number of tool iterations. Every message you spend talking about what
you're going to do is one less chance to actually do it.

## Your 4 Tools

### Read
Read the contents of a file. Parameter: \`file_path\` (string, required)

### Write
Write content to a file. Parameters: \`file_path\` (string, required), \`content\` (string, required)

### Glob
List files and directories at a path. Parameter: \`path\` (string, required)

### Bash
Execute a shell command. Parameters: \`command\` (string, required), \`cwd\` (string, optional)

## Key Paths
- Config: ~/.skimpyclaw/config.json
- Agent templates: ~/.skimpyclaw/agents/
- Sites: ~/Sites/
`
  },
  research: {
    identity: `# IDENTITY.md - Research Subagent

Name: Research Agent
Emoji: 🔍

You are a research subagent dispatched for a specific task.

## Your Role
- Research questions using vault notes and files
- Summarize findings concisely
- Act on instructions directly — don't narrate what you're going to do

## Your Limitations
- You are short-lived: complete the task and return the result
- You have ONLY 4 tools: Read, Write, Glob, Bash
- Do NOT invent or hallucinate tools that don't exist
`,
    tools: `# TOOLS.md - Research Subagent Tools

## CRITICAL: Act, Don't Narrate

**NEVER say "let me check" or "I'll look into that" — just call the tool.**

## Your 4 Tools

### Read
Read the contents of a file. Parameter: \`file_path\` (string, required)

### Write
Write content to a file. Parameters: \`file_path\` (string, required), \`content\` (string, required)

### Glob
List files and directories at a path. Parameter: \`path\` (string, required)

### Bash
Execute a shell command. Parameters: \`command\` (string, required), \`cwd\` (string, optional)

## Key Paths
- Config: ~/.skimpyclaw/config.json
- Agent templates: ~/.skimpyclaw/agents/
- Add your notes/vault paths to allowedPaths in config before using them
`
  },
  general: {
    identity: `# IDENTITY.md - General Subagent

Name: General Agent
Emoji: 🦞

You are a general-purpose subagent dispatched for a specific task.

## Your Role
- Handle miscellaneous tasks that don't fit coding or research
- Act on instructions directly — don't narrate what you're going to do
- Return concise results when done

## Your Limitations
- You are short-lived: complete the task and return the result
- You have ONLY 4 tools: Read, Write, Glob, Bash
- Do NOT invent or hallucinate tools that don't exist
`,
    tools: `# TOOLS.md - General Subagent Tools

## CRITICAL: Act, Don't Narrate

**NEVER say "let me check" or "I'll look into that" — just call the tool.**

## Your 4 Tools

### Read
Read the contents of a file. Parameter: \`file_path\` (string, required)

### Write
Write content to a file. Parameters: \`file_path\` (string, required), \`content\` (string, required)

### Glob
List files and directories at a path. Parameter: \`path\` (string, required)

### Bash
Execute a shell command. Parameters: \`command\` (string, required), \`cwd\` (string, optional)

## Key Paths
- Config: ~/.skimpyclaw/config.json
- Agent templates: ~/.skimpyclaw/agents/
`
  }
};

// Agent identity metadata for in-memory registration
const AGENT_IDENTITIES: Record<SubagentType, { name: string; emoji: string }> =
  {
    coding: { name: 'Coding Agent', emoji: '🔧' },
    research: { name: 'Research Agent', emoji: '🔍' },
    general: { name: 'General Agent', emoji: '🦞' }
  };

/**
 * Ensure agent directory and templates exist for a subagent type.
 * Creates the dir + starter IDENTITY.md + TOOLS.md if missing.
 * Registers the agent in config.agents.list (in-memory only).
 */
export function ensureAgentSetup(type: SubagentType, config: Config): void {
  const preset = PRESETS[type];
  const agentDir = getAgentDir(preset.agentId);

  // Create dir + starter templates if missing
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true });
    const templates = STARTER_TEMPLATES[type];
    writeFileSync(join(agentDir, 'IDENTITY.md'), templates.identity, 'utf-8');
    writeFileSync(join(agentDir, 'TOOLS.md'), templates.tools, 'utf-8');
    console.log(`[subagent] Created agent dir with templates: ${agentDir}`);
  }

  // Register in config.agents.list if not already there (in-memory only)
  if (!config.agents.list[preset.agentId]) {
    const identity = AGENT_IDENTITIES[type];
    config.agents.list[preset.agentId] = {
      identity,
      model: preset.defaultModel || 'anthropic/claude-sonnet-4-5',
      thinking: 'medium'
    };
    console.log(`[subagent] Registered agent in config: ${preset.agentId}`);
  }
}

// Task tracking
let taskCounter = 0;
const tasks = new Map<string, SubagentTask>();
let deliverMessage:
  | ((chatId: number, message: string) => Promise<void>)
  | null = null;

export function initSubagentSystem(
  deliverFn: (chatId: number, message: string) => Promise<void>
): void {
  deliverMessage = deliverFn;
  console.log('[subagent] System initialized');
}

export function getPresetDescriptions(): string {
  return Object.entries(PRESETS)
    .map(
      ([type, preset]) =>
        `  ${type} — ${preset.description} (default: ${preset.defaultModel || 'current model'})`
    )
    .join('\n');
}

// --- Disk Registry ---

function ensureRegistryDir(): void {
  const dir = join(homedir(), '.skimpyclaw', 'logs');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function appendRegistryEvent(event: Record<string, unknown>): void {
  try {
    ensureRegistryDir();
    const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + '\n';
    appendFileSync(REGISTRY_PATH, line, 'utf-8');
  } catch (err) {
    console.warn('[subagent] Failed to write registry event:', err instanceof Error ? err.message : err);
  }
}

// --- Dispatch ---

export function dispatchSubagent(
  type: SubagentType,
  prompt: string,
  chatId: number,
  config: Config,
  modelOverride?: string,
  history?: ChatMessage[],
  options?: {
    label?: string;
    allowedPaths?: string[];
    maxRetries?: number;
  }
): SubagentTask {
  const maxConcurrent = config.subagents?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const active = [...tasks.values()].filter((t) => t.status === 'running' || t.status === 'pending');
  if (active.length >= maxConcurrent) {
    throw new Error(
      `Max concurrent agents reached (${maxConcurrent}). Use /tasks to see running agents or /cancel to stop one.`
    );
  }

  const preset = PRESETS[type];
  if (!preset) {
    throw new Error(
      `Unknown agent type: ${type}. Use: ${Object.keys(PRESETS).join(', ')}`
    );
  }

  taskCounter++;
  const id = `t${taskCounter}`;
  const model = modelOverride || preset.defaultModel || getCurrentModel();
  const maxRetries = options?.maxRetries ?? config.subagents?.maxRetries ?? DEFAULT_MAX_RETRIES;

  const task: SubagentTask = {
    id,
    type,
    prompt,
    status: 'pending',
    chatId,
    model,
    label: options?.label,
    createdAt: new Date(),
    retryCount: 0,
    maxRetries,
    abortController: new AbortController()
  };

  tasks.set(id, task);

  // Log to disk registry
  appendRegistryEvent({
    type: 'task_created',
    taskId: id,
    agentType: type,
    model,
    label: options?.label,
    prompt: prompt.slice(0, 500),
  });

  // Build tool config with merged paths
  const toolConfig: ToolConfig = {
    ...preset.toolConfig,
    allowedPaths: [
      ...preset.toolConfig.allowedPaths,
      ...(options?.allowedPaths || []),
    ],
  };

  // Fire and forget — don't await
  executeTask(task, config, toolConfig, history).catch((err) => {
    console.error(`[subagent] Unhandled error in task ${id}:`, err);
  });

  return task;
}

async function executeTask(
  task: SubagentTask,
  config: Config,
  toolConfig: ToolConfig,
  history?: ChatMessage[]
): Promise<void> {
  task.status = 'running';
  task.startedAt = new Date();
  const label = task.label ? ` "${task.label}"` : '';
  console.log(
    `[subagent] Starting ${task.id}${label} (${task.type}, model: ${task.model})`
  );

  try {
    // Check cancellation before starting
    if (task.abortController.signal.aborted) {
      task.status = 'cancelled';
      task.completedAt = new Date();
      appendRegistryEvent({ type: 'task_cancelled', taskId: task.id });
      return;
    }

    // Ensure agent dir + templates exist, register in config
    ensureAgentSetup(task.type, config);

    const response = await runAgentTurn(
      task.type, // agentId = preset.agentId = type name
      task.prompt,
      config,
      task.model,
      toolConfig,
      history,
      {
        channel: 'subagent',
        sessionId: task.id,
        metadata: {
          type: task.type,
          chatId: task.chatId,
          label: task.label,
        },
        abortSignal: task.abortController.signal,
      }
    );

    // Check cancellation after completion
    if (task.abortController.signal.aborted) {
      task.status = 'cancelled';
      task.completedAt = new Date();
      releaseAllLocks(task.id);
      appendRegistryEvent({ type: 'task_cancelled', taskId: task.id });
      return;
    }

    task.status = 'completed';
    task.result = response;
    task.completedAt = new Date();

    // Release any file locks held by this task
    releaseAllLocks(task.id);

    const elapsed = Math.round(
      (task.completedAt.getTime() - task.startedAt!.getTime()) / 1000
    );
    console.log(`[subagent] Completed ${task.id}${label} in ${elapsed}s`);

    appendRegistryEvent({
      type: 'task_completed',
      taskId: task.id,
      elapsed,
      resultLength: response.length,
    });

    // Deliver result
    if (deliverMessage) {
      const labelStr = task.label ? ` (${task.label})` : '';
      const header = `✅ Agent ${task.id}${labelStr} completed in ${elapsed}s:`;
      await deliverMessage(task.chatId, `${header}\n\n${response}`);
    }
  } catch (error) {
    // Release any file locks on error
    releaseAllLocks(task.id);

    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    const retryCount = task.retryCount ?? 0;
    const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES;

    // Retry if under limit and not cancelled
    if (retryCount < maxRetries && !task.abortController.signal.aborted) {
      task.retryCount = retryCount + 1;
      const elapsed = Math.round(
        (Date.now() - (task.startedAt?.getTime() || task.createdAt.getTime())) / 1000
      );
      console.log(
        `[subagent] Task ${task.id} failed after ${elapsed}s (attempt ${retryCount + 1}/${maxRetries + 1}), retrying: ${errorMsg}`
      );

      appendRegistryEvent({
        type: 'task_retry',
        taskId: task.id,
        attempt: task.retryCount,
        error: errorMsg,
      });

      if (deliverMessage) {
        await deliverMessage(
          task.chatId,
          `⚠️ Agent ${task.id} failed (attempt ${retryCount + 1}/${maxRetries + 1}), retrying...\n\nError: ${errorMsg}`
        );
      }

      // Modify prompt to include error context for retry
      const retryPrompt = `${task.prompt}\n\n---\nPrevious attempt failed with error: ${errorMsg}\nPlease try a different approach.`;
      task.prompt = retryPrompt;
      task.startedAt = new Date();

      // Retry
      return executeTask(task, config, {
        ...PRESETS[task.type].toolConfig,
      }, history);
    }

    task.status = 'failed';
    task.error = errorMsg;
    task.completedAt = new Date();

    const elapsed = Math.round(
      (task.completedAt.getTime() -
        (task.startedAt?.getTime() || task.createdAt.getTime())) /
        1000
    );
    console.error(
      `[subagent] Failed ${task.id} after ${elapsed}s (all retries exhausted):`,
      task.error
    );

    appendRegistryEvent({
      type: 'task_failed',
      taskId: task.id,
      elapsed,
      error: task.error,
    });

    if (deliverMessage) {
      await deliverMessage(
        task.chatId,
        `❌ Agent ${task.id} (${task.type}) failed after ${elapsed}s:\n\n${task.error}`
      );
    }
  }
}

export function cancelTask(id: string): SubagentTask | null {
  const task = tasks.get(id);
  if (!task) return null;
  if (task.status !== 'pending' && task.status !== 'running') return task;

  task.abortController.abort();
  task.status = 'cancelled';
  task.completedAt = new Date();
  releaseAllLocks(task.id);
  appendRegistryEvent({ type: 'task_cancelled', taskId: task.id });
  console.log(`[subagent] Cancelled ${task.id}`);
  return task;
}

export function getActiveTasks(): SubagentTask[] {
  return [...tasks.values()].filter(
    (t) => t.status === 'pending' || t.status === 'running'
  );
}

export function getRecentTasks(n: number = 10): SubagentTask[] {
  return [...tasks.values()]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, n);
}

export function getTask(id: string): SubagentTask | null {
  return tasks.get(id) || null;
}

// For testing
export function resetForTesting(): void {
  taskCounter = 0;
  tasks.clear();
  deliverMessage = null;
}
