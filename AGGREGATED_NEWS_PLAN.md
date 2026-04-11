# Aggregated News — Implementation Plan

A newspaper-style web app that aggregates, distills, and presents content from SkimpyClaw's three news channels: **news-digest** (US + World headlines), **ai-news** (HN, Reddit AI, X/Twitter), and **ph-digest** (Reddit Philippines).

---

## 1. Product Brief

### Problem

Three cron jobs produce raw, unsummarized news feeds dumped into Discord threads. No unified reading experience, no distillation, no deduplication across feeds, no way to catch up on what mattered without scrolling raw output.

### Users

- **Primary:** Katrina — daily consumer of all three feeds, wants a 5-minute morning catchup.
- **Secondary:** Anyone with dashboard access (Bearer token auth already exists).

### Jobs to Be Done

1. **Morning scan:** "Show me what's important across all feeds in 2 minutes."
2. **Deep dive:** "Let me read the AI-distilled summary of a specific article/paper."
3. **Catch up:** "I missed yesterday — show me the highlights."
4. **Track topics:** "What's been trending in AI this week?"

### Success Metrics

| Metric | Target |
|--------|--------|
| Time to first read (page load → useful content) | < 2s |
| Articles surfaced per digest run | 20–35 (across all feeds) |
| Duplicate articles across feeds | < 5% after dedup |
| Summary accuracy (spot-check: matches source) | > 95% |
| Daily active reading sessions | ≥ 2 (morning + evening) |

---

## 2. Information Architecture & UX Flow

### Sitemap

```
/newspaper                          → Front page (today's edition)
/newspaper/section/:sectionId       → Section view (us, world, ai, ph)
/newspaper/article/:articleId       → Article detail (summary + original link)
/newspaper/archive                  → Past editions by date
/newspaper/topics                   → Topic clusters (stretch)
```

### Front Page ("Today's Edition")

```
┌─────────────────────────────────────────────────────────┐
│  THE DAILY CLAW               April 11, 2026  Morning   │
│  ═══════════════════════════════════════════════════════  │
│                                                         │
│  ┌─── LEAD STORY ───────────────────────────────────┐   │
│  │  [Headline]                                      │   │
│  │  2-sentence AI summary.  Source • Score • Time    │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ┌── US Headlines ──┐ ┌── World ────────┐ ┌── AI ──┐   │
│  │ 1. Headline      │ │ 1. Headline     │ │ 1. ... │   │
│  │ 2. Headline      │ │ 2. Headline     │ │ 2. ... │   │
│  │ 3. Headline      │ │ 3. Headline     │ │ 3. ... │   │
│  │ [More →]         │ │ [More →]        │ │        │   │
│  └──────────────────┘ └─────────────────┘ └────────┘   │
│                                                         │
│  ┌── Philippines ───────────────────────────────────┐   │
│  │ 1. Headline   2. Headline   3. Headline          │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  [Archive]                                   [Settings] │
└─────────────────────────────────────────────────────────┘
```

### Design Principles

- **Newspaper grid layout** — multi-column, headline hierarchy by score/importance.
- **No images** — text-first, like a broadsheet. Clean typography (serif headlines, sans-serif body).
- **Inline HTML/CSS/JS** — matches existing dashboard pattern (no build step, no framework).
- **Dark/light mode** — CSS `prefers-color-scheme` with manual toggle.
- **Read state** — already supported in digest system (`article.read`). Gray out read articles.
- **Mobile responsive** — single-column stacking below 768px.

### Article Detail View

- AI-generated 3–5 sentence summary
- Key takeaways (bullet list, 3–5 items)
- Topic tags
- Source attribution with direct link to original
- Engagement metrics (score, comments)
- "Related articles" from other sections (same topic cluster)
- "Mark as read" toggle

---

## 3. Content Ingestion Architecture

### Current State

Three Python scripts run via SkimpyClaw cron:

| Job ID | Sources | Schedule | Output |
|--------|---------|----------|--------|
| `news-digest` | Google News RSS (US + World) | 6am, 6pm CT | Markdown + JSON to `~/.skimpyclaw/reports/` |
| `ai-news` | HN Algolia API, Reddit (3 subs), X/Twitter | 6:30am, 9pm CT | Stdout (parsed by `parseAndSaveDigest`) |
| `ph-digest` | Reddit (3 PH subs) | 6am, 9pm CT | Stdout (parsed by `parseAndSaveDigest`) |

### Proposed Pipeline

```
[Cron Scripts]  →  [Normalizer]  →  [Dedup]  →  [Enrichment]  →  [Storage]
  (existing)       (new module)     (new)       (AI pipeline)    (digests)
```

#### 3.1 Connectors (Keep Existing)

No changes to the three Python scripts. They work, they're simple, they handle rate limits. The ingestion layer reads their output.

**Recommended:** Keep scripts as-is. Add a thin `postProcess` hook in `src/cron.ts` that triggers after each script job completes.

#### 3.2 Normalizer (`src/newspaper/normalize.ts`)

Converts raw script output into a common `NormalizedArticle` format:

```typescript
interface NormalizedArticle {
  id: string;              // content-hash of url
  title: string;
  url: string;
  source: string;          // "Hacker News", "Google News", "Reddit r/Philippines"
  section: Section;        // "us" | "world" | "ai" | "ph"
  score?: number;
  comments?: number;
  author?: string;
  publishedAt?: string;
  rawContent?: string;     // original context from feed
  fetchedAt: string;       // ISO timestamp
}
```

The existing `parseDigestContent()` in `src/digests.ts` already handles most of this. Extend it, don't replace it.

#### 3.3 Deduplication

Two-tier dedup:

1. **URL-exact:** MD5 of normalized URL (already done in `parseDigestContent` via `seen` set).
2. **Title-fuzzy:** Levenshtein distance < 0.3 on lowercased, stop-word-stripped titles. Same story from Google News and HN should merge, keeping the higher-scored version and noting both sources.

**Recommended default:** Simple URL dedup for MVP. Add fuzzy title dedup in v1.

#### 3.4 Ranking

Score each article for front-page placement:

```
importance = (normalized_score * 0.4) + (recency_hours * -0.2) + (source_weight * 0.3) + (section_boost * 0.1)
```

Source weights: HN = 1.0, Google News = 0.9, Reddit (AI subs) = 0.8, Reddit (PH) = 0.7, X/Twitter = 0.6.

Section boost: Lead story gets 1.5x. Section headers get 1.2x.

**Recommended:** Hardcode weights. No ML. Adjust by hand when rankings feel off.

#### 3.5 Content Fetching (for Summarization)

For articles that are just headlines + links (Google News, Reddit), fetch the actual article content for AI summarization:

- Use existing `fetch` tool's URL validation (`validateTarget()`) for safety.
- Extract readable text with a simple HTML-to-text extraction (no Readability.js dependency — just strip tags, keep `<p>`, `<h1>`–`<h6>`, `<li>`).
- Timeout: 8s per article. Skip on failure (summary = "Read the original").
- Cache fetched content in digest storage (don't re-fetch on page view).
- **Respect robots.txt:** Check before fetching. Skip if disallowed.

**Recommended:** Fetch top 10 articles per edition only (by ranking score). Don't fetch all 30+.

---

## 4. Data Model

### Entities

```
Edition (1 per cron cycle, or merged from overlapping cycles)
├── id: string (date + slot, e.g. "2026-04-11-morning")
├── createdAt: string (ISO)
├── slot: "morning" | "evening"
├── leadStoryId: string (FK → Article)
├── summary: string (AI-generated edition summary)
│
├── Article[] (ordered by rank within section)
│   ├── id: string (MD5 of URL)
│   ├── title: string
│   ├── url: string
│   ├── source: string
│   ├── section: "us" | "world" | "ai" | "ph"
│   ├── rank: number
│   ├── score?: number
│   ├── comments?: number
│   ├── author?: string
│   ├── publishedAt?: string
│   ├── fetchedContent?: string (raw text from URL)
│   ├── summary?: string (AI-generated)
│   ├── keyTakeaways?: string[] (AI-generated)
│   ├── topics?: string[] (AI-assigned)
│   ├── confidence?: number (0–1, AI self-assessment)
│   ├── sourceAttribution: string (always preserved)
│   ├── read: boolean
│   ├── relatedArticleIds?: string[]
│   └── sources: { name: string, url: string }[] (for cross-feed dedup merges)
│
└── TopicCluster[] (stretch goal)
    ├── id: string
    ├── label: string
    ├── articleIds: string[]
    └── trendDirection: "rising" | "stable" | "falling"
```

### Storage

**Recommended:** JSON files on disk, same pattern as existing digests.

```
~/.skimpyclaw/logs/newspaper/
├── editions/
│   ├── 2026-04-11-morning.json
│   ├── 2026-04-11-evening.json
│   └── ...
├── articles/              (individual article cache, optional)
│   ├── {articleId}.json
│   └── ...
└── index.json             (edition index for archive browsing)
```

This mirrors `src/digests.ts` patterns. No database needed at this scale (2 editions/day × 30 articles = ~60 records/day).

### Relationship to Existing Digests

The newspaper system **consumes** existing digests (produced by `parseAndSaveDigest`) and merges them into editions. It doesn't replace the digest system — it layers on top.

```
Cron job → parseAndSaveDigest() → Digest (existing)
                                      ↓
                              buildEdition() → Edition (new)
```

---

## 5. AI Pipeline for Distillation

### Architecture

```
[Edition Builder]
  ↓
  For each article (top 10 by rank):
    1. Fetch content (if URL-based headline)
    2. Summarize (Claude API call)
    3. Extract takeaways
    4. Assign topics
    5. Self-assess confidence
  ↓
  For the edition:
    6. Cluster topics across articles
    7. Select lead story
    8. Generate edition summary
  ↓
  [Save Edition]
```

### Prompt Design

**Article Summary Prompt:**

```
You are a newspaper editor. Summarize this article in 3–5 sentences for a
busy reader. Preserve factual accuracy. Do not editorialize.

Title: {title}
Source: {source}
Content: {content (first 3000 chars)}

Respond in JSON:
{
  "summary": "...",
  "keyTakeaways": ["...", "...", "..."],
  "topics": ["ai", "policy", ...],
  "confidence": 0.0–1.0
}
```

**Confidence scoring:**
- 1.0: Full article text available, clear factual content
- 0.7–0.9: Partial content or opinion piece
- 0.3–0.6: Title-only, no content fetched
- < 0.3: Ambiguous or low-quality source

**Edition Summary Prompt:**

```
You are the editor-in-chief. Write a 2-sentence overview of today's {slot}
edition based on these headlines: {top 5 headlines with sections}.
Be factual. No clickbait.
```

### Model Selection

**Recommended:** Use SkimpyClaw's existing `runAgentTurn` with model `claude-sonnet` (or whatever fast model is configured). Summarization doesn't need opus-tier reasoning.

- Batch articles in a single prompt where possible (up to 5 per call) to reduce latency and cost.
- Estimated cost: ~$0.02–0.05 per edition (10 articles × ~1K tokens input + 200 tokens output each).

### Source Attribution

Every AI-generated field must include:
- The original source URL (always linked)
- "AI-generated summary" label on all summaries
- Confidence score displayed as visual indicator (green/yellow/red dot)

### Hallucination Mitigation

1. **Never generate facts not in source material.** Prompt instructs "summarize only what's stated."
2. **Confidence < 0.5 → show "Read the original" instead of summary.**
3. **Title-only articles (no fetched content) get no summary**, just the headline + link.
4. **No AI-generated headlines.** Always use the original title from the feed.

---

## 6. Tech Stack

### Recommended Stack (Fast MVP)

| Layer | Choice | Why |
|-------|--------|-----|
| Frontend | Inline HTML/CSS/JS (single file) | Matches existing dashboard pattern. No build step. |
| Backend | Fastify routes in `src/api.ts` | Already exists. Add `/api/newspaper/*` endpoints. |
| Storage | JSON files on disk | Matches `src/digests.ts`. No database needed at this scale. |
| AI | SkimpyClaw's `runAgentTurn` | Already wired up. Uses configured provider + model. |
| Content fetch | Node `fetch` + HTML strip | No external dependency. |
| Scheduling | Existing cron system | Already runs the three feed scripts. |
| Auth | Existing Bearer token | Dashboard auth already works. |
| Styling | CSS Grid + CSS Variables | Newspaper layout. Dark/light mode. No framework. |

### Why Not [Alternative]

| Alternative | Why Not |
|-------------|---------|
| React/Next.js | Overkill. Adds build step, deps, complexity. This is a personal tool. |
| SQLite/Postgres | 60 records/day doesn't justify a database. JSON files are fine for 5+ years. |
| External RSS aggregator | Loses integration with SkimpyClaw cron, AI pipeline, dashboard auth. |
| Separate service | More infra to maintain. One process is simpler. |

### Scalable Evolution Path (If Needed Later)

- SQLite via `better-sqlite3` if JSON files become slow (unlikely before 100K+ articles)
- Preact/HTM for component reuse if the UI grows beyond 3 pages
- Worker threads for parallel content fetching if 10 articles × 8s becomes a bottleneck

---

## 7. Incremental Roadmap

### Phase 1: MVP (2 weeks)

**Goal:** Newspaper front page rendering existing digest data. No AI summarization yet.

| Week | Deliverable |
|------|-------------|
| **Week 1** | |
| Day 1–2 | `src/newspaper/types.ts` — Edition, Article, Section types |
| Day 2–3 | `src/newspaper/edition-builder.ts` — merge 3 digests → Edition, ranking, dedup |
| Day 3–4 | `src/newspaper/storage.ts` — save/load editions (JSON files, mirrors digests.ts) |
| Day 4–5 | API routes: `GET /api/newspaper/today`, `GET /api/newspaper/edition/:id`, `GET /api/newspaper/archive` |
| **Week 2** | |
| Day 1–3 | `src/newspaper/frontend.ts` — inline HTML newspaper layout (front page + section views) |
| Day 3–4 | Article detail view (just shows title, source, link, metrics — no summary yet) |
| Day 4–5 | Wire into cron `postProcess` hook — auto-build edition after digest jobs complete |
| Day 5 | Read state sync, archive view, testing |

**MVP ships with:** Front page, 4 sections, article links, read tracking, archive. No AI summaries.

### Phase 2: v1 (6 weeks, weeks 3–8)

**Goal:** AI distillation, content fetching, polished reading experience.

| Week | Deliverable |
|------|-------------|
| **Week 3** | Content fetcher — fetch top 10 article URLs, extract text, cache |
| **Week 4** | AI summarization pipeline — per-article summary + takeaways via runAgentTurn |
| **Week 5** | Edition summary, lead story selection, confidence display |
| **Week 6** | Topic tagging + basic clustering (group related articles) |
| **Week 7** | UI polish — typography, responsive layout, dark mode, reading progress |
| **Week 8** | Fuzzy title dedup, related articles, testing + hardening |

### Phase 3: Evolution (months 2–3)

| Feature | When |
|---------|------|
| Topic trends ("AI safety" trending up this week) | Month 2 |
| Telegram inline digest (formatted summary in chat) | Month 2 |
| Weekly recap edition (AI-generated week-in-review) | Month 2 |
| Search across editions | Month 3 |
| Bookmarks / save for later | Month 3 |
| New feed sources (add RSS URL via config) | Month 3 |
| Push notifications for breaking stories (high-score threshold) | Month 3 |

---

## 8. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **AI hallucination in summaries** | High — presents false info as news | Medium | Never summarize without source content. Confidence threshold. "AI-generated" labels. No AI headlines. |
| **Content scraping blocks** | Medium — no article text to summarize | High | Graceful fallback to title-only. Respect robots.txt. Rotate User-Agent. Don't retry blocked URLs. |
| **Rate limits on Reddit/HN APIs** | Medium — missing articles | Low | Already handled in scripts (timeouts, error handling). Keep request volume low (2x/day). |
| **Google News RSS changes** | High — US/World feed breaks | Low | RSS is stable. Monitor for empty sections. Alert via existing heartbeat system. |
| **Stale content** | Low — showing yesterday's news as today's | Medium | Edition timestamp prominently displayed. Auto-archive editions older than 48h from front page. |
| **Bias in AI summaries** | Medium — editorializing | Low | Prompt explicitly says "do not editorialize." Confidence scoring. Original always linked. |
| **Copyright/licensing** | Medium — reproducing article content | Low | Only show AI summaries (transformative use). Always link to original. Never reproduce full text. Summaries are 3–5 sentences max. |
| **Storage growth** | Low — disk fills up | Very Low | 60 records/day × 2KB = ~44MB/year. Add retention cleanup (delete editions > 90 days) in Phase 2. |
| **X/Twitter scraping instability** | Low — X feed is already flaky | High | Already handled — falls back to "UNAVAILABLE." Newspaper shows what's available. |

---

## 9. Operational Plan

### Scheduling

```
Existing cron jobs (unchanged):
  news-digest:  0 6,18 * * *  CT
  ai-news:      30 6,21 * * *  CT
  ph-digest:    0 6,21 * * *  CT

New post-processing (added):
  After each digest job completes → trigger edition build
  Edition build merges all digests from the current slot (morning/evening)
  Wait for all 3 jobs to complete before building edition (use 15-min window)
```

**Implementation:** Add a `postProcess` callback to `src/cron.ts` script job handling. After a digest job finishes, check if all 3 feeds for the current slot have completed. If yes, build edition.

Alternatively, add a 4th cron job that runs 15 minutes after the latest feed:

```json
{
  "id": "newspaper-build",
  "schedule": { "kind": "cron", "expr": "45 6,21 * * *", "tz": "America/Chicago" },
  "payload": { "kind": "script", "script": "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost:18790/api/newspaper/build" }
}
```

**Recommended:** The 4th cron job approach. Simpler, decoupled, debuggable.

### Observability

| What | How |
|------|-----|
| Edition build success/failure | Audit log trace (existing `src/audit.ts`) |
| Articles per edition | Log at build time: `[newspaper] Built edition 2026-04-11-morning: 28 articles, 4 sections` |
| AI summarization errors | Log + set `confidence: 0` on failed articles |
| Content fetch failures | Log URL + error. Track failure rate per domain. |
| Dashboard page load time | Browser `performance.now()` logged to console |
| Feed health | If a section has 0 articles, send alert via active channel (Telegram/Discord) |

### Moderation & Editorial Controls

- **Section ordering** in config: `newspaper.sections: ["us", "world", "ai", "ph"]` — reorder or hide sections.
- **Blocked domains**: `newspaper.blockedDomains: ["example.com"]` — skip articles from specific sources.
- **Manual lead story override**: `POST /api/newspaper/edition/:id/lead` — set a specific article as lead.
- **Article hide**: `DELETE /api/newspaper/edition/:id/articles/:articleId` — remove article from edition.
- **Minimum confidence threshold**: `newspaper.minConfidence: 0.5` — suppress low-confidence summaries.

**Recommended defaults:**

```json
{
  "newspaper": {
    "sections": ["us", "world", "ai", "ph"],
    "blockedDomains": [],
    "minConfidence": 0.5,
    "maxArticlesPerSection": 10,
    "fetchTopN": 10,
    "retentionDays": 90
  }
}
```

---

## 10. Monetization & Distribution (Optional)

These are ideas, not recommendations. The tool is personal-use. Include only if scope expands.

| Idea | Effort | Notes |
|------|--------|-------|
| **Email newsletter** | Low | Render edition as HTML email. Send via Mailgun/SES at 6am. |
| **Public read-only mode** | Low | Serve `/newspaper` without auth. Keep API endpoints authed. |
| **RSS feed output** | Low | Serve editions as RSS/Atom. Other tools can subscribe. |
| **Multi-user** | High | Personalized sections, per-user read state. Needs auth system. Not worth it for personal tool. |
| **API for other bots** | Low | Already JSON API. Document endpoints. Others can consume. |
| **Obsidian daily note integration** | Medium | Append edition summary to daily note as part of morning routine cron. |

**Recommended for personal use:** Obsidian integration (append top 5 headlines to daily note) and RSS output (consume in any reader). Both are low-effort, high-value.

---

## Appendix: File Map for Implementation

New files to create:

```
src/newspaper/
├── types.ts              # Edition, NormalizedArticle, Section
├── normalize.ts          # Parse digest output → NormalizedArticle[]
├── dedup.ts              # URL-exact + fuzzy title dedup
├── rank.ts               # Scoring + ordering
├── edition-builder.ts    # Orchestrates: normalize → dedup → rank → edition
├── storage.ts            # Save/load editions (JSON files)
├── summarize.ts          # AI pipeline (Phase 2)
├── content-fetcher.ts    # Fetch article URLs, extract text (Phase 2)
└── frontend.ts           # Inline HTML/CSS/JS newspaper UI

src/__tests__/
├── newspaper-normalize.test.ts
├── newspaper-dedup.test.ts
├── newspaper-rank.test.ts
├── newspaper-edition-builder.test.ts
├── newspaper-storage.test.ts
└── newspaper-summarize.test.ts
```

Files to modify:

```
src/api.ts                # Add /api/newspaper/* routes
src/cron.ts               # Add post-process hook or new build job
src/types.ts              # Add NewspaperConfig to Config type
src/dashboard-frontend.ts # Add newspaper route registration
```
