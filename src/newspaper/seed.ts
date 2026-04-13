#!/usr/bin/env tsx
// Seed script: generates sample newspaper data for local development.
// Usage: npx tsx src/newspaper/seed.ts

import { saveEdition } from './storage.js';
import type { Edition, Article, Section } from './types.js';
import { createHash } from 'crypto';

function makeId(url: string): string {
  return createHash('md5').update(url).digest('hex').slice(0, 12);
}

function makeArticle(
  title: string,
  url: string,
  source: string,
  section: Section,
  rank: number,
  score?: number,
  comments?: number,
): Article {
  return {
    id: makeId(url),
    title,
    url,
    source,
    section,
    rank,
    score,
    comments,
    sourceAttribution: source,
    read: false,
    sources: [{ name: source, url }],
  };
}

const now = new Date();
const dateStr = now.toISOString().split('T')[0];

const articles: Article[] = [
  // US Headlines
  makeArticle(
    'Fed Holds Interest Rates Steady Amid Inflation Concerns',
    'https://www.reuters.com/markets/us/fed-holds-rates-steady-2026-04',
    'Google News',
    'us',
    1,
    undefined,
    undefined,
  ),
  makeArticle(
    'Supreme Court to Hear Landmark Privacy Case This Term',
    'https://www.washingtonpost.com/politics/2026/scotus-privacy-case',
    'Google News',
    'us',
    4,
    undefined,
    undefined,
  ),
  makeArticle(
    'California Wildfire Season Starts Early, Evacuations Ordered',
    'https://www.latimes.com/california/story/2026-04-10/wildfire-season-early',
    'Google News',
    'us',
    7,
    undefined,
    undefined,
  ),
  makeArticle(
    'NASA Artemis IV Crew Announced for 2027 Moon Mission',
    'https://www.nasa.gov/news/artemis-iv-crew-announcement-2027',
    'Google News',
    'us',
    10,
    undefined,
    undefined,
  ),

  // World
  makeArticle(
    'Ukraine and Russia Agree to Extended Ceasefire',
    'https://www.bbc.com/news/world-europe-ukraine-ceasefire-2026',
    'Google News',
    'world',
    2,
    undefined,
    undefined,
  ),
  makeArticle(
    'EU Passes Comprehensive AI Regulation Framework',
    'https://www.reuters.com/technology/eu-ai-regulation-framework-2026',
    'Google News',
    'world',
    5,
    undefined,
    undefined,
  ),
  makeArticle(
    'Japan Economy Grows 2.1% in Q1, Exceeding Expectations',
    'https://www.nikkei.com/article/japan-gdp-q1-2026',
    'Google News',
    'world',
    9,
    undefined,
    undefined,
  ),

  // AI & Tech
  makeArticle(
    'Anthropic Releases Claude 5 with Multimodal Reasoning',
    'https://news.ycombinator.com/item?id=40001',
    'Hacker News',
    'ai',
    3,
    892,
    445,
  ),
  makeArticle(
    'Open-source LLM Surpasses GPT-4 on Coding Benchmarks',
    'https://news.ycombinator.com/item?id=40002',
    'Hacker News',
    'ai',
    6,
    567,
    312,
  ),
  makeArticle(
    'Show HN: I built a local-first AI code editor in Rust',
    'https://news.ycombinator.com/item?id=40003',
    'Hacker News',
    'ai',
    8,
    234,
    89,
  ),
  makeArticle(
    'DeepMind achieves breakthrough in protein-drug interaction prediction',
    'https://reddit.com/r/MachineLearning/comments/abc123/deepmind_protein',
    'Reddit r/MachineLearning',
    'ai',
    11,
    156,
    42,
  ),
  makeArticle(
    'The hidden cost of running LLMs: a deep dive into inference economics',
    'https://news.ycombinator.com/item?id=40004',
    'Hacker News',
    'ai',
    12,
    189,
    67,
  ),

  // Philippines
  makeArticle(
    'Manila Bay Rehabilitation Shows Progress After 2 Years',
    'https://reddit.com/r/Philippines/comments/xyz1/manila_bay',
    'Reddit r/Philippines',
    'ph',
    13,
    89,
    34,
  ),
  makeArticle(
    'Philippines GDP Growth Hits 6.5% in Q1 2026',
    'https://reddit.com/r/phinvest/comments/xyz2/gdp_growth',
    'Reddit r/phinvest',
    'ph',
    14,
    67,
    28,
  ),
  makeArticle(
    'Cebu Pacific Launches Direct Flights to 5 New Destinations',
    'https://reddit.com/r/Philippines/comments/xyz3/cebu_pacific',
    'Reddit r/Philippines',
    'ph',
    15,
    45,
    12,
  ),
];

// Select lead story (highest ranked AI story for demo)
const leadStoryId = articles[0].id; // Fed rates story — top ranked

const edition: Edition = {
  id: `${dateStr}-morning`,
  createdAt: now.toISOString(),
  slot: 'morning',
  leadStoryId: articles.find(a => a.section === 'ai' && a.rank === 3)?.id || leadStoryId,
  articles,
};

// Also create an evening edition from yesterday
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const yesterdayStr = yesterday.toISOString().split('T')[0];
const eveningEdition: Edition = {
  id: `${yesterdayStr}-evening`,
  createdAt: yesterday.toISOString(),
  slot: 'evening',
  leadStoryId: articles[0].id,
  articles: articles.slice(0, 8).map((a, i) => ({
    ...a,
    id: makeId(a.url + '-evening'),
    rank: i + 1,
    title: a.title + ' [Evening Update]',
  })),
};

console.log('[seed] Saving morning edition...');
saveEdition(edition);
console.log(`[seed] Saved ${edition.id} with ${edition.articles.length} articles`);

console.log('[seed] Saving yesterday evening edition...');
saveEdition(eveningEdition);
console.log(`[seed] Saved ${eveningEdition.id} with ${eveningEdition.articles.length} articles`);

console.log('[seed] Done! Visit /newspaper to see the front page.');
