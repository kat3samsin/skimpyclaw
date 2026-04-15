# Work UI Design — Review Loop Dashboard

**Date:** 2026-04-14
**Status:** Approved (design), pending implementation plan
**Related:** `plan.md` (Review Loop Proposal)

## Purpose

Dashboard interface for the planner → dev → reviewer review-loop orchestrator described in `plan.md`. Lets Katrina create a new "work item," watch the planner produce a plan, approve or refine it via chat, and then monitor the autonomous dev↔reviewer cycle until the reviewer returns clean (or the iteration cap is hit, or it gets blocked).

Terminology: user-facing items are **work** (sidebar entry: **Work**, items: **work items**, IDs: `RL-###`). Internally, implementation code and plan docs may still use "review loop" — the UI layer translates.

## Scope

**Phase 1 (this spec):**
- New dashboard page at `/dashboard/work`.
- List view with inline "+ New Work" form.
- Master-detail split with chat-primary feed in the detail pane.
- Plan approval gate, chat with planner, Pause/Stop controls.
- Backend API + persisted state under `~/.skimpyclaw/work/`.
- 3s polling (matches Coding page).

**Out of scope (later phases):**
- Overview page stats, cron/remote-trigger wiring, Telegram/Discord integration, diff viewer, per-finding resolve tracking, cost analytics, dashboard-wide search.

## Page Shape

### Routes

- `/dashboard/work` — list view (master pane populated, detail pane empty)
- `/dashboard/work/:id` — list + detail for a specific work item

Master-detail layout renders both panes on the page; the route just selects which detail is loaded. Mobile/narrow viewports collapse to list-only with a drill-down navigation (follow existing dashboard responsive patterns).

### Sidebar Entry

New entry **Work** in the dashboard sidebar. Position: between existing **Coding** and **Digests** entries (adjacent to related agent-execution surfaces).

## List View (Left Pane)

### Header Row

- Title "Work" with count badge (total non-archived items).
- Filter tabs: **All** · **Active** · **Done**. "Active" includes `planning`, `awaiting_approval`, `implementing`, `reviewing`, `revising`, `paused`. "Done" includes `done`, `blocked`, `stopped`.
- "+ **New Work**" button on the right.

### Inline Creation Form

Clicking "+ New Work" toggles an inline form at the top of the list (no modal). Fields:

- **Task prompt** (textarea, required) — free-form description of what the work should accomplish.
- **Workdir** (path input, required) — defaults to the skimpyclaw repo root; accepts absolute paths.
- **Advanced** (collapsible, closed by default):
  - Planner model (default: `claude-opus`)
  - Dev model (default: `skimpyclaw`)
  - Reviewer model (default: `claude-sonnet`)
  - Base ref (default: `HEAD`)
  - Max iterations (default: `5`)

Submit → `POST /api/dashboard/work` → on success, navigate to `/dashboard/work/:id` and auto-open the detail pane.

### List Rows

Each row shows:
- ID (`RL-031`) — monospace, muted
- Title — prose, primary text
- Status pill — color-coded (see Statuses below)
- Iteration `n/max` — e.g. `3/5`
- Findings count — `2 open` (red if open, muted if zero)
- Updated time — relative (`2m ago`)

Selected row: left-border accent (match existing dashboard selection styling).

### Polling

3s interval (matches `Coding.tsx`). Refreshes list + detail simultaneously.

## Detail Pane (Right Pane)

### Header

Sticky at top of detail pane:
- Back chevron (returns to `/dashboard/work`)
- ID (`RL-031`)
- Status pill
- Iteration counter (`iter 3/5`)
- Agent models, inline: `planner: opus · dev: skimpyclaw · reviewer: sonnet`
- **Pause** and **Stop** buttons (right-aligned)

### Feed (Chat-Primary)

Single vertically-scrolling column, newest content at bottom. Contains three entry types interleaved chronologically:

**1. User messages**
Right-aligned bubble, distinct background. Show only the text.

**2. Planner messages**
Left-aligned prose, planner color accent on leading identifier. Markdown-rendered.

**3. Iteration summaries** (collapsed by default)
Compact single-line rows: `iter 2 · dev → 2 files · reviewer → 2 remain`. Click expands inline:
- Changed files list (file paths + LoC delta)
- Reviewer findings for that iteration (file, line, severity, summary)
- Each finding further clickable to expand inline showing suggested fix / reviewer reasoning

**Live activity banner**
When an agent is running (`implementing` or `reviewing` state), a sticky banner appears inline at the bottom of the feed:
- Agent type (dev / reviewer)
- Elapsed seconds
- Last stdout chunk (5KB tail, similar to Coding page)

Banner disappears when the step completes, replaced by a new iteration-summary row.

**Plan approval gate**
The first planner message (after `planning` → `awaiting_approval` transition) renders with two buttons beneath it:
- **Approve** — transitions to `implementing`, dev kicks off
- **Refine via chat** — keeps status `awaiting_approval`; user sends messages; planner produces revised plan

Until approved, no dev work runs.

### Sticky Input

Bottom of detail pane: `Message the planner…` textarea + send button. Works in any state. Messages are appended to planner context and consumed on the next planner invocation (either immediate re-plan if `awaiting_approval`, or merged into the next-iteration task if `revising`/`implementing`).

## States

State machine:

```
planning           -> awaiting_approval
awaiting_approval  -> awaiting_approval | implementing | stopped
implementing       -> reviewing | stopped | paused
reviewing          -> done | revising | stopped | paused
revising           -> implementing | stopped | paused
paused             -> (whatever state it was before) | stopped
done               -> (terminal)
blocked            -> (terminal; reviewer returned unresolvable or max iterations hit)
stopped            -> (terminal; user action)
```

### Status Pill Colors

Matches existing dashboard palette:
- `planning`, `reviewing`, `revising` — blue family (active, non-user-gated)
- `awaiting_approval` — amber (needs user action)
- `implementing` — amber (live execution)
- `paused` — muted grey
- `done` — green
- `blocked` — red
- `stopped` — muted red

## Backend Surface

### REST API (under `/api/dashboard/work`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/work` | List all work items (optionally `?status=active`) |
| POST | `/work` | Create a new work item |
| GET | `/work/:id` | Full detail: header + findings + timeline + chat messages + live activity |
| POST | `/work/:id/chat` | Append a user message; wakes the planner if `awaiting_approval` |
| POST | `/work/:id/approve` | Approve the current plan; transition to `implementing` |
| POST | `/work/:id/pause` | Pause after current agent finishes |
| POST | `/work/:id/resume` | Resume from paused state |
| POST | `/work/:id/stop` | Terminal stop |

All endpoints require Bearer auth (consistent with other `/api/dashboard/*` endpoints).

### Persistence

Storage path: `~/.skimpyclaw/work/<id>.json` (one file per work item). Survives restart. Single source of truth; the UI reads via API, does not cache.

State file shape (initial cut):

```ts
interface WorkItemState {
  id: string;                    // "RL-031"
  title: string;                 // derived from prompt or planner summary
  prompt: string;                // original user prompt
  workdir: string;
  baseRef: string;
  plannerModel: string;
  devModel: string;
  reviewerModel: string;
  maxIterations: number;
  iteration: number;
  status: WorkStatus;            // state enum above
  findings: Finding[];           // open findings only; resolved move into iteration history
  chatMessages: ChatMessage[];   // user ↔ planner
  timeline: TimelineEvent[];     // iteration events: plan, dev-run, reviewer-run, approval
  liveActivity?: LiveActivity;   // current running agent snapshot
  createdAt: string;
  updatedAt: string;
  cost?: number;                 // cumulative
}
```

Exact field shapes for `Finding`, `ChatMessage`, `TimelineEvent`, `LiveActivity` to be defined in the implementation plan alongside the loop engine.

### Execution Engine

New module `src/code-agents/review-loop.ts`. Responsibilities:
- Implements the state machine.
- Dispatches planner/dev/reviewer invocations via existing `runCodeAgentBackground`.
- Persists state to `~/.skimpyclaw/work/<id>.json` on every transition.
- Surfaces live agent stdout via the standard code-agent status file pattern.

The API handlers in `src/api.ts` are thin wrappers that read the state file and call into this engine. No business logic in the HTTP layer.

## Integration Points

- **Sidebar**: new entry in `web/dashboard/src/components/Sidebar.tsx`.
- **Pages**: new file `web/dashboard/src/pages/Work.tsx`.
- **API client**: add typed helpers in `web/dashboard/src/api/client.ts`.
- **Types**: shared types in `web/dashboard/src/types.ts` mirroring the backend state.

## Non-Goals for Phase 1

- No Overview page cards for work items (add later if wanted).
- No Telegram/Discord/CLI trigger wiring (dashboard-only entry point; chat/CLI integration is a later phase).
- No diff viewer (list of changed files with LoC deltas is enough; diff UI is later).
- No cost analytics (cumulative cost shown on detail header only; no dedicated usage breakdown).
- No archive/delete UX (items persist until manually deleted via filesystem).
- No keyboard shortcuts beyond what the existing dashboard provides.

## Open Questions for Implementation Plan

These are implementation-level, not design-level:

1. Exact `Finding` shape — what's the minimum to render usefully vs. what the reviewer returns as JSON.
2. How to structure the timeline event stream so both the feed and future analytics can consume it.
3. Whether the loop engine runs as a long-lived in-process loop or re-enters from a tick function on each poll.
4. Concurrency: max N active work items (probably reuse `subagents.maxConcurrent` or introduce a separate cap).

Implementation plan will resolve these.
