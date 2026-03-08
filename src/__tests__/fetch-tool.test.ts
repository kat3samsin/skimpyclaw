import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLookup = vi.hoisted(() => vi.fn());

vi.mock('dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

const { executeFetch } = await import('../tools/fetch-tool.js');

describe('fetch-tool SSRF protections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks localhost targets', async () => {
    const out = await executeFetch({ url: 'http://localhost:8080/secret' }, {} as any);
    expect(out).toContain('Error:');
    expect(out).toContain('Blocked host');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks hostnames resolving to private IPs', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    const out = await executeFetch({ url: 'https://example.test/data' }, {} as any);
    expect(out).toContain('Error:');
    expect(out).toContain('Blocked resolved IP');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks redirects to internal targets', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    mockFetch.mockResolvedValueOnce({
      status: 302,
      statusText: 'Found',
      headers: new Headers({ location: 'http://127.0.0.1/internal' }),
      text: async () => '',
    });

    const out = await executeFetch({ url: 'https://public.example/path' }, {} as any);
    expect(out).toContain('Error:');
    expect(out).toContain('Blocked target IP');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns response body for valid public targets', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    mockFetch.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'ok',
    });

    const out = await executeFetch({ url: 'https://example.com' }, {} as any);
    expect(out).toContain('HTTP 200 OK');
    expect(out).toContain('ok');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: 'manual' }),
    );
  });
});
