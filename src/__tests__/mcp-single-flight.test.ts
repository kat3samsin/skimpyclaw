import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock mcporter so we can count how many times listTools is invoked when
// many concurrent callers ask for MCP discovery simultaneously.
const listToolsCalls = { count: 0 };
const listToolsConcurrent = { current: 0, max: 0 };
const closeCalls = { count: 0 };
const callToolState = {
  calls: 0,
  mode: 'ok' as 'ok' | 'pending' | 'retryable-error',
};
const toolFilter = { allowedTools: undefined as string[] | undefined };

async function mockToolCall(abortSignal?: AbortSignal) {
  callToolState.calls += 1;
  if (callToolState.mode === 'retryable-error') {
    throw new Error('session closed');
  }
  if (callToolState.mode === 'pending') {
    return new Promise((_resolve, reject) => {
      abortSignal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    });
  }
  return { content: [{ text: 'ok' }] };
}

vi.mock('mcporter', () => {
  return {
    createRuntime: vi.fn(async () => {
      return {
        listServers: () => ['fake-server'],
        listTools: vi.fn(async () => {
          listToolsCalls.count += 1;
          listToolsConcurrent.current += 1;
          listToolsConcurrent.max = Math.max(listToolsConcurrent.max, listToolsConcurrent.current);
          // Slow enough that overlapping callers would normally race.
          await new Promise(r => setTimeout(r, 30));
          listToolsConcurrent.current -= 1;
          return [
            { name: 'do-thing', description: 'd', inputSchema: { type: 'object', properties: {} } },
          ];
        }),
        getDefinition: () => ({ name: 'fake-server', ...toolFilter }),
        connect: vi.fn(async () => ({
          client: {
            callTool: vi.fn(async (_params, _schema, options) => mockToolCall(options?.signal)),
          },
        })),
        callTool: vi.fn(async () => mockToolCall()),
        close: vi.fn(async () => {
          closeCalls.count += 1;
        }),
      };
    }),
  };
});

describe('MCP single-flight guards', () => {
  beforeEach(async () => {
    listToolsCalls.count = 0;
    listToolsConcurrent.current = 0;
    listToolsConcurrent.max = 0;
    closeCalls.count = 0;
    callToolState.calls = 0;
    callToolState.mode = 'ok';
    toolFilter.allowedTools = undefined;
    const tools = await import('../tools.js');
    await tools.cleanupMcp();
    tools.clearMcpToolCache();
  });

  afterEach(async () => {
    const tools = await import('../tools.js');
    await tools.cleanupMcp();
    tools.clearMcpToolCache();
  });

  it('coalesces concurrent discoverMcpTools callers into a single discovery pass', async () => {
    const { discoverMcpTools } = await import('../tools.js');
    const results = await Promise.all([
      discoverMcpTools(),
      discoverMcpTools(),
      discoverMcpTools(),
      discoverMcpTools(),
      discoverMcpTools(),
    ]);
    for (const r of results) {
      expect(r.length).toBe(1);
    }
    // Without the single-flight guard each caller would trigger its own
    // listTools fan-out against the shared runtime.
    expect(listToolsCalls.count).toBe(1);
  });

  it('coalesces concurrent reconnectMcp callers', async () => {
    const tools = await import('../tools.js');
    // Prime a runtime so reconnect has something to close.
    await tools.discoverMcpTools();
    expect(listToolsCalls.count).toBe(1);

    await Promise.all([
      tools.reconnectMcp(),
      tools.reconnectMcp(),
      tools.reconnectMcp(),
      tools.reconnectMcp(),
    ]);

    // Exactly one close (the prior runtime) and one fresh discovery pass.
    expect(closeCalls.count).toBe(1);
    expect(listToolsCalls.count).toBe(2);
  });

  it('skips overlapping MCP health-check ticks', async () => {
    const tools = await import('../tools.js');
    await tools.discoverMcpTools();

    listToolsCalls.count = 0;
    listToolsConcurrent.current = 0;
    listToolsConcurrent.max = 0;

    await Promise.all([
      tools._runMcpHealthCheckForTesting(),
      tools._runMcpHealthCheckForTesting(),
      tools._runMcpHealthCheckForTesting(),
      tools._runMcpHealthCheckForTesting(),
    ]);

    expect(listToolsCalls.count).toBe(1);
    expect(listToolsConcurrent.max).toBe(1);
  });

  it('cancels only the affected in-flight MCP request', async () => {
    const tools = await import('../tools.js');
    const [definition] = await tools.discoverMcpTools();
    closeCalls.count = 0;
    callToolState.mode = 'pending';
    const controller = new AbortController();

    const call = tools.executeTool(
      definition.name,
      {},
      { enabled: true, allowedPaths: [] },
      { abortSignal: controller.signal },
    );
    await vi.waitFor(() => expect(callToolState.calls).toBe(1));
    controller.abort();

    await expect(call).resolves.toContain('cancelled');
    expect(closeCalls.count).toBe(0);
    expect(callToolState.calls).toBe(1);
  });

  it('does not interrupt another call on the same MCP server', async () => {
    const tools = await import('../tools.js');
    const [definition] = await tools.discoverMcpTools();
    closeCalls.count = 0;
    callToolState.mode = 'pending';
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = tools.executeTool(
      definition.name,
      {},
      { enabled: true, allowedPaths: [] },
      { abortSignal: firstController.signal },
    );
    await vi.waitFor(() => expect(callToolState.calls).toBe(1));
    callToolState.mode = 'ok';
    const second = tools.executeTool(
      definition.name,
      {},
      { enabled: true, allowedPaths: [] },
      { abortSignal: secondController.signal },
    );

    await expect(second).resolves.toBe('ok');
    firstController.abort();
    await expect(first).resolves.toContain('cancelled');
    expect(callToolState.calls).toBe(2);
    expect(closeCalls.count).toBe(0);
  });

  it('preserves mcporter tool allowlists on cancellable calls', async () => {
    const tools = await import('../tools.js');
    const [definition] = await tools.discoverMcpTools();
    toolFilter.allowedTools = ['different-tool'];

    const result = await tools.executeTool(
      definition.name,
      {},
      { enabled: true, allowedPaths: [] },
      { abortSignal: new AbortController().signal },
    );

    expect(result).toContain('not accessible');
    expect(callToolState.calls).toBe(0);
  });

  it('cancels MCP retry backoff without reconnecting or retrying', async () => {
    const tools = await import('../tools.js');
    const [definition] = await tools.discoverMcpTools();
    closeCalls.count = 0;
    callToolState.mode = 'retryable-error';
    const controller = new AbortController();

    const call = tools.executeTool(
      definition.name,
      {},
      { enabled: true, allowedPaths: [] },
      { abortSignal: controller.signal },
    );
    await vi.waitFor(() => expect(callToolState.calls).toBe(1));
    controller.abort();

    await expect(call).resolves.toContain('cancelled');
    expect(callToolState.calls).toBe(1);
    expect(closeCalls.count).toBe(0);
  });
});
