# Changelog

All notable documentation and behavior updates should be recorded here.

## Unreleased

- Discord: added a required documentation process for Discord posting/update workflow changes, including update targets in `README.md`, guide pages, and changelog maintenance expectations.
- Discord: cron jobs now support `payload.discordThreadId` to target a specific thread for start/digest/completion notifications, with validation and fallback to active-channel delivery.
- Discord: `code_with_agent` now accepts `interactive: true` to start a bidirectional coding session pinned to a Discord thread. Follow-up messages in the thread are routed directly to `claude --resume` (serialized FIFO per thread); sessions persist across gateway restarts in `~/.skimpyclaw/logs/code-agents/interactive-sessions.json`.
- Newspaper: source URL resolution now goes through a single canonical resolver (`src/newspaper/source-resolution.ts`) that prefers trusted `sourceUrl`, decodes Google News wrappers, and rejects invalid slugs. All three pipeline stages (normalize, storage, editorial-fetch) share the same resolver.
- Newspaper: Chicago timezone handling replaced manual UTC-offset arithmetic with `src/newspaper/time.ts` (`getChicagoHour`, `getChicagoDateString`) using `Intl.DateTimeFormat` for DST-correct results.
- Models: `claude-opus` alias now points at `claude-opus-4-7` (previously `4-6`); applies to `setup.ts`, `api.ts`, `providers/utils.ts` migration, and the `opus` shorthand in `code-agents/utils.ts`.
- Interactive sessions: fixed a correctness bug where a subprocess error would strand queued follow-up messages in memory; the queue is now drained with a single notice when the session errors.
- Interactive sessions: shared `buildCodeAgentSpawnEnv()` helper in `src/code-agents/utils.ts` replaces three copy-pasted `delete CLAUDECODE / GH_TOKEN / GITHUB_TOKEN` blocks across `executor.ts` and `interactive-resume.ts`.
- Discord: removed `[discord:diag]` debug logs that fired on every inbound message; converted interactive-session intercept to static imports for reduced hot-path overhead.
- `.gitignore`: added `.playwright-cli/` to stop committing local browser-automation artifacts.
