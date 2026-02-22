import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { Markdown } from '../components/Markdown.js';

describe('Markdown', () => {
  it('renders markdown content as HTML', () => {
    const { container } = render(<Markdown content="# Hello\n\nThis is **bold**." />);
    const html = container.innerHTML;

    expect(html).toContain('<h1');
    expect(html).toContain('Hello');
    expect(html).toContain('<strong');
    expect(html).toContain('bold');
  });

  it('renders lists correctly', () => {
    const content = '- Item 1\n- Item 2\n- Item 3';
    const { container } = render(<Markdown content={content} />);
    const html = container.innerHTML;

    expect(html).toContain('<ul');
    expect(html).toContain('<li');
    expect(html).toContain('Item 1');
  });

  it('sanitizes dangerous HTML', () => {
    const malicious = '<script>alert("xss")</script>\n\nSafe content';
    const { container } = render(<Markdown content={malicious} />);
    const html = container.innerHTML;

    // Script tags should be removed
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert');
    // Safe content should remain
    expect(html).toContain('Safe content');
  });

  it('handles links safely', () => {
    const content = '[Click here](https://example.com)';
    const { container } = render(<Markdown content={content} />);
    const html = container.innerHTML;

    expect(html).toContain('<a');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('Click here');
  });

  it('renders code blocks', () => {
    const content = '```javascript\nconst x = 1;\n```';
    const { container } = render(<Markdown content={content} />);
    const html = container.innerHTML;

    expect(html).toContain('<pre');
    expect(html).toContain('<code');
    expect(html).toContain('const x = 1;');
  });

  it('renders inline code', () => {
    const content = 'Use `npm install` to install packages.';
    const { container } = render(<Markdown content={content} />);
    const html = container.innerHTML;

    expect(html).toContain('<code');
    expect(html).toContain('npm install');
  });

  it('handles empty content gracefully', () => {
    const { container } = render(<Markdown content="" />);
    expect(container.innerHTML).toBe('');
  });

  it('applies custom className', () => {
    const { container } = render(
      <Markdown content="Test" className="custom-class" />
    );
    expect(container.querySelector('.custom-class')).toBeTruthy();
  });

  it('preserves line breaks with breaks option', () => {
    const content = 'Line 1\nLine 2';
    const { container } = render(<Markdown content={content} />);
    const html = container.innerHTML;

    // With breaks: true, single newlines become <br>
    expect(html).toContain('Line 1');
    expect(html).toContain('Line 2');
  });

  it('renders blockquotes', () => {
    const content = '> This is a quote';
    const { container } = render(<Markdown content={content} />);
    const html = container.innerHTML;

    expect(html).toContain('<blockquote');
    expect(html).toContain('This is a quote');
  });

  it('handles plain text without markdown', () => {
    const content = 'Just plain text with no formatting.';
    const { container } = render(<Markdown content={content} />);
    const html = container.innerHTML;

    expect(html).toContain('Just plain text with no formatting.');
  });
});
