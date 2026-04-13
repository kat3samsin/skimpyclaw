import type { Config } from '../types.js';
import { getDigests } from '../digests.js';
import { getLatestEdition, getTodayEdition } from './storage.js';

const SOURCE_GROUPS = [
  ['ai-news'],
  ['news', 'news-digest'],
  ['ph-news', 'ph-digest'],
  ['morning'],
] as const;

export interface NewspaperSourceStatus {
  id: string;
  name: string;
  latestDigestAt?: string;
  articleCount: number;
}

export interface NewspaperStatus {
  state: 'empty' | 'fresh' | 'stale';
  editionId?: string;
  editionCreatedAt?: string;
  editionArticleCount?: number;
  latestDigestAt?: string;
  sourceJobIds: string[];
  sources: NewspaperSourceStatus[];
}

function pickAvailableAlias(aliases: readonly string[]): string[] {
  const candidates = aliases
    .map(id => ({ id, digest: getDigests(id, 1)[0] }))
    .filter((item): item is { id: string; digest: NonNullable<ReturnType<typeof getDigests>[number]> } => Boolean(item.digest))
    .sort((a, b) => new Date(b.digest.createdAt).getTime() - new Date(a.digest.createdAt).getTime());

  return candidates.length > 0 ? [candidates[0].id] : [];
}

export function resolveNewspaperJobIds(config: Config): string[] {
  const configuredIds = new Set(config.cron.jobs.map(job => job.id));
  const resolved = SOURCE_GROUPS.flatMap(group => {
    const configuredMatches = group.filter(id => configuredIds.has(id));
    if (configuredMatches.length > 0) return configuredMatches;
    return pickAvailableAlias(group);
  });

  return Array.from(new Set(resolved));
}

export function getNewspaperStatus(config: Config): NewspaperStatus {
  const edition = getTodayEdition() || getLatestEdition();
  const sourceJobIds = resolveNewspaperJobIds(config);
  const sources = sourceJobIds.map(id => {
    const latest = getDigests(id, 1)[0];
    const configured = config.cron.jobs.find(job => job.id === id);
    return {
      id,
      name: configured?.name || id,
      latestDigestAt: latest?.createdAt,
      articleCount: latest?.articleCount ?? 0,
    };
  });

  const latestDigestAt = sources
    .map(source => source.latestDigestAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

  let state: NewspaperStatus['state'] = 'empty';
  if (edition) {
    state = latestDigestAt && new Date(latestDigestAt).getTime() > new Date(edition.createdAt).getTime()
      ? 'stale'
      : 'fresh';
  } else if (latestDigestAt) {
    state = 'stale';
  }

  return {
    state,
    editionId: edition?.id,
    editionCreatedAt: edition?.createdAt,
    editionArticleCount: edition?.articles.length,
    latestDigestAt,
    sourceJobIds,
    sources,
  };
}
