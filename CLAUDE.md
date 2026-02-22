@AGENTS.md

## Dashboard Notes

The dashboard is now framework-only (Preact/Vite). The old inline dashboard has been removed.

### Current Behavior

- Frontend route: `GET /dashboard` serves the built SPA from `dist/dashboard/index.html`
- Static assets: `GET /assets/*` and allowed root static files from `dist/dashboard`
- If frontend build is missing, `GET /dashboard` returns `503` with a build hint
- Dashboard token auth remains unchanged for `/api/dashboard/*`

### Verification

Before shipping dashboard changes:
- [ ] `pnpm build` passes
- [ ] `pnpm test` passes
- [ ] `src/__tests__/dashboard.test.ts` passes (framework route contract)
- [ ] `src/__tests__/dashboard-mode.test.ts` passes (framework serving + static safety)
