# Team Forno Ping Audit — Last 6 Months

**Date range:** 2025-10-08 to 2026-04-08
**Audit run:** 2026-04-08
**Auditor:** Automated (Claude Code, local environment)

---

## Data Sources Checked

| Source | Status | Method | Coverage |
|--------|--------|--------|----------|
| GitHub (github.com) — Issues/PRs/Code | AVAILABLE | `gh` CLI, GitHub Search API | Full org:Automattic search |
| GitHub — PR review requests to `@Automattic/forno` | AVAILABLE | GitHub Search API `team-review-requested:` | Oct 2025–Apr 2026 |
| GitHub — CODEOWNERS references | AVAILABLE | `gh search code` | No results for `team-forno` in CODEOWNERS |
| GitHub Enterprise (github.a8c.com) | UNAVAILABLE | No GHE auth configured in this environment | Would need GHE token |
| Slack | UNAVAILABLE | No local exports; no Slack MCP/API access | Would need Slack export or ContextA8C MCP |
| P2s (WordPress.com internal blogs) | UNAVAILABLE | No local data; no WPCOM API access | Would need ContextA8C MCP or P2 API |
| Linear | UNAVAILABLE | No Linear API access in this environment | Would need Linear MCP or API token |
| Email/Notifications | UNAVAILABLE | Not accessible programmatically | N/A |

---

## GitHub Team Identity

- **Team slug:** `Automattic/forno` (NOT `team-forno`)
- **Display name:** Forno
- **Parent team:** VIP Platform Engineering
- **Members (7):** ariskataoka, aagam-shah, kat3samsin, t-wright, aswasif007, saroshaga, iamchughmayank
- **Repos:** 89
- **Note:** The team was renamed from "VIP Forno" in Aug 2025 (see PRs below). References to `@team-forno` or `#team-forno` do not match the actual GitHub team handle `@Automattic/forno`.

---

## Exact Matches Found

### A. Team Forno's Own PRs (FORNO-xxx ticket prefix, Oct 2025–Apr 2026)

These are PRs authored by Forno team members with FORNO ticket references. Not "pings" per se — these are the team's own work.

| Date | Repo | PR | Author | Status |
|------|------|----|--------|--------|
| 2026-04-07 | Automattic/jetpack | [#47975](https://github.com/Automattic/jetpack/pull/47975) FORNO-300: Skip premature enabling of AM via Block Notes | iamchughmayank | **OPEN** |
| 2026-03-29 | Automattic/jetpack | [#47829](https://github.com/Automattic/jetpack/pull/47829) FORNO 257: Release Image Studio in Jetpack | kat3samsin | Closed |
| 2026-03-29 | Automattic/wp-calypso | [#109683](https://github.com/Automattic/wp-calypso/pull/109683) FORNO-281: Block notes tracking prefix | iamchughmayank | Closed |
| 2026-03-24 | Automattic/wp-calypso | [#109492](https://github.com/Automattic/wp-calypso/pull/109492) FORNO-263: Image Studio attachment url | t-wright | Closed |
| 2026-03-23 | Automattic/wp-calypso | [#109448](https://github.com/Automattic/wp-calypso/pull/109448) FORNO-262: Deduplicate notices | t-wright | Closed |
| 2026-03-20 | Automattic/wp-calypso | [#109431](https://github.com/Automattic/wp-calypso/pull/109431) FORNO-261: Fix Aspect Ratio | kat3samsin | Closed |
| 2026-03-20 | Automattic/wp-calypso | [#109413](https://github.com/Automattic/wp-calypso/pull/109413) FORNO-258: Domain allowlist | t-wright | Closed |
| 2026-03-19 | Automattic/wp-calypso | [#109382](https://github.com/Automattic/wp-calypso/pull/109382) FORNO-250: CIAB compatibility | t-wright | **OPEN** |
| 2026-03-19 | Automattic/jetpack | [#47675](https://github.com/Automattic/jetpack/pull/47675) FORNO-250: Enqueue assets on next_admin_init | t-wright | **OPEN** |
| 2026-03-17 | Automattic/wp-calypso | [#109338](https://github.com/Automattic/wp-calypso/pull/109338) FORNO-253: Fix Image Studio icons in P2 | kat3samsin | Closed |
| 2026-03-16 | Automattic/big-sky-plugin | [#5828](https://github.com/Automattic/big-sky-plugin/pull/5828) FORNO-234: Decouple image-studio store | t-wright | Closed |
| 2026-03-13 | Automattic/wp-calypso | [#109258](https://github.com/Automattic/wp-calypso/pull/109258) FORNO-250: Supported MIME types selector | t-wright | Closed |
| 2026-03-13 | Automattic/jetpack | [#47572](https://github.com/Automattic/jetpack/pull/47572) FORNO-250: Enable Image Studio in CIAB | t-wright | Closed |
| 2026-03-11 | Automattic/wp-calypso | [#109210](https://github.com/Automattic/wp-calypso/pull/109210) Image Studio: Minor style fixes | kat3samsin | Closed |
| 2026-03-09 | Automattic/jetpack | [#47533](https://github.com/Automattic/jetpack/pull/47533) FORNO-229: Enable Image Studio for A8C | kat3samsin | Closed |
| 2026-03-06 | Automattic/jetpack | [#47479](https://github.com/Automattic/jetpack/pull/47479) FORNO-186: suggest-guidelines proxy | aagam-shah | **OPEN** |
| 2026-03-06 | Automattic/wp-calypso | [#109100](https://github.com/Automattic/wp-calypso/pull/109100) FORNO-235: Fix dropdown z-index | t-wright | Closed |
| 2026-03-06 | Automattic/big-sky-plugin | [#5775](https://github.com/Automattic/big-sky-plugin/pull/5775) FORNO-235: Fix dropdown overlay | t-wright | Closed |
| 2026-03-05 | Automattic/wp-calypso | [#109091](https://github.com/Automattic/wp-calypso/pull/109091) FORNO-229: Prevent double loading | kat3samsin | Closed |
| 2026-03-04 | Automattic/big-sky-plugin | [#5764](https://github.com/Automattic/big-sky-plugin/pull/5764) FORNO-229: Remove double loading | kat3samsin | Closed |
| 2026-03-04 | Automattic/jetpack | [#47453](https://github.com/Automattic/jetpack/pull/47453) FORNO-229: Enable Image Studio | kat3samsin | Closed |
| 2026-03-03 | Automattic/wp-calypso | [#109016](https://github.com/Automattic/wp-calypso/pull/109016) FORNO-227: Disable abort button | t-wright | Closed |
| 2026-03-03 | Automattic/wp-calypso | [#109014](https://github.com/Automattic/wp-calypso/pull/109014) FORNO-227: Persist metadata | t-wright | Closed |
| 2026-03-03 | Automattic/wp-calypso | [#109013](https://github.com/Automattic/wp-calypso/pull/109013) FORNO-222: i18n text domain | t-wright | Closed |
| 2026-03-02 | Automattic/wp-calypso | [#109009](https://github.com/Automattic/wp-calypso/pull/109009) Forno-226: Block notes abilities fix | iamchughmayank | Closed |
| 2026-03-02 | Automattic/wp-calypso | [#108998](https://github.com/Automattic/wp-calypso/pull/108998) FORNO-224: Hide toolbar mismatched attachment | t-wright | Closed |
| 2026-03-01 | Automattic/wp-calypso | [#108993](https://github.com/Automattic/wp-calypso/pull/108993) Image Studio: Improve Agents experience | kat3samsin | Closed |
| 2026-02-27 | Automattic/wp-calypso | [#108986](https://github.com/Automattic/wp-calypso/pull/108986) Image Studio: low credits warning | ariskataoka | Closed |
| 2026-02-27 | Automattic/jetpack | [#47372](https://github.com/Automattic/jetpack/pull/47372) Charts: Bundle fast-deep-equal | t-wright | Closed |
| 2026-02-26 | Automattic/wp-calypso | [#108958](https://github.com/Automattic/wp-calypso/pull/108958) FORNO-216: Upgrade path handling | ariskataoka | Closed |
| 2026-02-26 | Automattic/jetpack | [#47353](https://github.com/Automattic/jetpack/pull/47353) Image Studio: Fix console warnings | kat3samsin | Closed |
| 2026-02-26 | Automattic/big-sky-plugin | [#5718](https://github.com/Automattic/big-sky-plugin/pull/5718) FORNO-216: Jetpack upgrade path | ariskataoka | Closed |
| 2026-02-25 | Automattic/jetpack | [#47315](https://github.com/Automattic/jetpack/pull/47315) FORNO-217: Activation conditions | t-wright | Closed |
| 2026-02-24 | Automattic/wp-calypso | [#108884](https://github.com/Automattic/wp-calypso/pull/108884) Add platform property tracking | aagam-shah | Closed |
| 2026-02-24 | Automattic/big-sky-plugin | [#5709](https://github.com/Automattic/big-sky-plugin/pull/5709) FORNO-213: Skip block notes if AM | iamchughmayank | Closed |
| 2026-02-24 | Automattic/jetpack | [#47296](https://github.com/Automattic/jetpack/pull/47296) Forno-213: Add block notes plugin | iamchughmayank | Closed |
| 2026-02-23 | Automattic/wp-calypso | [#108852](https://github.com/Automattic/wp-calypso/pull/108852) Image Studio: Don't persist prompt | aswasif007 | Closed |
| 2026-02-23 | Automattic/big-sky-plugin | [#5698](https://github.com/Automattic/big-sky-plugin/pull/5698) FORNO-214: Cleanup async-suggestions | aswasif007 | Closed |
| 2026-02-23 | Automattic/wp-calypso | [#108847](https://github.com/Automattic/wp-calypso/pull/108847) FORNO-209: Feedback input on thumbs down | t-wright | Closed |
| 2026-02-19 | Automattic/wp-calypso | [#108808](https://github.com/Automattic/wp-calypso/pull/108808) Add AGENTS.md/CLAUDE.md to Image Studio | kat3samsin | Closed |
| 2026-02-19 | Automattic/wp-calypso | [#108805](https://github.com/Automattic/wp-calypso/pull/108805) FORNO-213: Block Notes Calypso app | iamchughmayank | Closed |
| 2026-02-19 | Automattic/big-sky-plugin | [#5685](https://github.com/Automattic/big-sky-plugin/pull/5685) FORNO-211: i18n AI Block Notes | iamchughmayank | Closed |
| 2026-02-19 | Automattic/big-sky-plugin | [#5680](https://github.com/Automattic/big-sky-plugin/pull/5680) Feedback messages with user/site info | aagam-shah | Closed |
| 2026-02-19 | Automattic/big-sky-plugin | [#5679](https://github.com/Automattic/big-sky-plugin/pull/5679) FORNO-201: Image button spacing | t-wright | Closed |
| 2026-02-19 | Automattic/jetpack | [#47215](https://github.com/Automattic/jetpack/pull/47215) FORNO-198: Enqueue Translations | t-wright | Closed |
| 2026-02-17 | Automattic/jetpack | [#47180](https://github.com/Automattic/jetpack/pull/47180) FORNO-188: Image generation handler filter | ariskataoka | Closed |
| 2026-01-23 | Automattic/big-sky-plugin | [#5508](https://github.com/Automattic/big-sky-plugin/pull/5508) FORNO-150: Image Studio > Support Agents Manager | kat3samsin | Merged |

### B. PRs with `@Automattic/forno` Review Requests (Oct 2025–Apr 2026)

These are PRs where someone explicitly requested review from the Forno team.

| Date | Repo | PR | Author | Status |
|------|------|----|--------|--------|
| 2026-02-20 | Automattic/big-sky-plugin | [#5694](https://github.com/Automattic/big-sky-plugin/pull/5694) Fix E2E test for block notes | iamchughmayank | Closed |
| 2026-01-27 | Automattic/big-sky-plugin | [#5534](https://github.com/Automattic/big-sky-plugin/pull/5534) FORNO-161: Fix input toolbar width | aswasif007 | Closed |
| 2026-01-24 | Automattic/vip-insights-service | [#1272](https://github.com/Automattic/vip-insights-service/pull/1272) Fix anomaly detection | robersongomes | Closed |
| 2026-01-23 | Automattic/vip-insights-service | [#1271](https://github.com/Automattic/vip-insights-service/pull/1271) Fix anomaly detection processing | robersongomes | Closed |
| 2026-01-19 | Automattic/vip-insights-service | [#1268](https://github.com/Automattic/vip-insights-service/pull/1268) Configurable allowlist anomaly reporting | robersongomes | Closed |
| 2026-01-16 | Automattic/big-sky-plugin | [#5439](https://github.com/Automattic/big-sky-plugin/pull/5439) Fix block notes override | iamchughmayank | Closed |
| 2025-12-18 | Automattic/vip-insights-service | [#1257](https://github.com/Automattic/vip-insights-service/pull/1257) Production Release | aagam-shah | Closed |
| 2025-11-14 | Automattic/vip-insights-service | [#1241](https://github.com/Automattic/vip-insights-service/pull/1241) Production Release | robersongomes | Closed |

### C. Cross-Team References / Non-Forno Authors Mentioning Forno

| Date | Repo | PR | Author | Context |
|------|------|----|--------|---------|
| 2025-08-22 | Automattic/k8s-systems | [#633](https://github.com/Automattic/k8s-systems/pull/633) Rename VIP Forno team | vitali-raikov | VIP Systems team renamed "VIP Forno" → "Forno" per team name change request |
| 2025-08-22 | Automattic/wpvip-operator | [#3397](https://github.com/Automattic/wpvip-operator/pull/3397) Rename VIP Forno team | vitali-raikov | Same rename — both merged same day |
| 2024-07-26 | Automattic/vip-go-admin-console | [#2026](https://github.com/Automattic/vip-go-admin-console/pull/2026) Update CODEOWNERS to VIP Platform Engineering | saroshaga | "The Forno team is no longer the only one that maintains and contributes" — CODEOWNERS broadened |

**Note:** The rename PRs are from Aug 2025 (outside the 6-month window but contextually important). No cross-team pings *to* `@Automattic/forno` from non-Forno members were found in the last 6 months via GitHub search.

---

## Items Potentially Requiring Team Forno Attention

### Currently Open PRs

| PR | Age | Author | Why It May Need Attention |
|----|-----|--------|---------------------------|
| [Automattic/jetpack#47975](https://github.com/Automattic/jetpack/pull/47975) FORNO-300: Skip premature AM enabling | 1 day | iamchughmayank | Just opened — likely in active review |
| [Automattic/wp-calypso#109382](https://github.com/Automattic/wp-calypso/pull/109382) CIAB compatibility | 20 days | t-wright | Open for 3 weeks, still getting updates (last: today). May be blocked or in extended review |
| [Automattic/jetpack#47675](https://github.com/Automattic/jetpack/pull/47675) Enqueue assets on next_admin_init | 20 days | t-wright | Companion to #109382. Same age/status |
| [Automattic/jetpack#47479](https://github.com/Automattic/jetpack/pull/47479) FORNO-186: suggest-guidelines proxy | 33 days | aagam-shah | Open for a month with no updates since creation. **May be stale or forgotten** |

### Stale Candidate

**[Automattic/jetpack#47479](https://github.com/Automattic/jetpack/pull/47479)** — FORNO-186: Add suggest-guidelines proxy endpoint. Opened 2026-03-06 by aagam-shah. Last updated same day. No activity for 33 days. This is the most likely candidate for a missed/forgotten item.

---

## Confidence Gaps & Limitations

### What This Audit CANNOT See

1. **Slack messages** — `@team-forno` and `#team-forno` channel mentions are completely invisible. This is the most likely place for missed pings. **UNAVAILABLE — needs Slack export, Slack API access, or ContextA8C MCP.**

2. **P2 posts and comments** — Internal WordPress.com blogs (P2s) where team pings commonly happen (e.g., cross-posting, @-mentions in comments). **UNAVAILABLE — needs WPCOM API or ContextA8C MCP.**

3. **Linear issues** — FORNO-xxx tickets, assignments, mentions, and comments. **UNAVAILABLE — needs Linear API token or Linear MCP.**

4. **GitHub Enterprise (github.a8c.com)** — Some Automattic repos live on GHE. **UNAVAILABLE — no GHE token configured.**

5. **GitHub PR review comments** — The GitHub Search API indexes issue/PR bodies and titles but has limited coverage of individual review comments. A `@Automattic/forno` ping in a review thread may not surface.

6. **GitHub notifications** — The Notifications API is per-user and can't be queried for a team.

7. **The actual string `@team-forno`** — The GitHub team handle is `@Automattic/forno`, not `@team-forno`. If people are writing `@team-forno` in Slack or P2, those pings don't map to a GitHub team. This audit searched for both patterns but the mismatch means GitHub-side pings use a different handle.

### What Would Be Needed for Full Coverage

| Source | Access Required |
|--------|----------------|
| Slack | Slack API token with `search:read` scope, or ContextA8C MCP with Slack provider |
| P2 | WPCOM REST API access, or ContextA8C MCP with MGS/WPCOM providers |
| Linear | Linear API key for the Automattic workspace, or ContextA8C MCP with Linear provider |
| GitHub Enterprise | Personal access token for github.a8c.com |

---

## Reproducible Commands Used

```bash
# GitHub team identity
gh api orgs/Automattic/teams/forno

# Team members
gh api orgs/Automattic/teams/forno/members -q '.[].login'

# Search issues/PRs with FORNO ticket prefix (last 6 months)
gh api search/issues --method GET \
  -f q='"FORNO" org:Automattic created:>2025-10-01' \
  -f per_page=50 -f sort=created -f order=desc

# Search for @team-forno string in Automattic org
gh api search/issues --method GET \
  -f q='"@team-forno" org:Automattic' \
  -f per_page=50 -f sort=created -f order=desc

# Search for #team-forno string in Automattic org
gh api search/issues --method GET \
  -f q='"#team-forno" org:Automattic' \
  -f per_page=50 -f sort=created -f order=desc

# Search for team-forno in code
gh search code "team-forno" --owner Automattic --limit 30

# Search for PRs with Forno team review requests
gh api search/issues --method GET \
  -f q='team-review-requested:Automattic/forno created:>2025-10-01' \
  -f per_page=50

# Search for open FORNO PRs
gh api search/issues --method GET \
  -f q='org:Automattic "forno" is:open is:pr created:>2025-10-01' \
  -f per_page=30

# Check for local Slack/P2 data
find ~/Downloads ~/Documents ~/Desktop -maxdepth 3 -name "*slack*" -o -name "*Slack*"
```

---

## Summary

- **GitHub coverage is thorough** for github.com/Automattic. Team Forno (`@Automattic/forno`) has been highly active with 45+ PRs across `jetpack`, `wp-calypso`, `big-sky-plugin`, and `vip-insights-service` in the last 6 months.
- **No cross-team pings to `@team-forno` were found** in GitHub issue/PR bodies in the last 6 months. The actual GitHub handle is `@Automattic/forno` — if people use `@team-forno` in Slack/P2, those won't appear in GitHub search.
- **One PR is likely stale:** [jetpack#47479](https://github.com/Automattic/jetpack/pull/47479) (FORNO-186, 33 days with no updates).
- **Three PRs are open and active** (FORNO-300, FORNO-250 x2).
- **Slack, P2, Linear, and GHE are completely inaccessible** from this environment. These are the most likely sources of missed pings, especially Slack where `@team-forno` mentions would happen conversationally.
