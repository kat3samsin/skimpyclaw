import { useMemo } from 'preact/hooks';

interface MarkdownViewProps {
  content: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^(https?:|mailto:|\/|#)/i.test(trimmed)) return trimmed;
  return '#';
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) => {
    const safe = escapeHtml(sanitizeUrl(href));
    return `<a href="${safe}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  return out;
}

function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let paragraphLines: string[] = [];

  function closeList() {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = null;
  }

  function closeParagraph() {
    if (paragraphLines.length === 0) return;
    html.push(`<p>${renderInline(paragraphLines.join(' '))}</p>`);
    paragraphLines = [];
  }

  function closeCode() {
    if (!inCode) return;
    html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    codeLines = [];
    inCode = false;
  }

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      closeParagraph();
      closeList();
      if (inCode) closeCode();
      else inCode = true;
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
      closeParagraph();
      if (listType !== 'ul') {
        closeList();
        listType = 'ul';
        html.push('<ul>');
      }
      html.push(`<li>${renderInline(ul[1])}</li>`);
      continue;
    }

    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      closeParagraph();
      if (listType !== 'ol') {
        closeList();
        listType = 'ol';
        html.push('<ol>');
      }
      html.push(`<li>${renderInline(ol[1])}</li>`);
      continue;
    }

    if (line.trim() === '') {
      closeParagraph();
      closeList();
      continue;
    }

    closeList();
    if (line.startsWith('> ')) {
      closeParagraph();
      html.push(`<blockquote>${renderInline(line.slice(2))}</blockquote>`);
      continue;
    }

    paragraphLines.push(line.trim());
  }

  closeParagraph();
  closeList();
  closeCode();

  return html.join('\n');
}

export function MarkdownView({ content }: MarkdownViewProps) {
  const html = useMemo(() => renderMarkdown(content || ''), [content]);
  return <div class="markdown-view" dangerouslySetInnerHTML={{ __html: html }} />;
}
