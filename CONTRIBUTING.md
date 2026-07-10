# Contributing

Keep changes small enough to review in one pass. Read `AGENTS.md` before editing; it contains the build commands, architecture boundaries, security rules, and test expectations for this repository.

## Set up the repository

Use Node.js 22.20 or newer and pnpm 10.29.3.

```bash
pnpm run bootstrap
pnpm build
pnpm test
```

`pnpm run bootstrap` installs the root and dashboard dependencies from their lockfiles. Documentation dependencies stay separate and install through `pnpm docs:build`.

## Make a change

- Add a regression test for bug fixes and security changes.
- Match the existing TypeScript and Vitest patterns.
- Keep provider routing in `src/providers/` and tool dispatch in `src/tools.ts`.
- Keep file access inside configured allowed paths. Do not weaken URL, command, token, or gateway checks.
- Leave unrelated cleanup for another change.

Run the full gate before opening a pull request:

```bash
pnpm ci
pnpm docs:build # when documentation changes
```

## Open a pull request

Describe the change, why it is needed, and any compatibility risk. Include automated results plus numbered manual testing steps with expected outcomes. Keep credentials, local runtime data, and `~/.skimpyclaw/config.json` out of commits and screenshots.

Follow [SECURITY.md](SECURITY.md) before sharing vulnerability details.
