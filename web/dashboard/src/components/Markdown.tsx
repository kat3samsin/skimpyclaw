import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface MarkdownProps {
  content: string;
  className?: string;
  style?: Record<string, string | number>;
}

/**
 * Safely renders markdown content as HTML.
 * - Parses markdown using marked
 * - Sanitizes output with DOMPurify to prevent XSS
 * - Preserves line breaks and formatting
 */
export function Markdown({ content, className, style }: MarkdownProps) {
  if (!content) {
    return null;
  }

  // Parse markdown to HTML
  const rawHtml = marked.parse(content, {
    breaks: true, // Convert single line breaks to <br>
    gfm: true,    // Enable GitHub Flavored Markdown
  }) as string;

  // Sanitize to prevent XSS
  const cleanHtml = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr',
      'strong', 'em', 'b', 'i', 'u', 'code', 'pre',
      'ul', 'ol', 'li',
      'blockquote',
      'a',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'span', 'div',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  });

  return (
    <div
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: cleanHtml }}
    />
  );
}
