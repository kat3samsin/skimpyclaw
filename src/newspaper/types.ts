// The Daily Claw — Newspaper types

export type Section = 'us' | 'world' | 'ai' | 'ph' | 'business' | 'briefing' | 'editorials';

export const SECTION_LABELS: Record<Section, string> = {
  us: 'US Headlines',
  world: 'World',
  ai: 'AI & Tech',
  ph: 'Philippines',
  business: 'Business',
  briefing: 'Morning Briefing',
  editorials: 'Editorials',
};

export const ALL_SECTIONS: Section[] = ['us', 'world', 'ai', 'ph', 'business', 'briefing', 'editorials'];

export interface NormalizedArticle {
  id: string;               // MD5 of URL (first 12 chars)
  title: string;
  url: string;
  rawUrl?: string;
  sourceUrl?: string;
  sourceResolutionMethod?: 'primary' | 'source_url' | 'decoded_google_news' | 'invalid';
  source: string;            // "Hacker News", "Google News", "Reddit r/Philippines"
  section: Section;
  score?: number;
  comments?: number;
  author?: string;
  publishedAt?: string;
  rawContent?: string;       // original context from feed
  fetchedAt: string;         // ISO timestamp
}

export interface Article {
  id: string;
  title: string;
  url: string;
  rawUrl?: string;
  sourceUrl?: string;
  sourceResolutionMethod?: 'primary' | 'source_url' | 'decoded_google_news' | 'invalid';
  source: string;
  section: Section;
  rank: number;
  score?: number;
  comments?: number;
  author?: string;
  publishedAt?: string;
  fetchedContent?: string;
  summary?: string;
  keyTakeaways?: string[];
  topics?: string[];
  confidence?: number;
  sourceAttribution: string;
  read: boolean;
  relatedArticleIds?: string[];
  sources: { name: string; url: string }[];
}

export type EditionSlot = 'morning' | 'evening';

export interface Edition {
  id: string;                // e.g. "2026-04-11-morning"
  createdAt: string;         // ISO timestamp
  slot: EditionSlot;
  leadStoryId?: string;
  summary?: string;
  articles: Article[];
}

export interface EditionListItem {
  id: string;
  createdAt: string;
  slot: EditionSlot;
  articleCount: number;
  sections: Section[];
  leadStoryTitle?: string;
}

export interface EditionIndex {
  editions: EditionIndexEntry[];
}

export interface EditionIndexEntry {
  id: string;
  createdAt: string;
  slot: EditionSlot;
  articleCount: number;
}

/** Config for the newspaper feature. Added to Config.newspaper */
export interface NewspaperConfig {
  sections?: Section[];
  blockedDomains?: string[];
  minConfidence?: number;
  maxArticlesPerSection?: number;
  fetchTopN?: number;
  retentionDays?: number;
}

/** Maps cron job IDs to newspaper sections */
export const JOB_SECTION_MAP: Record<string, Section[]> = {
  news: ['us', 'world'],
  'news-digest': ['us', 'world', 'business'],
  'ai-news': ['ai'],
  'ph-news': ['ph'],
  'ph-digest': ['ph'],
  morning: ['briefing'],
};

/** Source weights for ranking */
export const SOURCE_WEIGHTS: Record<string, number> = {
  'Hacker News': 1.0,
  'Google News': 0.9,
  'Reddit r/MachineLearning': 0.8,
  'Reddit r/artificial': 0.8,
  'Reddit r/LocalLLaMA': 0.8,
  'Reddit r/Philippines': 0.7,
  'Reddit r/phinvest': 0.7,
  'Reddit r/CasualPH': 0.7,
  'X': 0.6,
};

export function getSourceWeight(source: string): number {
  // Exact match first
  if (source in SOURCE_WEIGHTS) return SOURCE_WEIGHTS[source];
  // Partial match for Reddit subs
  if (source.startsWith('Reddit')) return 0.75;
  // Default
  return 0.5;
}
