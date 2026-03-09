# Discord Update Documentation Process

Use this checklist whenever Discord behavior changes (message posting, command behavior, thread routing, approvals, or proactive alerts).

## Scope

A "Discord update" includes:

- Changes in `src/channels/discord/*` that alter user-visible behavior
- Changes to code-agent Discord thread notifications (`src/code-agents/utils.ts`)
- Changes to Discord-related configuration fields (`channels.discord.*`)

## Canonical Workflow Source

Implementation lives in:

- `src/channels/discord/index.ts` (startup, proactive sends, approval event wiring)
- `src/channels/discord/handlers.ts` (commands, incoming message handling, approvals)
- `src/channels/discord/threads.ts` (thread creation + thread message routing)
- `src/channels/discord/utils.ts` (chunking, context, help text, history helpers)
- `src/code-agents/utils.ts` (task completion notifications + Discord thread fallback)

## Required Documentation Updates

When Discord behavior changes, update these docs in the same PR:

1. `docs/guide/chat-commands.md`
2. `docs/guide/configuration.md` (if any config flag/key changed)
3. `docs/guide/changelog.md` (add/update an entry under `## Unreleased`)
4. `README.md` only if public-facing capabilities or doc links changed

## Changelog Entry Format

Add one bullet under `## Unreleased` in `docs/guide/changelog.md`:

- `Discord:` short summary of behavior change, affected config (if any), and fallback behavior

Example:

- `Discord: code-agent status updates now prefer task threads and fall back to active channel proactive messages when thread delivery fails.`

## Validation Checklist

Before merging Discord workflow changes:

1. `pnpm build`
2. `pnpm test`
3. `pnpm lint`
