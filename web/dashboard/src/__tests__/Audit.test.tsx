import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { prettyJson, parseDetail, formatEventContent, formatEventDuration } from '../pages/Audit.js';
import { Audit } from '../pages/Audit.js';

// Mock react-icons to avoid preact internals conflict in jsdom
vi.mock('react-icons/lu', () => ({
  LuRefreshCw: () => null,
  LuSearch: () => null,
  LuChevronDown: () => null,
  LuChevronRight: () => null,
}));

// Mock the API client
vi.mock('../api/client.js', () => ({
  getAudit: vi.fn(),
}));

import { getAudit } from '../api/client.js';

// ---------------------------------------------------------------------------
// prettyJson utility (kept for backward compat / non-UI use)
// ---------------------------------------------------------------------------
describe('prettyJson', () => {
  it('pretty-prints a plain object with 2-space indentation', () => {
    const result = prettyJson({ foo: 'bar', n: 42 });
    expect(result).toBe('{\n  "foo": "bar",\n  "n": 42\n}');
  });

  it('pretty-prints a nested object', () => {
    const result = prettyJson({ a: { b: 1 } });
    expect(result).toContain('"a"');
    expect(result).toContain('"b": 1');
    // Should have indentation
    expect(result).toMatch(/\n {4}/);
  });

  it('parses and pretty-prints a valid JSON string', () => {
    const input = '{"key":"value","num":1}';
    const result = prettyJson(input);
    expect(result).toBe('{\n  "key": "value",\n  "num": 1\n}');
  });

  it('returns an invalid JSON string as-is without crashing', () => {
    const input = 'not json at all';
    const result = prettyJson(input);
    expect(result).toBe('not json at all');
  });

  it('handles arrays', () => {
    const result = prettyJson([1, 2, 3]);
    expect(result).toBe('[\n  1,\n  2,\n  3\n]');
  });

  it('handles null values inside objects', () => {
    const result = prettyJson({ x: null });
    expect(result).toContain('"x": null');
  });
});

// ---------------------------------------------------------------------------
// parseDetail utility
// ---------------------------------------------------------------------------
describe('parseDetail', () => {
  it('returns an object as-is', () => {
    const obj = { tool: 'Read', path: '/tmp/x' };
    expect(parseDetail(obj)).toEqual(obj);
  });

  it('parses a valid JSON string to an object', () => {
    const input = '{"key":"value","num":1}';
    const result = parseDetail(input);
    expect(result).toEqual({ key: 'value', num: 1 });
  });

  it('returns a plain string unchanged when not parseable JSON', () => {
    expect(parseDetail('not json')).toBe('not json');
  });

  it('returns a plain string unchanged when JSON parses to non-object', () => {
    // A JSON array or scalar should still be returned (not coerced to object)
    expect(parseDetail('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('returns null as-is', () => {
    expect(parseDetail(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatEventContent utility
// ---------------------------------------------------------------------------
describe('formatEventContent', () => {
  it('formats tool_use event with tool field as ToolName({args})', () => {
    const ev = {
      type: 'tool_use',
      summary: 'Called Read',
      durationMs: 10,
      detail: { tool: 'Read', file_path: '/tmp/x.txt' },
    };
    const result = formatEventContent(ev);
    expect(result).toBe('Read({file_path: "/tmp/x.txt"})');
  });

  it('formats tool_use event with name field as ToolName({args})', () => {
    const ev = {
      type: 'tool_use',
      summary: 'Called Write',
      durationMs: 10,
      detail: { name: 'Write', content: 'hello' },
    };
    const result = formatEventContent(ev);
    expect(result).toBe('Write({content: "hello"})');
  });

  it('formats tool_use with no tool name as {args}', () => {
    const ev = {
      type: 'tool_use',
      summary: 'Some call',
      durationMs: 10,
      detail: { command: 'ls', cwd: '/tmp' },
    };
    const result = formatEventContent(ev);
    expect(result).toBe('{command: "ls", cwd: "/tmp"}');
  });

  it('falls back to summary for tool_use with no detail', () => {
    const ev = {
      type: 'tool_use',
      summary: 'Read something',
      durationMs: 10,
    };
    const result = formatEventContent(ev);
    expect(result).toBe('Read something');
  });

  it('uses summary for non-tool events', () => {
    const ev = {
      type: 'response',
      summary: 'Agent replied',
      durationMs: 50,
    };
    const result = formatEventContent(ev);
    expect(result).toBe('Agent replied');
  });

  it('appends compact detail fragments to summary for non-tool events with object detail', () => {
    const ev = {
      type: 'script',
      summary: 'Ran script',
      durationMs: 100,
      detail: { exit: 0, cmd: 'ls' },
    };
    const result = formatEventContent(ev);
    expect(result).toContain('Ran script');
    expect(result).toContain('exit: 0');
    expect(result).toContain('cmd: ls');
  });

  it('uses plain string detail as fallback when no summary', () => {
    const ev = {
      type: 'error',
      summary: '',
      durationMs: 5,
      detail: 'ENOENT: no such file',
    };
    const result = formatEventContent(ev);
    expect(result).toBe('ENOENT: no such file');
  });

  it('truncates very long string values in tool_use args', () => {
    const longVal = 'a'.repeat(100);
    const ev = {
      type: 'tool_use',
      summary: 'Long',
      durationMs: 1,
      detail: { tool: 'Write', content: longVal },
    };
    const result = formatEventContent(ev);
    // Value should be truncated to ≤63 chars + quotes
    expect(result.length).toBeLessThan(120);
    expect(result).toContain('...');
  });
});

// ---------------------------------------------------------------------------
// formatEventDuration utility
// ---------------------------------------------------------------------------
describe('formatEventDuration', () => {
  it('returns empty string for undefined', () => {
    expect(formatEventDuration(undefined)).toBe('');
  });

  it('returns ms format for durations under 1000ms', () => {
    expect(formatEventDuration(120)).toBe('120ms');
    expect(formatEventDuration(0)).toBe('0ms');
    expect(formatEventDuration(999)).toBe('999ms');
  });

  it('returns seconds format for durations 1000ms and above', () => {
    expect(formatEventDuration(1000)).toBe('1.0s');
    expect(formatEventDuration(2400)).toBe('2.4s');
    expect(formatEventDuration(10000)).toBe('10.0s');
  });
});

// ---------------------------------------------------------------------------
// Audit component rendering
// ---------------------------------------------------------------------------
const mockTrace = {
  traceId: 'abc12345-0000-0000-0000-000000000000',
  trigger: 'telegram',
  status: 'success' as const,
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  events: [
    {
      type: 'tool_use',
      summary: 'Called Read tool',
      durationMs: 120,
      detail: { tool: 'Read', path: '/tmp/foo.txt' },
    },
    {
      type: 'response',
      summary: 'Agent responded',
      durationMs: 80,
    },
  ],
};

const mockTraceWithJsonStringDetail = {
  traceId: 'def45678-0000-0000-0000-000000000000',
  trigger: 'cron',
  status: 'success' as const,
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  events: [
    {
      type: 'tool_use',
      summary: 'JSON string detail',
      durationMs: 50,
      detail: '{"tool":"Bash","command":"ls","exitCode":0}',
    },
  ],
};

const mockTraceWithPlainStringDetail = {
  traceId: 'ghi78901-0000-0000-0000-000000000000',
  trigger: 'system',
  status: 'error' as const,
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  events: [
    {
      type: 'error',
      summary: 'Something broke',
      durationMs: 10,
      detail: 'ENOENT: no such file or directory',
    },
  ],
};

const mockTraceNoDetail = {
  traceId: 'bcd23456-0000-0000-0000-000000000000',
  trigger: 'cron',
  status: 'success' as const,
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  events: [
    { type: 'script', summary: 'Ran script', durationMs: 200 },
  ],
};

describe('Audit component', () => {
  beforeEach(() => {
    vi.mocked(getAudit).mockResolvedValue({
      traces: [mockTrace, mockTraceNoDetail],
      total: 2,
    });
  });

  it('renders trace cards', async () => {
    const { findByText } = render(<Audit />);
    await findByText('Called Read tool');
  });

  it('does not show expanded rows before clicking', async () => {
    const { container, findByText } = render(<Audit />);
    await findByText('Called Read tool');
    expect(container.querySelectorAll('.audit-event-row').length).toBe(0);
    expect(container.querySelectorAll('.audit-kv-list').length).toBe(0);
  });

  it('shows all event rows after expanding a card', async () => {
    const { container, findByText } = render(<Audit />);
    await findByText('Called Read tool');

    const heads = container.querySelectorAll('.audit-card-head');
    fireEvent.click(heads[0]); // first trace: 2 events

    const rows = container.querySelectorAll('.audit-event-row');
    expect(rows.length).toBe(2);
  });

  it('renders tool_use event row with tool call formatting', async () => {
    const { container, findByText } = render(<Audit />);
    await findByText('Called Read tool');

    const heads = container.querySelectorAll('.audit-card-head');
    fireEvent.click(heads[0]);

    const rows = container.querySelectorAll('.audit-event-row');
    const firstRow = rows[0];

    // Type label
    const typeLabel = firstRow.querySelector('.audit-event-type-label');
    expect(typeLabel?.textContent).toBe('tool_use');

    // Content should be monospace tool call
    const content = firstRow.querySelector('.audit-event-content.mono');
    expect(content).not.toBeNull();
    expect(content?.textContent).toContain('Read(');

    // Duration
    const dur = firstRow.querySelector('.audit-event-dur');
    expect(dur?.textContent).toBe('120ms');
  });

  it('renders non-tool event row with summary text', async () => {
    const { container, findByText } = render(<Audit />);
    await findByText('Called Read tool');

    const heads = container.querySelectorAll('.audit-card-head');
    fireEvent.click(heads[0]);

    const rows = container.querySelectorAll('.audit-event-row');
    const secondRow = rows[1]; // 'response' event

    const typeLabel = secondRow.querySelector('.audit-event-type-label');
    expect(typeLabel?.textContent).toBe('response');

    const content = secondRow.querySelector('.audit-event-content');
    expect(content?.textContent).toBe('Agent responded');

    const dur = secondRow.querySelector('.audit-event-dur');
    expect(dur?.textContent).toBe('80ms');
  });

  it('renders event row with no duration gracefully', async () => {
    vi.mocked(getAudit).mockResolvedValue({
      traces: [{
        traceId: 'nodur-0000-0000-0000-000000000000',
        trigger: 'system',
        status: 'running' as const,
        startedAt: new Date().toISOString(),
        events: [{ type: 'response', summary: 'In progress' }],
      }],
      total: 1,
    });

    const { container, findByText } = render(<Audit />);
    await findByText('In progress');

    fireEvent.click(container.querySelector('.audit-card-head')!);
    const dur = container.querySelector('.audit-event-dur');
    expect(dur?.textContent).toBe('');
  });

  it('collapses detail on second click', async () => {
    const { container, findByText } = render(<Audit />);
    await findByText('Called Read tool');

    const heads = container.querySelectorAll('.audit-card-head');
    fireEvent.click(heads[0]);
    expect(container.querySelectorAll('.audit-event-row').length).toBeGreaterThan(0);

    fireEvent.click(heads[0]);
    expect(container.querySelectorAll('.audit-event-row').length).toBe(0);
  });

  it('makes cards with events expandable (including no-detail events)', async () => {
    const { container, findByText } = render(<Audit />);
    await findByText('Called Read tool');

    const cards = container.querySelectorAll('.audit-card');
    // Both cards have events — both should be expandable
    expect(cards[0].classList.contains('audit-card-expandable')).toBe(true);
    expect(cards[1].classList.contains('audit-card-expandable')).toBe(true);
  });

  it('renders event rows for trace with only no-detail events', async () => {
    const { container, findByText } = render(<Audit />);
    await findByText('Called Read tool');

    const heads = container.querySelectorAll('.audit-card-head');
    fireEvent.click(heads[1]); // no-detail trace

    const rows = container.querySelectorAll('.audit-event-row');
    expect(rows.length).toBe(1);

    const content = rows[0].querySelector('.audit-event-content');
    expect(content?.textContent).toBe('Ran script');
  });

  it('renders tool_use from a JSON string detail', async () => {
    vi.mocked(getAudit).mockResolvedValue({
      traces: [mockTraceWithJsonStringDetail],
      total: 1,
    });

    const { container, findByText } = render(<Audit />);
    await findByText('JSON string detail');

    fireEvent.click(container.querySelector('.audit-card-head')!);

    const content = container.querySelector('.audit-event-content.mono');
    expect(content).not.toBeNull();
    expect(content?.textContent).toContain('Bash(');
  });

  it('renders plain string detail as summary fallback', async () => {
    vi.mocked(getAudit).mockResolvedValue({
      traces: [mockTraceWithPlainStringDetail],
      total: 1,
    });

    const { container, findByText } = render(<Audit />);
    await findByText('Something broke');

    fireEvent.click(container.querySelector('.audit-card-head')!);

    const rows = container.querySelectorAll('.audit-event-row');
    expect(rows.length).toBe(1);

    // Content should show summary (since summary is non-empty)
    const content = rows[0].querySelector('.audit-event-content');
    expect(content?.textContent).toContain('Something broke');
  });

  it('sets aria-expanded=false on expandable card heads initially', async () => {
    const { container, findByText } = render(<Audit />);
    await findByText('Called Read tool');

    const heads = container.querySelectorAll('.audit-card-head');
    // Both cards now have events → both expandable
    expect(heads[0].getAttribute('aria-expanded')).toBe('false');
    expect(heads[0].getAttribute('role')).toBe('button');
    expect(heads[0].getAttribute('tabindex')).toBe('0');
    expect(heads[1].getAttribute('aria-expanded')).toBe('false');
    expect(heads[1].getAttribute('role')).toBe('button');
  });

  it('sets aria-expanded=true after expanding', async () => {
    const { container, findByText } = render(<Audit />);
    await findByText('Called Read tool');

    const heads = container.querySelectorAll('.audit-card-head');
    fireEvent.click(heads[0]);
    expect(heads[0].getAttribute('aria-expanded')).toBe('true');
  });

  it('toggles expansion via Enter key', async () => {
    const { container, findByText } = render(<Audit />);
    await findByText('Called Read tool');

    const heads = container.querySelectorAll('.audit-card-head');
    fireEvent.keyDown(heads[0], { key: 'Enter' });

    expect(container.querySelectorAll('.audit-event-row').length).toBeGreaterThan(0);
    expect(heads[0].getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(heads[0], { key: 'Enter' });
    expect(container.querySelectorAll('.audit-event-row').length).toBe(0);
    expect(heads[0].getAttribute('aria-expanded')).toBe('false');
  });

  it('toggles expansion via Space key', async () => {
    const { container, findByText } = render(<Audit />);
    await findByText('Called Read tool');

    const heads = container.querySelectorAll('.audit-card-head');
    fireEvent.keyDown(heads[0], { key: ' ' });

    expect(container.querySelectorAll('.audit-event-row').length).toBeGreaterThan(0);
  });

  it('has aria-label on expandable card heads', async () => {
    const { container, findByText } = render(<Audit />);
    await findByText('Called Read tool');

    const heads = container.querySelectorAll('.audit-card-head');
    expect(heads[0].getAttribute('aria-label')).toBe('Toggle details for trace abc12345');
  });
});
