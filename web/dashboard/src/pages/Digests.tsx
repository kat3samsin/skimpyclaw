import { useEffect, useState } from 'preact/hooks';
import { getDigest, getDigests } from '../api/client.js';
import type { Digest, DigestResponse } from '../types.js';
import { LuExternalLink, LuNewspaper, LuRefreshCw } from 'react-icons/lu';
import { Markdown } from '../components/Markdown.js';

export function Digests() {
  const [digests, setDigests] = useState<Digest[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DigestResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await getDigests();
      setDigests(data.digests ?? []);
    } finally {
      setLoading(false);
    }
  }

  async function openDigest(id: string) {
    setSelected(id);
    setDetailLoading(true);
    try {
      const data = await getDigest(id);
      setDetail(data);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }

  function formatDate(ts: string): string {
    const d = new Date(ts);
    return d.toLocaleString();
  }

  return (
    <div>
      <div class="page-header">
        <div class="page-title">Digests</div>
        <div class="header-actions">
          <button class="btn-refresh" onClick={() => void load()}>
            <LuRefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
          <div class="spinner" />
        </div>
      ) : digests.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state-icon"><LuNewspaper size={18} /></div>
          <div class="empty-state-text">No digests yet</div>
        </div>
      ) : (
        <div class="split">
          <div class="split-list">
            <div>
              {digests.map(d => (
                <button
                  key={d.id}
                  onClick={() => void openDigest(d.id)}
                  class={`list-item${selected === d.id ? ' active' : ''}`}
                  style={{ width: '100%', textAlign: 'left', border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', color: 'inherit' }}
                >
                  <div class="list-item-title">{d.jobName}</div>
                  <div class="list-item-sub">
                    {d.articleCount} article{d.articleCount === 1 ? '' : 's'} · {formatDate(d.createdAt)}
                  </div>
                  {d.preview?.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.45 }}>
                      {d.preview[0]}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div class="split-detail">
            {!selected ? (
              <div class="empty-state" style={{ padding: '32px 0' }}>
                <div class="empty-state-text">Select a digest</div>
              </div>
            ) : detailLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '32px' }}>
                <div class="spinner" />
              </div>
            ) : !detail ? (
              <div class="empty-state" style={{ padding: '32px 0' }}>
                <div class="empty-state-text">Failed to load digest</div>
              </div>
            ) : (
              <div>
                <div class="digest-header">
                  <div class="digest-title">{detail.jobName}</div>
                  <div class="digest-meta">{formatDate(detail.createdAt)}</div>
                </div>

                {detail.summary && detail.summary.trim().length > 0 && (
                  <Markdown
                    content={detail.summary}
                    className="digest-reader markdown-content"
                    style={{ marginBottom: 12 }}
                  />
                )}

                {detail.articles?.length > 0 ? (
                  <div class="digest-articles">
                    {detail.articles.map(article => (
                      <div key={article.id} class="digest-article-card">
                        <div class="source-badge">{article.source}</div>
                        <a href={article.url} target="_blank" rel="noreferrer" class="article-title">
                          {article.title} <LuExternalLink size={12} />
                        </a>
                        {(article.score !== undefined || article.comments !== undefined) && (
                          <div class="article-stats">
                            {article.score !== undefined ? `Score ${article.score}` : ''}
                            {article.comments !== undefined ? `${article.score !== undefined ? ' · ' : ''}${article.comments} comments` : ''}
                          </div>
                        )}
                        {article.summary && (
                          <Markdown
                            content={article.summary}
                            className="markdown-content"
                            style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 8 }}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                ) : !detail.summary ? (
                  <div class="empty-state" style={{ padding: '24px 0' }}>
                    <div class="empty-state-text">No content in this digest</div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
