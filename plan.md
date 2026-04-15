## Review Loop Proposal

SkimpyClaw already has most of the infrastructure needed for a real reviewer/dev/planner loop:

- external code agents and team orchestration in [src/code-agents/](/Users/katre/Sites/skimpyclaw/src/code-agents)
- worktree isolation in [src/code-agents/worktree.ts](/Users/katre/Sites/skimpyclaw/src/code-agents/worktree.ts)
- unified tool loop in [src/providers/tool-loop.ts](/Users/katre/Sites/skimpyclaw/src/providers/tool-loop.ts)
- agent task registry/status tracking in [src/code-agents/registry.ts](/Users/katre/Sites/skimpyclaw/src/code-agents/registry.ts)
- coding-agent tool entrypoints in [src/tools/definitions.ts](/Users/katre/Sites/skimpyclaw/src/tools/definitions.ts)

What is missing is a first-class orchestration pattern for:

- planner creates and updates the plan
- dev agent makes changes
- reviewer checks only the latest delta
- loop repeats until reviewer says clean or planner says blocked

This should be implemented as a thin workflow layer, not as a new low-level runtime.

## Recommended Model

Use three roles:

- `claude-opus` as planner/coordinator
- `claude-sonnet` as reviewer
- `skimpyclaw` as implementer/dev

Define an explicit loop object with state:

- `goal`
- `workdir`
- `base_ref`
- `head_ref`
- `status`: `planning | implementing | reviewing | revising | done | blocked`
- `findings`
- `iteration`
- `last_review_commit`
- `review_notes_path` optional

The loop should run in discrete turns, not as a background watcher.

## Loop Behavior

1. Planner initializes the loop.
2. Dev works on the current findings.
3. Reviewer inspects the diff since `last_review_commit` or against `base_ref`.
4. If findings remain, planner rewrites the next task for dev.
5. Repeat until reviewer returns `no findings`.

This is the same practical loop already used manually, but formalized.

## Best Fit In SkimpyClaw

Add a new top-level tool:

- `run_review_loop`

Input schema:

- `task`
- `workdir`
- `base_ref`
- `planner_agent`
- `reviewer_agent`
- `dev_agent`
- `max_iterations`
- `validate`
- `review_output_path` optional

Output:

- current loop status
- open findings
- changed files
- latest reviewer verdict
- whether the loop is complete

This should be built on top of existing `code_with_agent` / `code_with_team`, not replace them.

## Why A New Tool

This loop has durable semantics that normal team decomposition does not capture:

- reviewer should not help code
- reviewer should check only the latest delta
- planner should convert findings into the next dev task
- the run should stop only when reviewer says clean or loop limit is hit

That is coordination logic, not just prompting.

## Concrete Implementation Shape

Add:

- [src/code-agents/review-loop.ts](/Users/katre/Sites/skimpyclaw/src/code-agents/review-loop.ts)
- [src/__tests__/review-loop.test.ts](/Users/katre/Sites/skimpyclaw/src/__tests__/review-loop.test.ts)

Extend:

- [src/code-agents/types.ts](/Users/katre/Sites/skimpyclaw/src/code-agents/types.ts)
- [src/tools/definitions.ts](/Users/katre/Sites/skimpyclaw/src/tools/definitions.ts)
- [src/code-agents/index.ts](/Users/katre/Sites/skimpyclaw/src/code-agents/index.ts)
- maybe [src/code-agents/orchestrator.ts](/Users/katre/Sites/skimpyclaw/src/code-agents/orchestrator.ts) if you want the flow integrated with team workflows

## Suggested Types

In `src/code-agents/types.ts`, add something like:

```ts
export interface ReviewFinding {
  severity: 'low' | 'medium' | 'high';
  summary: string;
  file?: string;
  line?: number;
  status: 'open' | 'resolved' | 'disputed';
}

export interface ReviewLoopState {
  id: string;
  workdir: string;
  task: string;
  baseRef: string;
  headRef?: string;
  iteration: number;
  maxIterations: number;
  status: 'planning' | 'implementing' | 'reviewing' | 'revising' | 'done' | 'blocked';
  plannerAgent: string;
  reviewerAgent: string;
  devAgent: string;
  findings: ReviewFinding[];
  lastReviewCommit?: string;
  latestSummary?: string;
}
```

## Planner Prompt Contract

Planner should not free-form. It should return structured output:

- summary of current state
- exact next dev task
- whether another review pass is needed
- whether blocked

Example planner contract:

```json
{
  "status": "revising",
  "next_dev_task": "Fix reviewer findings 1 and 2. Do not change unrelated files.",
  "resolved_findings": [],
  "remaining_findings": [],
  "stop": false
}
```

## Reviewer Prompt Contract

Reviewer should return one of only two shapes.

If findings:

```json
{
  "verdict": "changes_requested",
  "findings": [
    {
      "severity": "medium",
      "summary": "register_provider still ...",
      "file": "src/foo.ts",
      "line": 123
    }
  ]
}
```

If clean:

```json
{
  "verdict": "approved",
  "findings": []
}
```

Do not let the reviewer return vague prose as the primary payload. Prose can still be kept in `outputPreview`, but the loop should consume JSON.

## Dev Prompt Contract

Dev should get:

- original goal
- current reviewer findings only
- current branch/worktree
- explicit instruction to modify code and tests
- explicit instruction to report changed files

That keeps the loop tight and avoids planner/reviewer drift.

## State Persistence

Persist review loop state in a local registry, similar to code agent tasks. For example:

- `.skimpyclaw/review-loops/<id>.json`

That gives:

- resumability
- dashboard visibility later
- a `check loop status` tool
- ability to continue after interruption

## Important Design Choice

Do not make the reviewer poll files continuously.

Instead:

- dev finishes a run
- loop automatically triggers reviewer
- reviewer returns structured findings
- planner decides next step
- loop continues

That is safer and simpler than a filesystem watch loop.

## Optional Upgrade

Add a mode where reviewer reviews only:

- `git diff <base_ref>..HEAD`, or
- `git diff <last_review_commit>..HEAD`

This prevents the reviewer from re-litigating old findings every turn.

## Recommended Workflow Name

One of:

- `review_loop`
- `fix_until_clean`
- `review_then_revise`

`fix_until_clean` is the clearest user-facing name.

## Minimal UX

Example user prompt:

```txt
Run fix_until_clean in ~/Sites/jetpack
Planner: claude-opus
Reviewer: claude-sonnet
Dev: skimpyclaw
Base ref: 28b05f9
Task: address review feedback until reviewer approves
```

Then SkimpyClaw drives the iterations and returns status after each wave.

## Role Mapping

Desired mapping:

- `claude-opus`: decomposition, next-step planning, adjudication
- `claude-sonnet`: strict reviewer, findings-first, no implementation
- `skimpyclaw`: implementer and validator

This split is better than using one model for all three jobs because it reduces role contamination.

## What Not To Do

Do not:

- make the reviewer directly edit code
- use `code_with_team` alone as the whole solution
- rely on ad hoc markdown files as the only state
- build a live file watcher first

That would create noisy loops and weak resumability.

## Recommended Phases

Phase 1:

- add `review-loop.ts`
- add a new tool definition
- persist loop state
- use JSON contracts for planner/reviewer
- no dashboard integration yet

Phase 2:

- add dashboard status
- add per-iteration summary rendering
- add `continue loop` / `stop loop`

Phase 3:

- add auto-validation gate after dev pass and before reviewer pass

## Recommendation

The right feature is:

- a new orchestration primitive on top of `code_with_agent`
- persisted loop state
- structured reviewer/planner outputs
- diff-scoped review each iteration

That gives the desired loop without changing the core tool runtime.
