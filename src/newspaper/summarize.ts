// LLM-powered article summarization for newspaper editions

import { chat } from '../providers/index.js';
import type { Config, ChatMessage } from '../types.js';
import type { Article } from './types.js';

/** Summary result for a single article. */
export interface ArticleSummary {
  summary: string;
  whyItMatters?: string;
}

/** In-memory cache keyed by article ID to avoid duplicate LLM calls within a build. */
const summaryCache = new Map<string, ArticleSummary>();

/** Clear the summary cache (for testing). */
export function clearSummaryCache(): void {
  summaryCache.clear();
}

function hasResolvedCredential(value?: string): boolean {
  return Boolean(value && !value.includes('${'));
}

function getSummaryModel(config: Config): string | null {
  const providers = config.models?.providers ?? {};
  const aliases = config.models?.aliases ?? {};

  const anthropic = providers.anthropic;
  if (anthropic && (hasResolvedCredential(anthropic.apiKey) || hasResolvedCredential(anthropic.authToken))) {
    if (aliases['claude-fast']) return 'claude-fast';
    return 'anthropic/claude-haiku-4-5';
  }

  const codex = providers.codex;
  if (codex && (hasResolvedCredential(codex.authToken) || hasResolvedCredential(codex.authPath))) {
    if (aliases.codex) return 'codex';
    if (aliases['codex5.5']) return 'codex5.5';
    if (aliases['codex5.3']) return 'codex5.3';
    if (aliases['codex5.2']) return 'codex5.2';
    if (aliases['codex5.1']) return 'codex5.1';
    return 'codex/gpt-5.5';
  }

  const openai = providers.openai;
  if (openai && hasResolvedCredential(openai.apiKey)) {
    if (aliases['gpt-fast']) return 'gpt-fast';
    if (aliases.gpt) return 'gpt';
    return 'openai/gpt-4o-mini';
  }

  return null;
}

function isNewsSynthesisCandidate(article: Article): boolean {
  const source = article.source.toLowerCase();

  if (source.includes('hacker news')) return true;
  if (source.includes('news')) return true;

  try {
    const host = new URL(article.url).hostname.toLowerCase();
    if (host.includes('news.')) return true;
    if ([
      'nytimes.com',
      'wsj.com',
      'washingtonpost.com',
      'reuters.com',
      'apnews.com',
      'bloomberg.com',
      'bbc.com',
      'cnn.com',
      'theguardian.com',
      'npr.org',
      'axios.com',
      'cnbc.com',
      'ft.com',
      'economist.com',
      'techcrunch.com',
      'theverge.com',
      'arstechnica.com',
      'wired.com',
      'information.com',
    ].some(domain => host === domain || host.endsWith(`.${domain}`))) {
      return true;
    }
  } catch {
    // Ignore invalid URLs here; summarization will fall back to title/source only.
  }

  return false;
}

function buildSummaryPrompt(article: Article): string {
  const engagement = [
    article.score != null ? `Score: ${article.score}` : '',
    article.comments != null ? `Comments: ${article.comments}` : '',
  ].filter(Boolean).join('\n');

  const sourceKind = article.source.toLowerCase().includes('hacker news')
    ? 'Hacker News item'
    : 'news article';

  return `You are writing a front-page newspaper blurb for a ${sourceKind}.

Write in a crisp newsroom tone. Be specific, but do not invent facts that are not supported by the input.
If the available information is thin, say only what can be safely inferred from the title/source and keep the language restrained.

Title: ${article.title}
Source: ${article.source}
URL: ${article.url}
${engagement ? `${engagement}\n` : ''}${article.fetchedContent ? `Content: ${article.fetchedContent.slice(0, 3000)}\n` : ''}
Respond in this exact format (no markdown, no extra text):
SUMMARY: <2-3 sentence newspaper-style summary>
WHY: <1 sentence explaining why a reader should care>`;
}

/**
 * Generate a summary for a single article using the LLM.
 * Returns null if the provider is unavailable or the call fails.
 */
export async function summarizeArticle(
  article: Article,
  config: Config,
): Promise<ArticleSummary | null> {
  // Check cache first
  const cached = summaryCache.get(article.id);
  if (cached) return cached;

  if (!isNewsSynthesisCandidate(article)) return null;
  const model = getSummaryModel(config);
  if (!model) return null;
  const prompt = buildSummaryPrompt(article);

  const messages: ChatMessage[] = [
    { role: 'user', content: prompt },
  ];

  try {
    const response = await chat(
      messages,
      { model, maxTokens: 200, temperature: 0.3 },
      config,
    );

    const result = parseSummaryResponse(response);
    if (result) {
      summaryCache.set(article.id, result);
    }
    return result;
  } catch (err) {
    console.error(`[newspaper] Failed to summarize article ${article.id}:`, (err as Error).message);
    return null;
  }
}

/**
 * Parse the structured LLM response into summary fields.
 */
function parseSummaryResponse(response: string): ArticleSummary | null {
  const summaryMatch = response.match(/SUMMARY:\s*(.+?)(?:\n|$)/i);
  const whyMatch = response.match(/WHY:\s*(.+?)(?:\n|$)/i);

  if (!summaryMatch) return null;

  return {
    summary: summaryMatch[1].trim(),
    whyItMatters: whyMatch?.[1]?.trim(),
  };
}

/**
 * Summarize all articles in an edition, mutating in place.
 * Fails gracefully — articles without summaries keep their original content.
 * Uses concurrency limit to avoid overwhelming the provider.
 */
export async function summarizeEditionArticles(
  articles: Article[],
  config: Config,
  concurrency: number = 3,
): Promise<{ summarized: number; failed: number }> {
  let summarized = 0;
  let failed = 0;

  // Process in batches
  for (let i = 0; i < articles.length; i += concurrency) {
    const batch = articles.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async (article) => {
        // Skip if already has a summary
        if (article.summary) {
          summarized++;
          return;
        }

        const result = await summarizeArticle(article, config);
        if (result) {
          article.summary = result.summary;
          if (result.whyItMatters) {
            // Store in keyTakeaways for now (existing field)
            article.keyTakeaways = [result.whyItMatters];
          }
          summarized++;
        } else {
          failed++;
        }
      }),
    );
  }

  console.log(`[newspaper] Summarized ${summarized}/${articles.length} articles (${failed} failed)`);
  return { summarized, failed };
}
