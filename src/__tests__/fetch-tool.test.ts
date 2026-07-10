import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLookup = vi.hoisted(() => vi.fn());
const mockAgents = vi.hoisted(() => [] as Array<{
  options: any;
  close: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}>);

vi.mock('dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

vi.mock('undici', () => ({
  Agent: class MockAgent {
    options: any;
    close = vi.fn(async () => {});
    destroy = vi.fn(() => {});

    constructor(options: any) {
      this.options = options;
      mockAgents.push(this);
    }
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

const { executeFetch } = await import('../tools/fetch-tool.js');

describe('fetch-tool SSRF protections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgents.length = 0;
  });

  it('blocks localhost targets', async () => {
    const out = await executeFetch({ url: 'http://localhost:8080/secret' }, {} as any);
    expect(out).toContain('Error:');
    expect(out).toContain('Blocked host');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks non-http protocols', async () => {
    const out = await executeFetch({ url: 'file:///etc/passwd' }, {} as any);
    expect(out).toContain('Error:');
    expect(out).toContain('Unsupported protocol');
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

  it('re-validates DNS on each redirect hop', async () => {
    mockLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    mockFetch
      .mockResolvedValueOnce({
        status: 302,
        statusText: 'Found',
        headers: new Headers({ location: 'https://example.com/next' }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: async () => 'ok',
      });

    const out = await executeFetch({ url: 'https://example.com/start' }, {} as any);
    expect(out).toContain('HTTP 200 OK');
    expect(mockLookup).toHaveBeenCalledTimes(2);
    expect(mockAgents).toHaveLength(2);
    expect(mockAgents[0].close).toHaveBeenCalledTimes(1);
    expect(mockAgents[1].close).toHaveBeenCalledTimes(1);
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

  it('pins the request connection to the addresses validated before fetch', async () => {
    const validated = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];
    mockLookup.mockResolvedValueOnce(validated);
    mockFetch.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'ok',
    });

    const out = await executeFetch({ url: 'https://example.com' }, {} as any);

    expect(out).toContain('HTTP 200 OK');
    expect(mockAgents).toHaveLength(1);
    expect(mockFetch.mock.calls[0][1].dispatcher).toBe(mockAgents[0]);
    const pinned = await new Promise((resolve, reject) => {
      mockAgents[0].options.connect.lookup('example.com', { all: true }, (error: Error | null, addresses: unknown) => {
        if (error) reject(error);
        else resolve(addresses);
      });
    });
    expect(pinned).toEqual(validated);
    expect(mockAgents[0].close).toHaveBeenCalledTimes(1);
    expect(mockAgents[0].destroy).not.toHaveBeenCalled();
  });

  it('passes caller cancellation to an in-flight request', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const controller = new AbortController();
    mockFetch.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }));

    const request = executeFetch(
      { url: 'https://example.com/slow' },
      {} as any,
      controller.signal,
    );
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(request).resolves.toContain('cancelled');
    expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(mockAgents[0].destroy).toHaveBeenCalledTimes(1);
    expect(mockAgents[0].close).not.toHaveBeenCalled();
  });

  it('keeps cancellation active while reading a response body', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const controller = new AbortController();
    let bodyStarted = false;
    mockFetch.mockImplementationOnce((_url, init) => Promise.resolve({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: () => new Promise((_resolve, reject) => {
        bodyStarted = true;
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }),
    }));

    const request = executeFetch(
      { url: 'https://example.com/slow-body' },
      {} as any,
      controller.signal,
    );
    await vi.waitFor(() => expect(bodyStarted).toBe(true));
    controller.abort();

    await expect(request).resolves.toContain('cancelled');
    expect(mockAgents[0].destroy).toHaveBeenCalledTimes(1);
    expect(mockAgents[0].close).not.toHaveBeenCalled();
  });

  it('blocks internal-style host suffixes', async () => {
    const out = await executeFetch({ url: 'https://service.internal/api' }, {} as any);
    expect(out).toContain('Error:');
    expect(out).toContain('Blocked internal host');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
