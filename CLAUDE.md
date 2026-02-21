@AGENTS.md

## Dashboard Migration Notes

The inline dashboard (`src/dashboard.ts`) has a planned migration to Preact + Vite.
Migration plan: `dashboard_refactor.md`

### Verification Checklist (per migration phase)

Before marking any phase done:
- [ ] `pnpm build` passes (no TypeScript errors)
- [ ] `pnpm test` passes (all 362+ tests green)
- [ ] `src/__tests__/dashboard.test.ts` — all 116 parity tests pass
- [ ] `src/__tests__/api.test.ts` — all backend API contract tests pass
- [ ] Legacy dashboard still reachable at `GET /dashboard` when flag = `legacy`
- [ ] Feature flag (`config.dashboard.frontend`) defaults to `framework`
- [ ] Both `AGENTS.md` and `CLAUDE.md` updated in same PR

### Dashboard Feature Flag (when implemented)

```json
// ~/.skimpyclaw/config.json
{
  "dashboard": {
    "token": "...",
    "frontend": "framework"   // "legacy" | "framework"
  }
}
```

### Parity Expectations

The framework dashboard must preserve:
- All 14 sidebar tabs with identical `data-page` values
- All 14 `page-*` panel IDs
- All 12 backend API endpoints (paths and response shapes unchanged)
- Unified Health panel (no separate Doctor tab)
- `healthRecheckBtn`, `doctorSummary`, `doctorCategories`, `doctorTimestamp`, `healthEnvVars`, `healthFeatures` element IDs
- Bearer token auth flow with `localStorage` persistence
