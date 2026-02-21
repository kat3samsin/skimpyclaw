# Dashboard Framework Migration Plan (Legacy Inline -> React/Preact)

## Goal
Replace the inline dashboard in `src/dashboard.ts` with a framework-based frontend while keeping Fastify backend routes and `/api/dashboard/*` behavior stable.

## Definition of Done

1. Framework dashboard is live behind the migration flag with parity on core flows.
2. `pnpm build && pnpm test` passes.
3. Documentation is updated in both:
   - `AGENTS.md`
   - `CLAUDE.md`

## Recommendation
Use **Preact + Vite + TypeScript** (React-compatible API, lighter runtime).  
If you prefer ecosystem familiarity over size, use React with the same structure.

## Phase 0: Guardrails

1. Create a feature branch: `feat/dashboard-framework-migration`.
2. Do not break current dashboard behavior during migration.
3. Keep legacy dashboard available behind a runtime flag until parity is confirmed.
4. Every milestone must pass:
   - `pnpm build`
   - `pnpm test`

## Phase 1: Scaffold Frontend Project

1. Create new frontend app:
   - `web/dashboard/` (Vite + TS)
2. Add baseline structure:
   - `web/dashboard/src/main.tsx`
   - `web/dashboard/src/App.tsx`
   - `web/dashboard/src/api/client.ts`
   - `web/dashboard/src/types.ts`
   - `web/dashboard/src/components/`
   - `web/dashboard/src/pages/`
   - `web/dashboard/src/styles/`
3. Add scripts to root `package.json`:
   - `dashboard:dev`
   - `dashboard:build`
4. Wire root `pnpm build` to also build dashboard assets (without breaking existing build).

## Phase 2: Serve Built Assets from Backend

1. Update Fastify wiring (likely in `src/gateway.ts`) to serve:
   - static files from `web/dashboard/dist` (or copied `dist/dashboard`)
2. Keep existing dashboard route path unchanged for users.
3. Add a config flag (e.g. in runtime config):
   - `dashboardFrontend: "legacy" | "framework"`
4. Route behavior:
   - `legacy` -> existing inline HTML path
   - `framework` -> serve built SPA + fallback to `index.html`

## Phase 3: API Contract Stabilization

1. Inventory current dashboard API calls from inline JS in `src/dashboard.ts`.
2. Create typed frontend API client in `web/dashboard/src/api/client.ts`.
3. Preserve existing backend response formats unless unavoidable.
4. If normalization is needed, do it in frontend client layer first.
5. Only add backend endpoints when required; avoid broad contract churn.

## Phase 4: Incremental UI Migration (No Big Bang)

Migrate feature-by-feature to reduce risk:

1. App shell (layout, nav, top-level routing/state)
2. Status/overview panels
3. Jobs/task views
4. Logs/stream output sections
5. Settings/config forms
6. Action controls (buttons, run/retry/stop, etc.)

Rules:

1. Keep visual parity first.
2. Replace direct DOM manipulation with hooks/state.
3. Keep side effects isolated in service/API layer.

## Phase 5: Styling Migration

1. Move inline CSS to structured files under `web/dashboard/src/styles/`.
2. Preserve current design initially.
3. Introduce theme tokens (CSS variables) only after parity.
4. Ensure mobile + desktop behavior matches existing dashboard usability.

## Phase 6: Testing

1. Add frontend unit tests (Vitest + Testing Library):
   - render smoke
   - API client success/error handling
   - critical interaction flows
2. Add one end-to-end smoke path for dashboard load + one key action.
3. Update backend tests only when backend behavior changes.
4. Final gate:
   - `pnpm build && pnpm test` must pass.

## Phase 7: Rollout and Cleanup

1. Ship with default `legacy` for first merge if risk is high.
2. Validate framework dashboard in real usage.
3. Switch default to `framework` after parity confidence.
4. Remove legacy inline dashboard code in `src/dashboard.ts` once stable.
5. Keep rollback path until at least one release cycle passes.

## Phase 8: Documentation Updates (Required)

Update both:

1. `AGENTS.md`
2. `CLAUDE.md`

Include:

1. New dashboard architecture and file paths
2. Build/test/dev commands for frontend
3. Route serving behavior and feature flag
4. Migration gotchas and ownership expectations

Implementation rule: do not mark the migration complete until both docs are updated in the same PR.

## Suggested Agent Split

1. **Agent 1 (Core, required):** scaffold, backend serving, migration, feature flag.
2. **Agent 2 (Optional):** tests and QA automation.
3. **Agent 3 (Optional):** docs and final cleanup.

Minimum: **1 agent**.  
Balanced speed/coordination: **2 agents**.
