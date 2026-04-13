// Code Agent Orchestrator - Team coordination logic

import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Config } from '../types.js';
import type { ExecuteToolContext } from '../tools/execute-context.js';
import type { CodeAgentTask, DecomposedSubtask, ChildResult } from './types.js';
import { getNextCodeAgentId, storeCodeAgentTask, writeCodeAgentTask, getCodeAgent } from './registry.js';
import { runCodeAgentBackground, runValidation } from './executor.js';
import { notifyCodeAgentResult, resolveModelAlias } from './utils.js';
import { parseAgentOutput, formatStructuredContext } from './structured-context.js';
import { runAgentTurn } from '../agent.js';
import { startTrace, addEvent, endTrace } from '../audit.js';
import { toErrorMessage } from '../utils.js';
import {
  isGitRepo,
  commitPendingChanges,
  createWorktree,
  mergeWorktree,
  removeWorktree,
  cleanupAllWorktrees,
  type WorktreeInfo,
} from './worktree.js';

/**
 * Compute execution waves from dependency info.
 * Returns an array of waves, where each wave is an array of subtask indices that can run in parallel.
 * Throws if there's a cycle in the dependency graph.
 */
export function computeWaves(subtasks: DecomposedSubtask[]): number[][] {
  const n = subtasks.length;
  const assigned = new Array<number>(n).fill(-1);  // wave assignment per subtask
  const waves: number[][] = [];

  // Topological wave assignment
  let remaining = n;
  let waveIdx = 0;
  while (remaining > 0) {
    const wave: number[] = [];
    for (let i = 0; i < n; i++) {
      if (assigned[i] >= 0) continue;  // already assigned
      // Check if all dependencies are satisfied
      const depsOk = subtasks[i].dependsOn.every(d => assigned[d] >= 0);
      if (depsOk) wave.push(i);
    }
    if (wave.length === 0) {
      // Cycle detected — force remaining into current wave
      console.warn('[team] Dependency cycle detected, forcing remaining subtasks into current wave');
      for (let i = 0; i < n; i++) {
        if (assigned[i] < 0) {
          wave.push(i);
        }
      }
    }
    for (const idx of wave) {
      assigned[idx] = waveIdx;
    }
    waves.push(wave);
    remaining -= wave.length;
    waveIdx++;
  }

  return waves;
}

/**
 * Gather lightweight codebase context to improve task decomposition.
 * Returns a short summary of the project structure (file tree, package.json scripts).
 * Capped at ~2000 chars to keep the decomposition prompt small.
 */
export function gatherCodebaseContext(workdir: string): string {
  const parts: string[] = [];

  // Package.json scripts
  try {
    const pkgPath = join(workdir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts) {
        const scriptNames = Object.keys(pkg.scripts).slice(0, 15).join(', ');
        parts.push(`Scripts: ${scriptNames}`);
      }
      if (pkg.dependencies || pkg.devDependencies) {
        const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 20).join(', ');
        parts.push(`Key deps: ${deps}`);
      }
    }
  } catch { /* ignore */ }

  // Source file tree (top-level structure)
  try {
    const tree = execSync(
      'find . -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" | grep -v node_modules | grep -v dist | grep -v .test. | sort | head -60',
      { cwd: workdir, timeout: 5000, encoding: 'utf-8' },
    ).trim();
    if (tree) parts.push(`Source files:\n${tree}`);
  } catch { /* ignore */ }

  const context = parts.join('\n\n');
  return context.slice(0, 2000);
}

/**
 * Compute word-level similarity between two strings (Jaccard index on significant words).
 * Returns 0–1 where 1 means identical word sets.
 */
function wordSimilarity(a: string, b: string): number {
  const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'in', 'of', 'for', 'is', 'it', 'on', 'with', 'that', 'this', 'be', 'as', 'at', 'by', 'from']);
  const tokenize = (s: string) => {
    const words = s.toLowerCase().replace(/[^a-z0-9_\-/.]+/g, ' ').split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w));
    return new Set(words);
  };
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Remove near-duplicate subtasks (>60% word overlap).
 * Keeps the first occurrence, remaps dependsOn indices.
 */
function deduplicateSubtasks(subtasks: DecomposedSubtask[]): DecomposedSubtask[] {
  const SIMILARITY_THRESHOLD = 0.4;
  const kept: number[] = []; // original indices that survived
  for (let i = 0; i < subtasks.length; i++) {
    const isDuplicate = kept.some(k => wordSimilarity(subtasks[k].description, subtasks[i].description) > SIMILARITY_THRESHOLD);
    if (!isDuplicate) kept.push(i);
  }
  if (kept.length === subtasks.length) return subtasks;

  // Build old→new index map
  const indexMap = new Map<number, number>();
  kept.forEach((oldIdx, newIdx) => indexMap.set(oldIdx, newIdx));

  return kept.map(oldIdx => ({
    description: subtasks[oldIdx].description,
    dependsOn: subtasks[oldIdx].dependsOn
      .map(d => indexMap.get(d))
      .filter((d): d is number => d !== undefined),
  }));
}

/**
 * Use a quick model call to decompose a complex task into N subtasks with optional dependency info.
 * Falls back to numbered subtask splitting on parse error.
 * Falls back to all-independent if dependency info is missing or invalid.
 */
export async function decomposeTask(
  task: string,
  teamSize: number,
  config: Config,
  workdir?: string,
): Promise<DecomposedSubtask[]> {
  try {
    // Gather codebase context for smarter decomposition
    const codebaseContext = workdir ? gatherCodebaseContext(workdir) : '';
    const contextBlock = codebaseContext
      ? `\n\nProject structure:\n${codebaseContext}\n`
      : '';

    const prompt = `You are a task decomposition expert. Split the following coding task into up to ${teamSize} subtasks for separate coding agents.

Rules:
- Each subtask MUST do different work — NEVER create multiple subtasks that fix/investigate the same bug or touch the same logic. If the task is a single focused fix, return just 1 subtask.
- Each subtask should be self-contained with clear file scope
- Each parallel agent gets its own git worktree (branch), so file overlap is OK but be aware changes are merged after
- Use dependsOn to order subtasks that must run sequentially (e.g. create interface before implementation)
- Be specific: mention exact files, functions, and expected changes
- Return JSON only: {"subtasks":[{"description":"...","dependsOn":[]},...]}
- Use 0-based indices for dependsOn
- Return FEWER than ${teamSize} subtasks if the task doesn't naturally split into ${teamSize} distinct pieces of work
${contextBlock}
Task: ${task}`;

    const result = await runAgentTurn('main', prompt, config);
    const match = result.match(/\{[\s\S]*"subtasks"[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0) {
        // Handle both new format (objects with dependsOn) and legacy format (plain strings)
        const normalized: DecomposedSubtask[] = parsed.subtasks.map((item: any, _idx: number) => {
          if (typeof item === 'string') {
            return { description: item, dependsOn: [] };
          }
          if (item && typeof item.description === 'string') {
            const deps = Array.isArray(item.dependsOn)
              ? item.dependsOn.filter((d: any) => typeof d === 'number' && d >= 0 && d < parsed.subtasks.length)
              : [];
            return { description: item.description, dependsOn: deps };
          }
          return null;
        }).filter((x: DecomposedSubtask | null): x is DecomposedSubtask => x !== null);

        if (normalized.length > 0) {
          // Remove self-references from dependsOn
          for (let i = 0; i < normalized.length; i++) {
            normalized[i].dependsOn = normalized[i].dependsOn.filter(d => d !== i);
          }
          // Deduplicate: remove subtasks that are too similar to earlier ones
          const deduped = deduplicateSubtasks(normalized);
          if (deduped.length < normalized.length) {
            console.log(`[team] Deduplication: ${normalized.length} → ${deduped.length} subtasks (removed ${normalized.length - deduped.length} near-duplicates)`);
          }
          // Do NOT pad back to teamSize — fewer distinct subtasks is correct
          return deduped;
        }
      }
    }
  } catch (err) {
    console.warn('[team] Task decomposition failed, using fallback:', err instanceof Error ? err.message : err);
  }

  // Fallback: numbered subtask splitting (all independent)
  return Array.from({ length: teamSize }, (_, i) => ({
    description: `Part ${i + 1} of ${teamSize}: ${task}`,
    dependsOn: [],
  }));
}

/**
 * Use a quick model call to synthesize results from multiple subtask completions.
 */
export async function synthesizeResults(
  originalTask: string,
  results: ChildResult[],
  config: Config,
  workdir?: string,
): Promise<string> {
  try {
    const resultSummary = results.map((r, i) => {
      const context = r.output
        ? formatStructuredContext(parseAgentOutput(r.output))
        : '';
      return `### Subtask ${i + 1}: ${r.subtask}\nStatus: ${r.status}\n${context}${r.error ? `\nError: ${r.error}` : ''}`;
    }).join('\n\n');

    // Include actual file changes from git for accuracy
    let diffBlock = '';
    if (workdir) {
      try {
        const diffStat = execSync('git diff --stat HEAD 2>/dev/null || git diff --stat 2>/dev/null', {
          cwd: workdir,
          timeout: 5000,
          encoding: 'utf-8',
        }).trim();
        if (diffStat) diffBlock = `\n\nActual file changes (git diff --stat):\n${diffStat.slice(0, 2000)}`;
      } catch { /* not a git repo or no changes */ }
    }

    const succeeded = results.filter(r => r.status === 'completed').length;
    const failed = results.filter(r => r.status !== 'completed').length;

    const prompt = `You are a results synthesizer. Summarize the results of a multi-agent coding task.

Original task: ${originalTask}

Results from each agent (${succeeded} succeeded, ${failed} failed):
${resultSummary}${diffBlock}

Provide a concise markdown summary of what was accomplished, what succeeded, and what failed (if anything). Be specific about files changed and outcomes.`;

    return await runAgentTurn('main', prompt, config);
  } catch (err) {
    // Fallback: mechanical summary
    const succeeded = results.filter(r => r.status === 'completed').length;
    const failed = results.filter(r => r.status !== 'completed').length;
    return `Team completed: ${succeeded}/${results.length} subtasks succeeded${failed > 0 ? `, ${failed} failed` : ''}.\n\n${results.map((r, i) => `${i + 1}. [${r.status}] ${r.subtask}`).join('\n')}`;
  }
}

/**
 * Team orchestrator — decomposes task, spawns parallel agents, monitors, synthesizes.
 */
export async function runTeamOrchestrator(
  parentId: string,
  task: string,
  teamSize: number,
  workdir: string,
  validate: boolean,
  agent: string,
  model: string | undefined,
  startedAt: Date,
  context?: ExecuteToolContext,
): Promise<void> {
  const parentTask = getCodeAgent(parentId);
  if (!parentTask) {
    throw new Error(`Parent task ${parentId} not found`);
  }

  const scratchpadEnabled = process.env.SKIMPYCLAW_TEAM_SCRATCHPAD !== '0';
  const scratchpadRunId = `team-${parentId}`;
  const scratchpadScript = join(import.meta.dirname, '..', '..', 'scripts', 'team_scratchpad.py');

  function sanitizeScratchpadText(value: string | undefined, maxLen = 240): string {
    if (!value) return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, maxLen);
  }

  function runScratchpadCommand(args: string[]): boolean {
    if (!scratchpadEnabled) return false;
    try {
      const proc = spawnSync('python3', [scratchpadScript, ...args], {
        cwd: workdir,
        encoding: 'utf-8',
        timeout: 15000,
      });
      if (proc.status === 0) return true;
      const stderr = sanitizeScratchpadText(proc.stderr || proc.stdout, 400);
      console.warn(`[team-scratchpad] ${args[0]} failed for ${scratchpadRunId}${stderr ? `: ${stderr}` : ''}`);
      return false;
    } catch (err) {
      console.warn(`[team-scratchpad] ${args[0]} failed for ${scratchpadRunId}:`, err);
      return false;
    }
  }

  function postScratchpadUpdate(input: {
    agent: string;
    phase: string;
    status: 'start' | 'in_progress' | 'blocked' | 'red' | 'green' | 'review' | 'done';
    summary: string;
    next?: string;
    blockers?: string[];
  }): void {
    if (!scratchpadEnabled) return;
    const summary = sanitizeScratchpadText(input.summary, 280);
    if (!summary) return;
    const args = [
      'post',
      '--run-id', scratchpadRunId,
      '--agent', sanitizeScratchpadText(input.agent, 80) || 'unknown-agent',
      '--phase', sanitizeScratchpadText(input.phase, 80) || 'run',
      '--status', input.status,
      '--summary', summary,
    ];
    const blockers = (input.blockers || [])
      .map(b => sanitizeScratchpadText(b, 120))
      .filter(Boolean);
    if (blockers.length > 0) {
      args.push('--blockers', blockers.join(','));
    }
    const next = sanitizeScratchpadText(input.next, 200);
    if (next) {
      args.push('--next', next);
    }
    runScratchpadCommand(args);
  }

  const traceId = startTrace('code_team');
  addEvent(traceId, {
    type: 'spawn',
    summary: `team-coordinator: ${task.slice(0, 150)}`,
    durationMs: 0,
    detail: { teamSize, workdir, agent, model, validate },
  });

  const configTeamTimeout = context?.fullConfig?.codeAgents?.teamTimeoutMinutes ?? 60;
  const timeoutMinutes = Math.min(configTeamTimeout, 120);
  // Reserve budget for overhead (decompose, synthesize, validation) and distribute rest across waves
  const overheadMinutes = 5;
  const availableForChildren = Math.max(timeoutMinutes - overheadMinutes, timeoutMinutes * 0.7);
  const CANCELLED_MESSAGE = 'Cancelled by user';

  // Worktree state — declared outside try so catch can clean up
  const _useWorktrees = isGitRepo(workdir);
  const _activeWorktrees: Map<string, WorktreeInfo> = new Map();

  try {
    if (scratchpadEnabled) {
      let baseBranch = '';
      if (_useWorktrees) {
        try {
          baseBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: workdir,
            timeout: 5000,
            encoding: 'utf-8',
          }).trim();
        } catch { /* best effort */ }
      }
      // Run ID is deterministic (`team-<parent_id>`) so team state can be correlated.
      runScratchpadCommand([
        'init',
        '--run-id', scratchpadRunId,
        '--task', sanitizeScratchpadText(task, 400) || `Team run ${parentId}`,
        '--repo', workdir,
        ...(baseBranch ? ['--base-branch', baseBranch] : []),
      ]);
      postScratchpadUpdate({
        agent: 'team-coordinator',
        phase: 'orchestration',
        status: 'start',
        summary: `Started team run ${parentId} with ${teamSize} workers`,
      });
    }

    if (getCodeAgent(parentId)?.status === 'cancelled') throw new Error(CANCELLED_MESSAGE);
    // Phase 1: Decompose
    parentTask.liveOutput = 'Phase: Decomposing task...';
    writeCodeAgentTask(parentTask);

    const fullConfig = context?.fullConfig;
    if (!fullConfig) throw new Error('No config available for task decomposition');

    const subtasks = await decomposeTask(task, teamSize, fullConfig, workdir);
    const waves = computeWaves(subtasks);
    // Distribute timeout across waves (not team size) for better budgeting
    const perChildTimeout = Math.max(5, Math.floor(availableForChildren / waves.length));
    addEvent(traceId, {
      type: 'decompose',
      summary: `Decomposed into ${subtasks.length} subtasks in ${waves.length} wave(s)`,
      durationMs: Date.now() - startedAt.getTime(),
    });

    // Phase 2: Create child task entries and schedule waves
    const totalWaves = waves.length;

    parentTask.liveOutput = `Phase: Scheduling ${subtasks.length} agents in ${totalWaves} wave(s)...`;
    writeCodeAgentTask(parentTask);
    postScratchpadUpdate({
      agent: 'team-coordinator',
      phase: 'orchestration',
      status: 'in_progress',
      summary: `Decomposed into ${subtasks.length} subtasks across ${totalWaves} wave(s)`,
      next: 'Start wave execution',
    });

    // Create all child tasks upfront (pending for later waves)
    const childIds: string[] = [];
    const childIdByIndex: string[] = [];  // subtask index → child id
    for (let i = 0; i < subtasks.length; i++) {
      const childId = getNextCodeAgentId();
      const waveNum = waves.findIndex(w => w.includes(i));
      const childTask: CodeAgentTask = {
        id: childId,
        agent,
        task: subtasks[i].description,
        status: waveNum === 0 ? 'running' : 'pending',
        chatId: context?.chatId,
        discordThreadId: parentTask.discordThreadId,
        discordChannelId: parentTask.discordChannelId,
        startedAt: new Date().toISOString(),
        workdir,
        model,
        parentTaskId: parentId,
        subtask: subtasks[i].description,
        dependsOn: subtasks[i].dependsOn,
        wave: waveNum,
      };
      storeCodeAgentTask(childTask);
      writeCodeAgentTask(childTask);
      childIds.push(childId);
      childIdByIndex.push(childId);
    }

    parentTask.childTaskIds = childIds;
    writeCodeAgentTask(parentTask);

    // Helper: get git diff summary for context passing between waves
    function getGitDiffSummary(): string {
      try {
        const diff = execSync('git diff --stat HEAD 2>/dev/null || git diff --stat 2>/dev/null', {
          cwd: workdir,
          timeout: 5000,
          encoding: 'utf-8',
        }).trim();
        return diff ? diff.slice(0, 1500) : '';
      } catch {
        return '';
      }
    }

    // Helper: build task prompt with predecessor context for dependent subtasks
    function buildChildPrompt(subtaskIdx: number): string {
      const sub = subtasks[subtaskIdx];
      if (sub.dependsOn.length === 0) return sub.description;

      const contextParts: string[] = [];
      for (const depIdx of sub.dependsOn) {
        const depChild = getCodeAgent(childIdByIndex[depIdx]);
        if (depChild && depChild.outputPreview) {
          // Use the full outputPreview (up to 5000 chars) not just the 500-char summary
          const structured = formatStructuredContext(parseAgentOutput(depChild.outputPreview));
          contextParts.push(`- Task "${subtasks[depIdx].description}" [${depChild.status}]:\n${structured}`);
        }
      }

      // Include git diff to show what predecessor waves actually changed on disk
      const diffSummary = getGitDiffSummary();
      const diffBlock = diffSummary ? `\nFiles changed so far:\n${diffSummary}\n` : '';

      if (contextParts.length === 0 && !diffBlock) return sub.description;

      return `Context from completed prerequisite tasks:\n${contextParts.join('\n')}${diffBlock}\nYour task: ${sub.description}`;
    }

    // Worktree isolation: parallel agents in the same wave get their own worktree
    // so they can't overwrite each other's files. After the wave, branches are
    // merged back sequentially. Falls back to shared workdir if not a git repo.
    const useWorktrees = _useWorktrees;
    const activeWorktrees = _activeWorktrees;

    if (useWorktrees) {
      // Clean up any stale worktrees from previous crashed runs
      cleanupAllWorktrees(workdir);
      addEvent(traceId, {
        type: 'worktree',
        summary: 'Git worktree isolation enabled',
        durationMs: Date.now() - startedAt.getTime(),
      });
    } else {
      console.warn('[code-team] Not a git repo — agents will share workdir (risk of file conflicts)');
    }

    // Phase 3: Execute waves sequentially, tasks within each wave in parallel
    const POLL_INTERVAL = 3000;
    const totalTimeoutMs = timeoutMinutes * 60 * 1000;

    let lastLiveOutput = '';
    const childStatusById = new Map<string, string>();
    const childProgressPosted = new Set<string>();
    for (let waveIdx = 0; waveIdx < totalWaves; waveIdx++) {
      if (getCodeAgent(parentId)?.status === 'cancelled') throw new Error(CANCELLED_MESSAGE);
      const waveIndices = waves[waveIdx];

      addEvent(traceId, {
        type: 'wave_start',
        summary: `Starting wave ${waveIdx + 1}/${totalWaves} (${waveIndices.length} tasks)`,
        durationMs: Date.now() - startedAt.getTime(),
      });
      postScratchpadUpdate({
        agent: 'team-coordinator',
        phase: 'execution',
        status: 'in_progress',
        summary: `Starting wave ${waveIdx + 1}/${totalWaves} with ${waveIndices.length} worker(s)`,
      });

      // Helper: spawn a single child task in the given workdir
      function spawnChild(childId: string, prompt: string, childWorkdir: string) {
        runCodeAgentBackground(
          childId,
          agent,
          prompt,
          childWorkdir,
          false, // per-child validation is handled by the orchestrator below
          { task: prompt, model, timeout_minutes: perChildTimeout },
          new Date(),
          { skipNotification: true, defaultTimeoutMinutes: perChildTimeout, maxTimeoutMinutes: perChildTimeout, validationCommands: fullConfig?.codeAgents?.validationCommands },
        ).catch((err) => {
          const child = getCodeAgent(childId);
          if (child && child.status === 'running') {
            Object.assign(child, {
              status: 'failed',
              endedAt: new Date().toISOString(),
              error: toErrorMessage(err),
            });
            writeCodeAgentTask(child);
          }
          console.error(`[code-team] Child ${childId} background error:`, err);
        });
      }

      // Create worktrees for parallel tasks (waves with >1 child)
      const useWorktreeForWave = useWorktrees && waveIndices.length > 1;
      if (useWorktreeForWave) {
        // Commit any pending changes so worktrees branch from a clean state
        commitPendingChanges(workdir, `[skimpyclaw] pre-wave-${waveIdx + 1}`);

        parentTask.liveOutput = `Phase: Creating worktrees for wave ${waveIdx + 1}...`;
        writeCodeAgentTask(parentTask);
      }

      // Spawn all tasks in this wave
      for (const subtaskIdx of waveIndices) {
        const childId = childIdByIndex[subtaskIdx];
        const child = getCodeAgent(childId)!;
        const prompt = buildChildPrompt(subtaskIdx);

        // Determine workdir for this child
        let childWorkdir = workdir;
        if (useWorktreeForWave) {
          try {
            const wt = createWorktree(workdir, childId);
            activeWorktrees.set(childId, wt);
            childWorkdir = wt.path;
            console.log(`[code-team] Created worktree for ${childId}: ${wt.path} (branch ${wt.branch})`);
          } catch (err) {
            console.error(`[code-team] Failed to create worktree for ${childId}, using shared workdir:`, err);
          }
        }

        child.status = 'running';
        child.task = prompt;
        child.workdir = childWorkdir;
        child.startedAt = new Date().toISOString();
        writeCodeAgentTask(child);
        childStatusById.set(childId, 'running');
        postScratchpadUpdate({
          agent: childId,
          phase: `wave-${waveIdx + 1}`,
          status: 'start',
          summary: sanitizeScratchpadText(subtasks[subtaskIdx].description, 220) || `Started ${childId}`,
        });

        spawnChild(childId, prompt, childWorkdir);
      }

      // Poll until all tasks in this wave complete
      const waveChildIds = waveIndices.map(i => childIdByIndex[i]);

      // Check cancellation after spawning
      if (getCodeAgent(parentId)?.status === 'cancelled') {
        for (const childId of waveChildIds) {
          const child = getCodeAgent(childId);
          if (child && (child.status === 'running' || child.status === 'pending')) {
            Object.assign(child, {
              status: 'cancelled',
              endedAt: new Date().toISOString(),
              error: CANCELLED_MESSAGE,
            });
            writeCodeAgentTask(child);
          }
        }
        throw new Error(CANCELLED_MESSAGE);
      }

      while (true) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        if (getCodeAgent(parentId)?.status === 'cancelled') throw new Error(CANCELLED_MESSAGE);

        const allChildren = childIds.map(id => getCodeAgent(id)!);
        const waveChildren = waveChildIds.map(id => getCodeAgent(id)!);
        const waveDone = waveChildren.filter(c => c.status !== 'running' && c.status !== 'validating').length;

        for (const child of waveChildren) {
          const current = child.status;
          const previous = childStatusById.get(child.id);
          if (current === 'running' && !childProgressPosted.has(child.id)) {
            postScratchpadUpdate({
              agent: child.id,
              phase: `wave-${waveIdx + 1}`,
              status: 'in_progress',
              summary: `In progress: ${(child.subtask || child.task).slice(0, 180)}`,
            });
            childProgressPosted.add(child.id);
          }
          if (previous && previous !== current) {
            const phase = `wave-${waveIdx + 1}`;
            if (current === 'completed') {
              postScratchpadUpdate({
                agent: child.id,
                phase,
                status: 'done',
                summary: `Completed: ${(child.subtask || child.task).slice(0, 180)}`,
              });
            } else if (current === 'failed' || current === 'timeout' || current === 'cancelled') {
              const blocker = sanitizeScratchpadText(child.error || `${current} without error`, 140);
              postScratchpadUpdate({
                agent: child.id,
                phase,
                status: 'blocked',
                summary: `Stopped with ${current}`,
                blockers: blocker ? [blocker] : undefined,
                next: 'Await coordinator retry or follow-up',
              });
            }
          }
          childStatusById.set(child.id, current);
        }

        // Build wave-grouped status display
        const waveStatusLines: string[] = [];
        for (let w = 0; w < totalWaves; w++) {
          const wIndices = waves[w];
          const wChildren = wIndices.map(i => getCodeAgent(childIdByIndex[i])!);
          const wDone = wChildren.every(c => c.status !== 'running' && c.status !== 'validating' && c.status !== 'pending');
          const wRunning = w === waveIdx;
          const wPending = w > waveIdx;
          const wLabel = wDone ? 'done' : wRunning ? 'running' : 'pending';

          const childLines = wChildren.map(c => {
            if (c.status === 'pending') return `  ${c.id} [pending]`;
            const elapsed = Math.round((Date.now() - new Date(c.startedAt).getTime()) / 1000);
            const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`;
            const preview = (c.subtask || c.task).slice(0, 150);
            return `  ${c.id} [${c.status}] (${elapsedStr}): ${preview}`;
          }).join('\n');

          waveStatusLines.push(`Wave ${w + 1} [${wLabel}]:\n${childLines}`);
        }

        const completedWaves = waves.filter((_, w) => w < waveIdx).length;
        const newLiveOutput = `Phase: Running Wave ${waveIdx + 1}/${totalWaves} (${completedWaves}/${totalWaves} complete)\n${waveStatusLines.join('\n')}`;
        if (newLiveOutput !== lastLiveOutput) {
          parentTask.liveOutput = newLiveOutput;
          writeCodeAgentTask(parentTask);
          lastLiveOutput = newLiveOutput;
        }

        if (waveDone === waveChildren.length) break;

        // Check total timeout
        if (Date.now() - startedAt.getTime() > totalTimeoutMs) {
          // Kill all remaining running/pending children
          for (const child of allChildren) {
            if (child.status === 'running' || child.status === 'validating' || child.status === 'pending') {
              Object.assign(child, {
                status: 'timeout',
                endedAt: new Date().toISOString(),
                durationSeconds: Math.round((Date.now() - new Date(child.startedAt).getTime()) / 1000),
                error: 'Parent team timed out',
              });
              writeCodeAgentTask(child);
            }
          }
          // Jump to synthesis
          break;
        }
      }

      // Per-wave validation: run build after each wave to catch breakage early
      if (validate && Date.now() - startedAt.getTime() < totalTimeoutMs) {
        const waveCompleted = waveChildIds.every(id => getCodeAgent(id)?.status === 'completed');
        if (waveCompleted) {
          parentTask.liveOutput = `Phase: Validating wave ${waveIdx + 1}/${totalWaves}...`;
          writeCodeAgentTask(parentTask);

          const { passed, output: valOutput } = await runValidation(workdir, fullConfig?.codeAgents?.validationCommands);
          if (!passed) {
            postScratchpadUpdate({
              agent: 'team-coordinator',
              phase: 'validation',
              status: 'red',
              summary: `Wave ${waveIdx + 1} validation failed; retrying children`,
            });
            addEvent(traceId, {
              type: 'wave_validation',
              summary: `Wave ${waveIdx + 1} validation failed — retrying failed children`,
              durationMs: Date.now() - startedAt.getTime(),
            });

            // Retry each child in this wave once with the validation error context
            const retryChildIds: string[] = [];
            for (const subtaskIdx of waveIndices) {
              const childId = childIdByIndex[subtaskIdx];
              const child = getCodeAgent(childId)!;
              if (child.retryCount) continue; // already retried

              child.retryCount = 1;
              child.status = 'running';
              child.validationOutput = valOutput.slice(0, 4000);
              child.startedAt = new Date().toISOString();
              writeCodeAgentTask(child);

              const retryPrompt = `Fix build/test errors. Your original task: ${subtasks[subtaskIdx].description}\n\nValidation errors:\n${valOutput.slice(0, 4000)}`;
              child.task = retryPrompt;
              writeCodeAgentTask(child);

              spawnChild(childId, retryPrompt, workdir);
              retryChildIds.push(childId);
            }

            // Poll until retries complete
            if (retryChildIds.length > 0) {
              while (true) {
                await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
                if (getCodeAgent(parentId)?.status === 'cancelled') throw new Error(CANCELLED_MESSAGE);

                const retryDone = retryChildIds.every(id => {
                  const c = getCodeAgent(id)!;
                  return c.status !== 'running' && c.status !== 'validating';
                });
                if (retryDone) break;

                if (Date.now() - startedAt.getTime() > totalTimeoutMs) break;
              }

              addEvent(traceId, {
                type: 'wave_retry_complete',
                summary: `Wave ${waveIdx + 1} retry complete`,
                durationMs: Date.now() - startedAt.getTime(),
              });
            }
          } else {
            postScratchpadUpdate({
              agent: 'team-coordinator',
              phase: 'validation',
              status: 'green',
              summary: `Wave ${waveIdx + 1} validation passed`,
            });
            addEvent(traceId, {
              type: 'wave_validation',
              summary: `Wave ${waveIdx + 1} validation passed`,
              durationMs: Date.now() - startedAt.getTime(),
            });
          }
        }
      }

      // Merge worktree branches back into main branch sequentially
      if (useWorktreeForWave && Date.now() - startedAt.getTime() < totalTimeoutMs) {
        parentTask.liveOutput = `Phase: Merging wave ${waveIdx + 1} results...`;
        writeCodeAgentTask(parentTask);

        const mergeErrors: string[] = [];
        for (const subtaskIdx of waveIndices) {
          const childId = childIdByIndex[subtaskIdx];
          const wt = activeWorktrees.get(childId);
          if (!wt) continue;

          const child = getCodeAgent(childId);
          if (!child || child.status !== 'completed') {
            // Don't merge failed/timed-out children
            console.log(`[code-team] Skipping merge for ${childId} (status: ${child?.status})`);
            removeWorktree(workdir, childId, wt.branch);
            activeWorktrees.delete(childId);
            continue;
          }

          // Commit any uncommitted changes in the worktree before merging
          commitPendingChanges(wt.path, `[skimpyclaw] ${childId}: ${subtasks[subtaskIdx].description.slice(0, 60)}`);

          const { merged, conflict } = mergeWorktree(workdir, wt.branch, childId);
          if (merged) {
            console.log(`[code-team] Merged ${childId} (branch ${wt.branch}) successfully`);
            addEvent(traceId, {
              type: 'merge',
              summary: `Merged ${childId} successfully`,
              durationMs: Date.now() - startedAt.getTime(),
            });
          } else {
            const conflictMsg = `Merge conflict for ${childId}: ${conflict}`;
            console.error(`[code-team] ${conflictMsg}`);
            mergeErrors.push(conflictMsg);
            addEvent(traceId, {
              type: 'merge_conflict',
              summary: conflictMsg.slice(0, 200),
              durationMs: Date.now() - startedAt.getTime(),
            });
          }

          // Clean up worktree regardless of merge result
          removeWorktree(workdir, childId, wt.branch);
          activeWorktrees.delete(childId);
        }

        if (mergeErrors.length > 0) {
          const errorMsg = `Merge conflicts in wave ${waveIdx + 1}:\n${mergeErrors.join('\n')}`;
          parentTask.error = (parentTask.error ? parentTask.error + '\n' : '') + errorMsg;
          writeCodeAgentTask(parentTask);
        }
      }

      // If we timed out, don't start more waves
      if (Date.now() - startedAt.getTime() > totalTimeoutMs) break;
    }

    // Phase 4: Collect results and synthesize
    if (getCodeAgent(parentId)?.status === 'cancelled') throw new Error(CANCELLED_MESSAGE);
    parentTask.liveOutput = 'Phase: Synthesizing results...';
    postScratchpadUpdate({
      agent: 'team-coordinator',
      phase: 'synthesis',
      status: 'review',
      summary: 'Synthesizing worker results into final summary',
    });

    // Aggregate cost/tokens from all children into parent
    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let hasCostData = false;
    for (const cid of childIds) {
      const child = getCodeAgent(cid);
      if (child?.totalCost != null) { totalCost += child.totalCost; hasCostData = true; }
      if (child?.inputTokens != null) totalInput += child.inputTokens;
      if (child?.outputTokens != null) totalOutput += child.outputTokens;
    }
    if (hasCostData) {
      parentTask.totalCost = totalCost;
      parentTask.inputTokens = totalInput;
      parentTask.outputTokens = totalOutput;
    }
    writeCodeAgentTask(parentTask);

    const childResults: ChildResult[] = childIds.map(id => {
      const child = getCodeAgent(id)!;
      return {
        subtask: child.subtask || child.task,
        status: child.status,
        output: child.outputPreview,
        error: child.error,
      };
    });

    addEvent(traceId, {
      type: 'synthesize',
      summary: `Synthesizing ${childResults.length} results`,
      durationMs: Date.now() - startedAt.getTime(),
    });

    const synthesis = await synthesizeResults(task, childResults, fullConfig, workdir);
    parentTask.synthesisResult = synthesis;

    // Phase 5: Validation (once, on the combined result)
    if (validate) {
      parentTask.liveOutput = 'Phase: Validating...';
      parentTask.status = 'validating';
      writeCodeAgentTask(parentTask);

      const { passed, output } = await runValidation(workdir, fullConfig?.codeAgents?.validationCommands);
      const endedAt = new Date();
      const duration = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);

      if (!passed) {
        postScratchpadUpdate({
          agent: 'team-coordinator',
          phase: 'validation',
          status: 'red',
          summary: 'Final validation failed',
          blockers: [sanitizeScratchpadText(output, 140) || 'Validation failed'],
        });
        addEvent(traceId, { type: 'validation', summary: 'Team validation failed', durationMs: Date.now() - startedAt.getTime() });
        await endTrace(traceId, 'error');
        Object.assign(parentTask, {
          status: 'failed',
          endedAt: endedAt.toISOString(),
          durationSeconds: duration,
          validationPassed: false,
          validationOutput: output,
          outputPreview: synthesis.slice(0, 5000),
          error: 'Validation failed',
          liveOutput: undefined,
        });
        writeCodeAgentTask(parentTask);
        await notifyCodeAgentResult(parentTask, getCodeAgent);
        return;
      }

      addEvent(traceId, { type: 'validation', summary: 'Team validation passed', durationMs: Date.now() - startedAt.getTime() });
      await endTrace(traceId, 'ok');
      Object.assign(parentTask, {
        status: 'completed',
        endedAt: endedAt.toISOString(),
        durationSeconds: duration,
        validationPassed: true,
        outputPreview: synthesis.slice(0, 5000),
        liveOutput: undefined,
      });
      writeCodeAgentTask(parentTask);
      postScratchpadUpdate({
        agent: 'team-coordinator',
        phase: 'complete',
        status: 'done',
        summary: `Team run ${parentId} completed`,
      });
      await notifyCodeAgentResult(parentTask, getCodeAgent);
      return;
    }

    // No validation — mark complete
    const endedAt = new Date();
    addEvent(traceId, { type: 'complete', summary: 'Team completed (no validation)', durationMs: Date.now() - startedAt.getTime() });
    await endTrace(traceId, 'ok');
    Object.assign(parentTask, {
      status: 'completed',
      endedAt: endedAt.toISOString(),
      durationSeconds: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
      outputPreview: synthesis.slice(0, 5000),
      liveOutput: undefined,
    });
    writeCodeAgentTask(parentTask);
    postScratchpadUpdate({
      agent: 'team-coordinator',
      phase: 'complete',
      status: 'done',
      summary: `Team run ${parentId} completed`,
    });
    await notifyCodeAgentResult(parentTask, getCodeAgent);
  } catch (err) {
    // Clean up any remaining worktrees
    for (const [childId, wt] of _activeWorktrees) {
      try { removeWorktree(workdir, childId, wt.branch); } catch { /* best effort */ }
    }
    _activeWorktrees.clear();
    if (_useWorktrees) {
      try { cleanupAllWorktrees(workdir); } catch { /* best effort */ }
    }

    const errMsg = toErrorMessage(err);
    addEvent(traceId, { type: 'error', summary: errMsg.slice(0, 200), durationMs: Date.now() - startedAt.getTime() });
    await endTrace(traceId, 'error');
    Object.assign(parentTask, {
      status: errMsg.includes(CANCELLED_MESSAGE) || parentTask.status === 'cancelled'
        ? 'cancelled'
        : errMsg.includes('timed out')
          ? 'timeout'
          : 'failed',
      endedAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      error: errMsg,
      liveOutput: undefined,
    });
    writeCodeAgentTask(parentTask);
    postScratchpadUpdate({
      agent: 'team-coordinator',
      phase: 'complete',
      status: 'blocked',
      summary: `Team run ${parentId} ended with ${parentTask.status}`,
      blockers: [sanitizeScratchpadText(errMsg, 140) || 'Team run failed'],
    });
    if (parentTask.status !== 'cancelled') await notifyCodeAgentResult(parentTask, (id) => getCodeAgent(id) ?? null);
  } finally {
    // Best-effort final materialization; never block team completion on scratchpad tooling.
    runScratchpadCommand(['summary', '--run-id', scratchpadRunId]);
    runScratchpadCommand(['render-md', '--run-id', scratchpadRunId]);
  }
}
