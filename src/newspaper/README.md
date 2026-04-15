## Newspaper

The newspaper feature turns saved digest runs into a browsable edition inside the dashboard.

### Pipeline

1. Cron jobs write digest output.
2. `src/digests.ts` parses and stores digest articles.
3. `src/newspaper/normalize.ts` converts digests into `NormalizedArticle` records.
4. `src/newspaper/dedup.ts` removes duplicates.
5. `src/newspaper/rank.ts` scores and orders stories.
6. `src/newspaper/edition-builder.ts` assembles and saves an edition.
7. `src/newspaper/summarize.ts` optionally adds LLM summaries.
8. `src/newspaper/frontend.ts` renders the newspaper view and article detail experience.

### Refresh Workflow

- `POST /api/newspaper/build`
  Rebuilds the edition from already-saved digests.

- `POST /api/newspaper/refresh` with `mode: "build-only"`
  Same as build, but reports refresh state through the status endpoint.

- `POST /api/newspaper/refresh` with `mode: "fetch-and-build"`
  Runs the configured newspaper source cron jobs first, then rebuilds the edition.

Configured source jobs are resolved in `src/newspaper/workflow.ts`. Today that prefers:

- `ai-news`
- `news` or `news-digest`
- `ph-news` or `ph-digest`
- `morning`

### Source Resolution

The canonical source resolver lives in `src/newspaper/source-resolution.ts`.

All URL cleanup and source selection should go through that module so normalization, edition storage, and article hydration agree on the same article URL. The resolver is responsible for:

- preferring a trusted `sourceUrl` over aggregator URLs when present
- decoding Google News wrapper URLs
- rejecting invalid Google News slugs and obvious index/listing pages
- preserving `rawUrl`, `sourceUrl`, and `sourceResolutionMethod` for debugging

If article fetching starts drifting again, the first place to check is whether a new codepath bypassed `resolveArticleSource()`.

### Key Files

- `src/newspaper/types.ts`
  Shared newspaper data model.

- `src/newspaper/routes.ts`
  API routes for edition lookup, refresh, and read state.

- `src/newspaper/storage.ts`
  JSON edition storage under `~/.skimpyclaw/logs/newspaper/`.

- `src/newspaper/editorial-fetch.ts`
  Fetches full article text for in-newspaper reading.

- `src/newspaper/source-resolution.ts`
  Single source of truth for canonical article URLs.

### Operational Notes

- Rebuilding the edition is enough to pick up newspaper code changes.
- Pulling fresh news is only required when you want newer digest content.
- `pnpm build && pnpm test` must pass before shipping changes in this area.
