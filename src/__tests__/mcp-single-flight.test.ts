import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock mcporter so we can count how many times listTools is invoked when
// many concurrent callers ask for MCP discovery simultaneously.
const listToolsCalls = { count: 0 };
const closeCalls = { count: 0 };

vi.mock('mcporter', () => {
  return {
    createRuntime: vi.fn(async () => {
      return {
        listServers: () => ['fake-server'],
        listTools: vi.fn(async () => {
          listToolsCalls.count += 1;
          // Slow enough that overlapping callers would normally race.
          await new Promise(r => setTimeout(r, 30));
          return [
            { name: 'do-thing', description: 'd', inputSchema: { type: 'object', properties: {} } },
          ];
        }),
        callTool: vi.fn(async () => ({ content: [{ text: 'ok' }] })),
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
    closeCalls.count = 0;
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
});
