// Subagent system: background task dispatch with concurrency control

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import type { Config, SubagentType, SubagentStatus, SubagentTask, ToolConfig, ChatMessage } from './types.js';
import { runAgentTurn } from './agent.js';
import { getCurrentModel } from './gateway.js';
import { getAgentDir } from './config.js';

const MAX_CONCURRENT = 3;

// Preset configs per agent type
interface SubagentPreset {
  agentId: SubagentType;       // matches the type name, used as agent dir name
  defaultModel: string;        // alias from config.models.aliases
  toolConfig: ToolConfig;
  description: string;
}

const VAULT_PATH = join(homedir(), 'Library/Mobile Documents/iCloud~md~obsidian/Documents/2ndBrain');

const PRESETS: Record<SubagentType, SubagentPreset> = {
  coding: {
    agentId: 'coding',
    defaultModel: 'claude-think',
    toolConfig: {
      enabled: true,
      allowedPaths: [join(homedir(), '.skimpyclaw'), join(homedir(), 'Sites')],
      maxIterations: 100,
      bashTimeout: 30000,
    },
    description: 'Code tasks with broad file + bash access',
  },
  research: {
    agentId: 'research',
    defaultModel: 'claude-think',
    toolConfig: {
      enabled: true,
      allowedPaths: [join(homedir(), '.skimpyclaw'), VAULT_PATH],
      maxIterations: 50,
      bashTimeout: 15000,
    },
    description: 'Research with vault access for notes',
  },
  general: {
    agentId: 'general',
    defaultModel: '',  // uses current model
    toolConfig: {
      enabled: true,
      allowedPaths: [join(homedir(), '.skimpyclaw')],
      maxIterations: 100,
      bashTimeout: 15000,
    },
    description: 'General tasks with config access',
  },
};

// --- Starter Templates ---

const STARTER_TEMPLATES: Record<SubagentType, { identity: string; tools: string }> = {
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
`,
  },
  research: {
    identity: `# IDENTITY.md - Research Subagent

Name: Research Agent
Emoji: 🔍

You are a research subagent dispatched for a specific task. You have access to the
Obsidian vault and config files.

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
- Obsidian vault: ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/2ndBrain
- Daily notes: {vault}/2. Areas/Daily Notes/MM-DD-YYYY.md
- Daily digests: {vault}/2. Areas/Daily Digests/MM-DD-YYYY.md
- Reading tracker: {vault}/1. Projects/Reading.md
- Config: ~/.skimpyclaw/config.json
- Agent templates: ~/.skimpyclaw/agents/

({vault} = ${VAULT_PATH})

## Vault Workflows

When you need vault-specific instructions, read the vault's CLAUDE.md:
\`Read({ file_path: "${VAULT_PATH}/CLAUDE.md" })\`
`,
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
`,
  },
};

// Agent identity metadata for in-memory registration
const AGENT_IDENTITIES: Record<SubagentType, { name: string; emoji: string }> = {
  coding: { name: 'Coding Agent', emoji: '🔧' },
  research: { name: 'Research Agent', emoji: '🔍' },
  general: { name: 'General Agent', emoji: '🦞' },
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
      thinking: 'medium',
    };
    console.log(`[subagent] Registered agent in config: ${preset.agentId}`);
  }
}

// Task tracking
let taskCounter = 0;
const tasks = new Map<string, SubagentTask>();
let deliverMessage: ((chatId: number, message: string) => Promise<void>) | null = null;

export function initSubagentSystem(deliverFn: (chatId: number, message: string) => Promise<void>): void {
  deliverMessage = deliverFn;
  console.log('[subagent] System initialized');
}

export function getPresetDescriptions(): string {
  return Object.entries(PRESETS)
    .map(([type, preset]) => `  ${type} — ${preset.description} (default: ${preset.defaultModel || 'current model'})`)
    .join('\n');
}

export function dispatchSubagent(
  type: SubagentType,
  prompt: string,
  chatId: number,
  config: Config,
  modelOverride?: string,
  history?: ChatMessage[]
): SubagentTask {
  const running = [...tasks.values()].filter(t => t.status === 'running');
  if (running.length >= MAX_CONCURRENT) {
    throw new Error(`Max concurrent agents reached (${MAX_CONCURRENT}). Use /tasks to see running agents or /cancel to stop one.`);
  }

  const preset = PRESETS[type];
  if (!preset) {
    throw new Error(`Unknown agent type: ${type}. Use: ${Object.keys(PRESETS).join(', ')}`);
  }

  taskCounter++;
  const id = `t${taskCounter}`;
  const model = modelOverride || preset.defaultModel || getCurrentModel();

  const task: SubagentTask = {
    id,
    type,
    prompt,
    status: 'pending',
    chatId,
    model,
    createdAt: new Date(),
    abortController: new AbortController(),
  };

  tasks.set(id, task);

  // Fire and forget — don't await
  executeTask(task, config, history).catch(err => {
    console.error(`[subagent] Unhandled error in task ${id}:`, err);
  });

  return task;
}

async function executeTask(task: SubagentTask, config: Config, history?: ChatMessage[]): Promise<void> {
  task.status = 'running';
  task.startedAt = new Date();
  console.log(`[subagent] Starting ${task.id} (${task.type}, model: ${task.model})`);

  try {
    // Check cancellation before starting
    if (task.abortController.signal.aborted) {
      task.status = 'cancelled';
      task.completedAt = new Date();
      return;
    }

    const preset = PRESETS[task.type];

    // Ensure agent dir + templates exist, register in config
    ensureAgentSetup(task.type, config);

    const response = await runAgentTurn(
      preset.agentId,
      task.prompt,
      config,
      task.model,
      preset.toolConfig,
      history
    );

    // Check cancellation after completion
    if (task.abortController.signal.aborted) {
      task.status = 'cancelled';
      task.completedAt = new Date();
      return;
    }

    task.status = 'completed';
    task.result = response;
    task.completedAt = new Date();

    const elapsed = Math.round((task.completedAt.getTime() - task.startedAt!.getTime()) / 1000);
    console.log(`[subagent] Completed ${task.id} in ${elapsed}s`);

    // Deliver result
    if (deliverMessage) {
      const header = `✅ Agent ${task.id} (${task.type}) completed in ${elapsed}s:`;
      await deliverMessage(task.chatId, `${header}\n\n${response}`);
    }
  } catch (error) {
    task.status = 'failed';
    task.error = error instanceof Error ? error.message : 'Unknown error';
    task.completedAt = new Date();

    const elapsed = Math.round((task.completedAt.getTime() - (task.startedAt?.getTime() || task.createdAt.getTime())) / 1000);
    console.error(`[subagent] Failed ${task.id} after ${elapsed}s:`, task.error);

    if (deliverMessage) {
      await deliverMessage(task.chatId, `❌ Agent ${task.id} (${task.type}) failed after ${elapsed}s:\n\n${task.error}`);
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
  console.log(`[subagent] Cancelled ${task.id}`);
  return task;
}

export function getActiveTasks(): SubagentTask[] {
  return [...tasks.values()].filter(t => t.status === 'pending' || t.status === 'running');
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
