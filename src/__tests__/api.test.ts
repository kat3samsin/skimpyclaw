import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Fastify, { FastifyInstance } from 'fastify';

// --- Build a temp directory to act as ~/.skimpyclaw ---
const TEST_ROOT = join(tmpdir(), `skimpyclaw-test-${Date.now()}`);
const SESSIONS_DIR = join(TEST_ROOT, 'sessions');
const LOGS_DIR = join(TEST_ROOT, 'logs');
const AGENT_DIR = join(TEST_ROOT, 'agents', 'default');
const MEMORY_DIR = join(AGENT_DIR, 'memory', 'logs');
const CONFIG_PATH = join(TEST_ROOT, 'config.json');
const TODO_PATH = join(TEST_ROOT, 'TODO.md');
const SKILLS_DIR = join(TEST_ROOT, 'skills');

const TEST_CONFIG = {
  gateway: { port: 18790, mode: 'local' as const },
  agents: {
    default: 'default',
    list: {
      default: {
        identity: { name: 'TestBot', emoji: '🤖' },
        model: 'claude-sonnet-4-20250514',
        thinking: 'none' as const,
      },
    },
  },
  models: {
    providers: {
      anthropic: { apiKey: 'sk-ant-test-secret-key' },
    },
    aliases: { fast: 'claude-haiku-4-20250414', smart: 'claude-sonnet-4-20250514' },
  },
  channels: {
    telegram: { enabled: false, token: 'tg-secret-token', allowFrom: [] },
    discord: { enabled: false, token: 'discord-secret-token', allowFrom: [] },
  },
  cron: {
    jobs: [
      {
        id: 'daily-check',
        name: 'Daily Check',
        schedule: { kind: 'cron' as const, expr: '0 9 * * *', tz: 'America/Chicago' },
        payload: { kind: 'agentTurn' as const, message: 'Good morning' },
        model: 'claude-sonnet-4-20250514',
      },
    ],
  },
  heartbeat: { intervalMs: 60000, prompt: 'heartbeat' },
  dashboard: { token: 'test-dashboard-token-123' },
  skills: { enabled: true, directory: SKILLS_DIR, entries: {} },
};

const AUTH_HEADERS = { authorization: 'Bearer test-dashboard-token-123' };

const mockCodeAgents = vi.hoisted(() => ({
  list: [
    {
      id: 'ca-1',
      agent: 'claude',
      status: 'running',
      task: 'test task',
      startedAt: '2026-02-21T10:00:00Z',
    },
  ] as any[],
}));

const mockApprovalsState = vi.hoisted(() => ({
  items: [
    {
      id: 'ap-1',
      command: 'npm test',
      status: 'pending',
      tier: 1,
      createdAt: '2026-02-21T10:00:00Z',
      expiresAt: '2026-02-21T10:10:00Z',
    },
    {
      id: 'ap-2',
      command: 'rm -rf /tmp/x',
      status: 'denied',
      tier: 3,
      createdAt: '2026-02-21T10:00:00Z',
      expiresAt: '2026-02-21T10:10:00Z',
    },
  ] as any[],
}));

const mockDigestsState = vi.hoisted(() => ({
  items: [
    {
      id: 'dg-1',
      jobId: 'daily-check',
      jobName: 'Daily Check',
      createdAt: '2026-02-21T10:00:00Z',
      summary: 'Digest summary',
      articles: [
        { id: 'a-1', title: 'Article 1', source: 'HN', url: 'https://example.com/1', read: false },
      ],
    },
  ] as any[],
}));

// --- Mock modules before importing api.ts ---

// Mock config.ts
vi.mock('../config.js', () => ({
  loadConfig: () => {
    // Read from disk to get fresh state (mirrors real behavior)
    const { readFileSync } = require('fs');
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  },
  loadRawConfig: () => {
    // Read from disk without env expansion
    const { readFileSync } = require('fs');
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  },
  getConfigPath: () => CONFIG_PATH,
  saveConfig: (config: any) => {
    const { writeFileSync } = require('fs');
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  },
  getSessionsDir: () => SESSIONS_DIR,
  getLogsDir: () => LOGS_DIR,
  getAgentDir: (agentId: string) => join(TEST_ROOT, 'agents', agentId),
  isValidAgentId: (agentId: string) => /^[a-zA-Z0-9_-]+$/.test(agentId),
  listMemoryFiles: (agentId: string) => {
    const { existsSync, readdirSync, statSync } = require('fs');
    const memDir = join(TEST_ROOT, 'agents', agentId, 'memory', 'logs');
    if (!existsSync(memDir)) return [];
    return readdirSync(memDir)
      .filter((f: string) => f.endsWith('.md'))
      .map((name: string) => {
        const stat = statSync(join(memDir, name));
        return { name, date: stat.mtime.toISOString(), size: stat.size };
      });
  },
  readMemoryFile: (agentId: string, filename: string) => {
    const { readFileSync, existsSync } = require('fs');
    const { basename } = require('path');
    if (filename.includes('..') || filename !== basename(filename)) {
      throw new Error('Invalid filename');
    }
    const filePath = join(TEST_ROOT, 'agents', agentId, 'memory', 'logs', filename);
    if (!existsSync(filePath)) {
      throw new Error('File not found');
    }
    return readFileSync(filePath, 'utf-8');
  },
}));

// Mock gateway.ts
let mockCurrentModel = 'claude-sonnet-4-20250514';
let mockLastMessage: Date | undefined = undefined;

const mockSetGatewayConfig = vi.fn();
vi.mock('../gateway.js', () => ({
  getCurrentModel: () => mockCurrentModel,
  setCurrentModel: (m: string) => { mockCurrentModel = m; },
  getLastMessage: () => mockLastMessage,
  setGatewayConfig: (...args: any[]) => mockSetGatewayConfig(...args),
}));

// Mock cron.ts
vi.mock('../cron.js', () => ({
  getCronJobs: () => [
    { id: 'daily-check', name: 'Daily Check', nextRun: new Date('2026-02-06T09:00:00Z') },
  ],
  getCronJobDetails: (config: any) =>
    config.cron.jobs.map((j: any) => ({
      id: j.id,
      name: j.name,
      schedule: { kind: j.schedule.kind, expr: j.schedule.expr, tz: j.schedule.tz },
      payload: { kind: j.payload.kind, message: j.payload.message },
      model: j.model,
      nextRun: new Date('2026-02-06T09:00:00Z'),
    })),
  triggerCronJob: (id: string, config: any) => {
    const job = config.cron.jobs.find((j: any) => j.id === id);
    if (!job) throw new Error(`Cron job not found: ${id}`);
    return { id: job.id, name: job.name };
  },
  initCron: (...args: any[]) => mockInitCron(...args),
}));

// Mock agent.ts
const mockInitProviders = vi.fn();
vi.mock('../agent.js', () => ({
  TEMPLATE_FILES: ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'BOOT.md', 'HEARTBEAT.md', 'MEMORY.md'],
  getAgentTemplateContent: (agentId: string, name: string) => {
    const TEMPLATE_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'BOOT.md', 'HEARTBEAT.md', 'MEMORY.md'];
    if (!TEMPLATE_FILES.includes(name)) return null;
    const { existsSync, readFileSync } = require('fs');
    const filePath = join(TEST_ROOT, 'agents', agentId, name);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  },
  saveAgentTemplate: (agentId: string, name: string, content: string) => {
    const TEMPLATE_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'BOOT.md', 'HEARTBEAT.md', 'MEMORY.md'];
    if (!TEMPLATE_FILES.includes(name)) {
      throw new Error(`Invalid template name: ${name}. Must be one of: ${TEMPLATE_FILES.join(', ')}`);
    }
    const { writeFileSync } = require('fs');
    writeFileSync(join(TEST_ROOT, 'agents', agentId, name), content, 'utf-8');
  },
  initProviders: (...args: any[]) => mockInitProviders(...args),
  runAgentTurn: vi.fn().mockResolvedValue('ok'),
}));

// Mock cron.ts additions for reload
const mockInitCron = vi.fn();

// Mock heartbeat.ts for reload
const mockInitHeartbeat = vi.fn();
const mockStopHeartbeat = vi.fn();
vi.mock('../heartbeat.js', () => ({
  initHeartbeat: (...args: any[]) => mockInitHeartbeat(...args),
  stopHeartbeat: () => mockStopHeartbeat(),
}));

// Mock channels.ts for reload
const mockInitActiveChannel = vi.fn().mockResolvedValue('telegram');
const mockStopActiveChannel = vi.fn().mockResolvedValue(undefined);
const mockStartActiveChannel = vi.fn().mockResolvedValue(undefined);
vi.mock('../channels.js', () => ({
  initActiveChannel: (...args: any[]) => mockInitActiveChannel(...args),
  stopActiveChannel: () => mockStopActiveChannel(),
  startActiveChannel: () => mockStartActiveChannel(),
  getActiveChannelId: () => 'telegram',
  sendActiveChannelProactiveMessage: vi.fn().mockResolvedValue(true),
}));

// Mock tools.ts for reload
const mockSetCodeAgentConfig = vi.fn();
vi.mock('../tools.js', () => ({
  setCodeAgentConfig: (...args: any[]) => mockSetCodeAgentConfig(...args),
  getAllCodeAgents: () => mockCodeAgents.list,
  getCodeAgent: (id: string) => mockCodeAgents.list.find((a: any) => a.id === id) || null,
  cancelCodeAgent: (id: string) => {
    const agent = mockCodeAgents.list.find((a: any) => a.id === id);
    if (!agent) return null;
    agent.status = 'cancelled';
    return agent;
  },
}));

vi.mock('../exec-approval.js', () => ({
  listApprovals: (opts?: { includeResolved?: boolean; limit?: number }) => {
    const all = mockApprovalsState.items;
    if (opts?.includeResolved) return all.slice(0, opts.limit || all.length);
    return all.filter((a: any) => a.status === 'pending');
  },
  getApproval: (id: string) => mockApprovalsState.items.find((a: any) => a.id === id) || null,
  approveRequest: (id: string) => {
    const item = mockApprovalsState.items.find((a: any) => a.id === id);
    if (!item || item.status !== 'pending') return false;
    item.status = 'approved';
    return true;
  },
  denyRequest: (id: string) => {
    const item = mockApprovalsState.items.find((a: any) => a.id === id);
    if (!item || item.status !== 'pending') return false;
    item.status = 'denied';
    return true;
  },
}));

vi.mock('../digests.js', () => ({
  getDigests: () =>
    mockDigestsState.items.map((d: any) => ({
      id: d.id,
      jobId: d.jobId,
      jobName: d.jobName,
      createdAt: d.createdAt,
      articleCount: d.articles.length,
      preview: d.articles.slice(0, 3).map((a: any) => a.title),
    })),
  getDigest: (id: string) => mockDigestsState.items.find((d: any) => d.id === id) || null,
  deleteDigest: (id: string) => {
    const idx = mockDigestsState.items.findIndex((d: any) => d.id === id);
    if (idx < 0) return false;
    mockDigestsState.items.splice(idx, 1);
    return true;
  },
  updateArticleReadStatus: (digestId: string, articleId: string, read: boolean) => {
    const digest = mockDigestsState.items.find((d: any) => d.id === digestId);
    if (!digest) return false;
    const article = digest.articles.find((a: any) => a.id === articleId);
    if (!article) return false;
    article.read = read;
    return true;
  },
}));

// Mock security.ts - only need redactSecrets
function redactSecretsImpl(obj: Record<string, any>): Record<string, any> {
  const SECRET_KEYS = ['apikey', 'token', 'password', 'secret', 'key'];
  const redacted: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_KEYS.some(s => key.toLowerCase().includes(s))) {
      redacted[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      redacted[key] = redactSecretsImpl(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

vi.mock('../security.js', () => ({
  redactSecrets: redactSecretsImpl,
}));

// Mock doctor/runner.ts for health endpoint
vi.mock('../doctor/runner.js', () => ({
  runDoctor: async () => ({
    report: {
      ok: true,
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      checks: [
        { name: 'node_version', category: 'environment', ok: true, detail: 'v20.11.0' },
        { name: 'config_json_valid', category: 'configuration', ok: true, detail: 'ok' },
      ],
    },
    exitCode: 0,
  }),
}));

// Mock usage.ts
vi.mock('../usage.js', () => ({
  getUsageSummary: () => ({
    today: { totalCost: 0.42, totalInputTokens: 10000, totalOutputTokens: 5000, totalCalls: 3, byModel: { 'claude-sonnet-4-5': { calls: 3, inputTokens: 10000, outputTokens: 5000, cost: 0.42 } } },
    week: { totalCost: 2.50, totalInputTokens: 50000, totalOutputTokens: 25000, totalCalls: 15, byModel: {} },
    month: { totalCost: 8.00, totalInputTokens: 200000, totalOutputTokens: 100000, totalCalls: 50, byModel: {} },
  }),
  readUsageRecords: (_opts: any) => ({
    records: [
      { id: 'test-1', timestamp: '2026-02-21T10:00:00Z', model: 'claude-sonnet-4-5', provider: 'anthropic', inputTokens: 1000, outputTokens: 500, totalTokens: 1500, inputCost: 0.003, outputCost: 0.0075, totalCost: 0.0105, trigger: 'telegram' },
    ],
    total: 1,
  }),
}));

import { registerDashboardAPI } from '../api.js';
import type { Config } from '../types.js';

let app: FastifyInstance;

/** Helper that injects with auth header by default */
function inject(opts: Record<string, any>) {
  opts.headers = { ...AUTH_HEADERS, ...(opts.headers || {}) };
  return app.inject(opts as any);
}

// --- Setup & Teardown ---

beforeAll(async () => {
  process.env.SKIMPYCLAW_TODO_PATH = TODO_PATH;

  // Create directory structure
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
  mkdirSync(AGENT_DIR, { recursive: true });
  mkdirSync(MEMORY_DIR, { recursive: true });

  // Seed session files
  writeFileSync(
    join(SESSIONS_DIR, 'session-1.json'),
    JSON.stringify({
      id: 'session-1',
      agentId: 'default',
      model: 'claude-sonnet-4-20250514',
      createdAt: '2026-02-01T10:00:00Z',
      updatedAt: '2026-02-01T11:00:00Z',
      turns: [
        { role: 'user', content: 'Hello', timestamp: '2026-02-01T10:00:00Z' },
        { role: 'assistant', content: 'Hi there', timestamp: '2026-02-01T10:01:00Z' },
      ],
    })
  );

  writeFileSync(
    join(SESSIONS_DIR, 'session-2.json'),
    JSON.stringify({
      id: 'session-2',
      agentId: 'default',
      model: 'claude-sonnet-4-20250514',
      createdAt: '2026-02-02T10:00:00Z',
      updatedAt: '2026-02-02T11:00:00Z',
      turns: [],
    })
  );

  // Seed memory files
  writeFileSync(join(MEMORY_DIR, '2026-02-01.md'), '# Memory for Feb 1\nSome notes.');
  writeFileSync(join(MEMORY_DIR, '2026-02-02.md'), '# Memory for Feb 2\nMore notes.');

  // Seed MEMORY.md (curated)
  writeFileSync(join(AGENT_DIR, 'MEMORY.md'), '# Curated Memory\nKey insights.');

  // Seed template files
  writeFileSync(join(AGENT_DIR, 'SOUL.md'), 'You are a helpful assistant.');
  writeFileSync(join(AGENT_DIR, 'IDENTITY.md'), 'Name: TestBot');

  // Seed skills
  mkdirSync(join(SKILLS_DIR, 'test-skill'), { recursive: true });
  writeFileSync(join(SKILLS_DIR, 'test-skill', 'SKILL.md'), [
    '---',
    'name: test-skill',
    'description: A test skill for API tests',
    'emoji: "🧪"',
    'tags: ["test"]',
    'priority: 10',
    '---',
    '',
    '# Test Skill',
    '',
    'This is a test skill body.',
  ].join('\n'));

  mkdirSync(join(SKILLS_DIR, 'disabled-skill'), { recursive: true });
  writeFileSync(join(SKILLS_DIR, 'disabled-skill', 'SKILL.md'), [
    '---',
    'name: disabled-skill',
    'description: A disabled test skill',
    'enabled: false',
    '---',
    '',
    'Disabled skill body.',
  ].join('\n'));

  // Seed log files
  writeFileSync(join(LOGS_DIR, 'app.log'), 'line1\nline2\nline3\nline4\nline5\n');
  writeFileSync(join(LOGS_DIR, 'error.log'), 'error1\nerror2\n');

  // Seed TODO file
  writeFileSync(TODO_PATH, [
    '# TODO',
    '',
    '- [ ] Ship dashboard todo tracking',
    '- [x] Existing done task',
    '- [ ] Add e2e tests',
    '',
  ].join('\n'));

  // Seed config file
  writeFileSync(CONFIG_PATH, JSON.stringify(TEST_CONFIG, null, 2));

  // Create Fastify app and register routes
  app = Fastify();
  registerDashboardAPI(app, TEST_CONFIG as unknown as Config);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  delete process.env.SKIMPYCLAW_TODO_PATH;
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset mutable state
  mockCurrentModel = 'claude-sonnet-4-20250514';
  mockLastMessage = undefined;
  mockCodeAgents.list = [
    {
      id: 'ca-1',
      agent: 'claude',
      status: 'running',
      task: 'test task',
      startedAt: '2026-02-21T10:00:00Z',
    },
  ];
  mockApprovalsState.items = [
    {
      id: 'ap-1',
      command: 'npm test',
      status: 'pending',
      tier: 1,
      createdAt: '2026-02-21T10:00:00Z',
      expiresAt: '2026-02-21T10:10:00Z',
    },
    {
      id: 'ap-2',
      command: 'rm -rf /tmp/x',
      status: 'denied',
      tier: 3,
      createdAt: '2026-02-21T10:00:00Z',
      expiresAt: '2026-02-21T10:10:00Z',
    },
  ];
  mockDigestsState.items = [
    {
      id: 'dg-1',
      jobId: 'daily-check',
      jobName: 'Daily Check',
      createdAt: '2026-02-21T10:00:00Z',
      summary: 'Digest summary',
      articles: [
        { id: 'a-1', title: 'Article 1', source: 'HN', url: 'https://example.com/1', read: false },
      ],
    },
  ];
  // Re-seed config in case a test modified it
  writeFileSync(CONFIG_PATH, JSON.stringify(TEST_CONFIG, null, 2));
  // Re-seed TODO file in case a test modified it
  writeFileSync(TODO_PATH, [
    '# TODO',
    '',
    '- [ ] Ship dashboard todo tracking',
    '- [x] Existing done task',
    '- [ ] Add e2e tests',
    '',
  ].join('\n'));
});

// ===== TESTS =====

describe('Status endpoint', () => {
  it('GET /api/dashboard/status returns correct shape', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('uptime');
    expect(body).toHaveProperty('model');
    expect(body).toHaveProperty('agent', 'default');
    expect(body).toHaveProperty('cronJobs');
    expect(Array.isArray(body.cronJobs)).toBe(true);
    expect(body.cronJobs[0]).toHaveProperty('id', 'daily-check');
  });
});

describe('Sessions endpoints', () => {
  it('GET /api/dashboard/sessions lists sessions', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/sessions' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessions).toHaveLength(2);
    // Should be sorted newest first
    expect(body.sessions[0].id).toBe('session-2');
    expect(body.sessions[1].id).toBe('session-1');
    expect(body.sessions[1]).toHaveProperty('turnCount', 2);
  });

  it('GET /api/dashboard/sessions/:id returns specific session', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/sessions/session-1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session.id).toBe('session-1');
    expect(body.session.turns).toHaveLength(2);
  });

  it('GET /api/dashboard/sessions/:id returns 404 for missing session', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/sessions/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty('error', 'Session not found');
  });

  it('GET /api/dashboard/sessions/:id returns 400 for path traversal', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/sessions/..%2F..%2Fetc%2Fpasswd' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error', 'Invalid session id');
  });
});

describe('Memory endpoints', () => {
  it('GET /api/dashboard/memory/:agentId lists memory files', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/memory/default' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.files).toHaveLength(2);
    expect(body.files[0]).toHaveProperty('name');
    expect(body.files[0]).toHaveProperty('size');
  });

  it('GET /api/dashboard/memory/:agentId/:filename returns file content', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/memory/default/2026-02-01.md' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toContain('Memory for Feb 1');
  });

  it('GET /api/dashboard/memory/:agentId/curated returns MEMORY.md', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/memory/default/curated' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toContain('Curated Memory');
  });

  it('GET /api/dashboard/memory/:agentId/:filename returns 400 for path traversal', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/memory/default/..%2F..%2Fetc%2Fpasswd' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error', 'Invalid filename');
  });

  it('GET /api/dashboard/memory/:agentId/:filename returns 404 for missing file', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/memory/default/nonexistent.md' });
    expect(res.statusCode).toBe(404);
  });

  it('returns empty list for agent with no memory', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/memory/nonexistent-agent' });
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toEqual([]);
  });
});

describe('Cron endpoints', () => {
  it('GET /api/dashboard/cron lists jobs', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/cron' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toHaveProperty('id', 'daily-check');
    expect(body.jobs[0]).toHaveProperty('name', 'Daily Check');
    expect(body.jobs[0]).toHaveProperty('schedule');
    expect(body.jobs[0]).toHaveProperty('payload');
  });

  it('POST /api/dashboard/cron/:id/run triggers job', async () => {
    const res = await inject({ method: 'POST', url: '/api/dashboard/cron/daily-check/run' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'triggered', id: 'daily-check' });
  });

  it('POST /api/dashboard/cron/:id/run returns 404 for missing job', async () => {
    const res = await inject({ method: 'POST', url: '/api/dashboard/cron/nonexistent/run' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty('error');
  });
});

describe('Model endpoints', () => {
  it('GET /api/dashboard/model returns current model and aliases', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/model' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('current', 'claude-sonnet-4-20250514');
    expect(body).toHaveProperty('aliases');
    expect(body.aliases).toHaveProperty('fast');
    expect(body.aliases).toHaveProperty('smart');
    expect(body).toHaveProperty('agents');
    expect(body.agents.default).toBe('claude-sonnet-4-20250514');
  });

  it('POST /api/dashboard/model switches model', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboard/model',
      payload: { model: 'claude-haiku-4-20250414' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ model: 'claude-haiku-4-20250414' });
    expect(mockCurrentModel).toBe('claude-haiku-4-20250414');
  });

  it('POST /api/dashboard/model resolves aliases before switching', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboard/model',
      payload: { model: 'fast' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ model: 'claude-haiku-4-20250414' });
    expect(mockCurrentModel).toBe('claude-haiku-4-20250414');
  });

  it('POST /api/dashboard/model rejects empty model', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboard/model',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error', 'model required');
  });

  it('POST /api/dashboard/model rejects unknown aliases', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboard/model',
      payload: { model: 'unknown_alias' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error', 'Unknown model alias: "unknown_alias"');
  });

  it('POST /api/dashboard/model rejects malformed provider/model selections', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboard/model',
      payload: { model: 'anthropic/' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error', 'Invalid model selection: "anthropic/". Use alias, provider/model, or model-id.');
  });
});

describe('Templates endpoints', () => {
  it('GET /api/dashboard/templates/:agentId lists templates', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/templates/default' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.templates).toHaveLength(7);
    const soul = body.templates.find((t: any) => t.name === 'SOUL.md');
    expect(soul).toBeDefined();
    expect(soul.exists).toBe(true);
    expect(soul.size).toBeGreaterThan(0);
    const tools = body.templates.find((t: any) => t.name === 'TOOLS.md');
    expect(tools.exists).toBe(false);
  });

  it('GET /api/dashboard/templates/:agentId/:name returns template content', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/templates/default/SOUL.md' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('SOUL.md');
    expect(body.content).toBe('You are a helpful assistant.');
  });

  it('GET /api/dashboard/templates/:agentId/:name returns 404 for missing template', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/templates/default/TOOLS.md' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/dashboard/templates/:agentId/:name returns 404 for invalid template name', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/templates/default/EVIL.md' });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /api/dashboard/templates/:agentId/:name saves template', async () => {
    const res = await inject({
      method: 'PUT',
      url: '/api/dashboard/templates/default/TOOLS.md',
      payload: { content: 'New tools content' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: true });
  });

  it('PUT /api/dashboard/templates/:agentId/:name rejects invalid template name', async () => {
    const res = await inject({
      method: 'PUT',
      url: '/api/dashboard/templates/default/EVIL.md',
      payload: { content: 'hack' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error');
  });

  it('PUT /api/dashboard/templates/:agentId/:name rejects missing content', async () => {
    const res = await inject({
      method: 'PUT',
      url: '/api/dashboard/templates/default/SOUL.md',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error', 'content required');
  });
});

describe('Logs endpoints', () => {
  it('GET /api/dashboard/logs lists log files', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/logs' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.files).toHaveLength(2);
    expect(body.files[0]).toHaveProperty('name');
    expect(body.files[0]).toHaveProperty('size');
    expect(body.files[0]).toHaveProperty('modified');
  });

  it('GET /api/dashboard/logs/:filename returns log content', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/logs/app.log' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toContain('line1');
    expect(body).toHaveProperty('lines');
  });

  it('GET /api/dashboard/logs/:filename?tail=2 returns last 2 lines', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/logs/app.log?tail=2' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // "line1\nline2\nline3\nline4\nline5\n" split by \n = ["line1","line2","line3","line4","line5",""]
    // tail 2 = ["line5", ""]
    const lines = body.content.split('\n');
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it('GET /api/dashboard/logs/:filename returns 400 for path traversal', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/logs/..%2F..%2Fetc%2Fpasswd' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error', 'Invalid filename');
  });

  it('GET /api/dashboard/logs/:filename returns 404 for missing file', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/logs/nonexistent.log' });
    expect(res.statusCode).toBe(404);
  });
});

describe('Config endpoints', () => {
  it('GET /api/dashboard/config returns redacted config', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('config');
    // Check that secrets are redacted
    const anthropicProvider = body.config.models?.providers?.anthropic;
    if (anthropicProvider) {
      expect(anthropicProvider.apiKey).toBe('[REDACTED]');
    }
    const telegram = body.config.channels?.telegram;
    if (telegram) {
      expect(telegram.token).toBe('[REDACTED]');
    }
    const discord = body.config.channels?.discord;
    if (discord) {
      expect(discord.token).toBe('[REDACTED]');
    }
  });

  it('PUT /api/dashboard/config saves valid config', async () => {
    const validConfig = { ...TEST_CONFIG };
    const res = await inject({
      method: 'PUT',
      url: '/api/dashboard/config',
      payload: { config: validConfig },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: true, restartRequired: true });
  });

  it('PUT /api/dashboard/config rejects missing config', async () => {
    const res = await inject({
      method: 'PUT',
      url: '/api/dashboard/config',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error', 'config object required');
  });

  it('PUT /api/dashboard/config rejects config missing required sections', async () => {
    const res = await inject({
      method: 'PUT',
      url: '/api/dashboard/config',
      payload: { config: { gateway: { port: 1 } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Missing required config sections');
  });

  it('PUT /api/dashboard/config preserves real secrets when [REDACTED] values are sent', async () => {
    // Send config with redacted secrets
    const configWithRedacted = JSON.parse(JSON.stringify(TEST_CONFIG));
    configWithRedacted.models.providers.anthropic.apiKey = '[REDACTED]';
    configWithRedacted.channels.telegram.token = '[REDACTED]';
    configWithRedacted.channels.discord.token = '[REDACTED]';

    const res = await inject({
      method: 'PUT',
      url: '/api/dashboard/config',
      payload: { config: configWithRedacted },
    });
    expect(res.statusCode).toBe(200);

    // Read saved config and verify secrets were preserved
    const { readFileSync } = require('fs');
    const saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    expect(saved.models.providers.anthropic.apiKey).toBe('sk-ant-test-secret-key');
    expect(saved.channels.telegram.token).toBe('tg-secret-token');
    expect(saved.channels.discord.token).toBe('discord-secret-token');
  });
});

describe('TODO endpoints', () => {
  it('GET /api/dashboard/todos returns checklist items and summary', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/todos' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.completed).toBe(1);
    expect(body.remaining).toBe(2);
    expect(body.items).toHaveLength(3);
    expect(body.items[0]).toMatchObject({
      id: 0,
      text: 'Ship dashboard todo tracking',
      completed: false,
    });
  });

  it('PUT /api/dashboard/todos/:id toggles completion state', async () => {
    const res = await inject({
      method: 'PUT',
      url: '/api/dashboard/todos/0',
      payload: { completed: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.updated).toBe(true);
    expect(body.item).toMatchObject({ id: 0, completed: true });
    expect(body.completed).toBe(2);

    const verify = await inject({ method: 'GET', url: '/api/dashboard/todos' });
    const verifyBody = verify.json();
    expect(verifyBody.items.find((i: any) => i.id === 0).completed).toBe(true);
  });

  it('PUT /api/dashboard/todos/:id returns 404 for missing item', async () => {
    const res = await inject({
      method: 'PUT',
      url: '/api/dashboard/todos/999',
      payload: { completed: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty('error', 'TODO item not found');
  });
});

describe('Authentication', () => {
  it('returns 401 when no auth header is provided', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/status' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty('error');
  });

  it('returns 401 when wrong token is provided', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/dashboard/status',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty('error');
  });

  it('returns 401 when auth header format is wrong', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/dashboard/status',
      headers: { authorization: 'Basic dGVzdDp0ZXN0' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty('error');
  });

  it('returns 200 with correct token', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/status' });
    expect(res.statusCode).toBe(200);
  });
});

describe('Health endpoint', () => {
  it('GET /api/dashboard/health returns doctor check results', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('ok', true);
    expect(body).toHaveProperty('checks');
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks.length).toBeGreaterThan(0);
    expect(body.checks[0]).toHaveProperty('name');
    expect(body.checks[0]).toHaveProperty('ok');
    expect(body.checks[0]).toHaveProperty('detail');
  });

  it('GET /api/dashboard/health returns features summary', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('features');
    expect(body.features).toHaveProperty('telegram');
    expect(body.features).toHaveProperty('discord');
    expect(body.features).toHaveProperty('voice');
  });

  it('GET /api/dashboard/health returns env var status', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('envVars');
    expect(Array.isArray(body.envVars)).toBe(true);
  });
});

describe('Doctor endpoint', () => {
  it('GET /api/dashboard/doctor returns full report', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/doctor' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('report');
    expect(body.report).toHaveProperty('ok', true);
    expect(body.report).toHaveProperty('exitCode', 0);
    expect(body.report).toHaveProperty('startedAt');
    expect(body.report).toHaveProperty('finishedAt');
    expect(body.report).toHaveProperty('checks');
    expect(Array.isArray(body.report.checks)).toBe(true);
    expect(body.report.checks.length).toBeGreaterThan(0);
  });

  it('GET /api/dashboard/doctor checks include category', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/doctor' });
    const body = res.json();
    for (const check of body.report.checks) {
      expect(check).toHaveProperty('name');
      expect(check).toHaveProperty('category');
      expect(check).toHaveProperty('ok');
      expect(check).toHaveProperty('detail');
    }
  });

  it('GET /api/dashboard/doctor requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/doctor' });
    expect(res.statusCode).toBe(401);
  });
});

describe('Reload endpoint', () => {
  beforeEach(() => {
    mockInitProviders.mockClear();
    mockInitCron.mockClear();
    mockInitHeartbeat.mockClear();
    mockStopHeartbeat.mockClear();
    mockInitActiveChannel.mockClear();
    mockStopActiveChannel.mockClear();
    mockStartActiveChannel.mockClear();
    mockSetCodeAgentConfig.mockClear();
    mockSetGatewayConfig.mockClear();
  });

  it('POST /api/dashboard/reload reloads config and returns reloaded:true', async () => {
    const res = await inject({ method: 'POST', url: '/api/dashboard/reload' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reloaded).toBe(true);
    expect(body).toHaveProperty('timestamp');
    expect(mockSetGatewayConfig).toHaveBeenCalledOnce();
    expect(mockInitProviders).toHaveBeenCalledOnce();
    expect(mockSetCodeAgentConfig).toHaveBeenCalledOnce();
    expect(mockInitCron).toHaveBeenCalledOnce();
    expect(mockStopHeartbeat).toHaveBeenCalledOnce();
    expect(mockInitHeartbeat).toHaveBeenCalledOnce();
    expect(mockStopActiveChannel).toHaveBeenCalledOnce();
    expect(mockInitActiveChannel).toHaveBeenCalledOnce();
    expect(mockStartActiveChannel).toHaveBeenCalledOnce();
  });

  it('POST /api/dashboard/reload requires auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/dashboard/reload' });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/dashboard/reload returns 500 when initProviders throws', async () => {
    mockInitProviders.mockImplementationOnce(() => {
      throw new Error('provider init failed');
    });
    const res = await inject({ method: 'POST', url: '/api/dashboard/reload' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toContain('provider init failed');
  });

  it('POST /api/dashboard/reload updates runtime config for auth checks', async () => {
    // Update config file with new token
    const newConfig = structuredClone(TEST_CONFIG);
    newConfig.dashboard.token = 'new-secret-token';
    const { writeFileSync } = require('fs');
    writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));

    // Reload config
    const reloadRes = await inject({ method: 'POST', url: '/api/dashboard/reload' });
    expect(reloadRes.statusCode).toBe(200);

    // Old token should now fail
    const oldTokenRes = await app.inject({
      method: 'GET',
      url: '/api/dashboard/status',
      headers: { authorization: 'Bearer test-dashboard-token-123' },
    });
    expect(oldTokenRes.statusCode).toBe(401);

    // New token should work
    const newTokenRes = await app.inject({
      method: 'GET',
      url: '/api/dashboard/status',
      headers: { authorization: 'Bearer new-secret-token' },
    });
    expect(newTokenRes.statusCode).toBe(200);

    // Restore config for other tests
    writeFileSync(CONFIG_PATH, JSON.stringify(TEST_CONFIG, null, 2));
    const resetRes = await app.inject({
      method: 'POST',
      url: '/api/dashboard/reload',
      headers: { authorization: 'Bearer new-secret-token' },
    });
    expect(resetRes.statusCode).toBe(200);
  });

  it('POST /api/dashboard/reload updates runtime config for status endpoint', async () => {
    // Update config with new agent name
    const newConfig = structuredClone(TEST_CONFIG);
    newConfig.agents.default = 'updated-agent';
    const { writeFileSync } = require('fs');
    writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));

    // Reload config
    const reloadRes = await inject({ method: 'POST', url: '/api/dashboard/reload' });
    expect(reloadRes.statusCode).toBe(200);

    // Status should reflect new agent name
    const statusRes = await inject({ method: 'GET', url: '/api/dashboard/status' });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().agent).toBe('updated-agent');

    // Restore config for other tests
    writeFileSync(CONFIG_PATH, JSON.stringify(TEST_CONFIG, null, 2));
  });
});

describe('Usage endpoints', () => {
  it('GET /api/dashboard/usage returns summary with three periods', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/usage' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('today');
    expect(body).toHaveProperty('week');
    expect(body).toHaveProperty('month');
    expect(body.today.totalCost).toBe(0.42);
    expect(body.today.totalCalls).toBe(3);
  });

  it('GET /api/dashboard/usage requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/usage' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/dashboard/usage/records returns paginated records', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/usage/records?limit=10' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('records');
    expect(body).toHaveProperty('total');
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records[0]).toHaveProperty('model');
    expect(body.records[0]).toHaveProperty('totalCost');
  });
});

describe('Conversations endpoints', () => {
  it('GET /api/dashboard/conversations lists jsonl conversations', async () => {
    writeFileSync(
      join(SESSIONS_DIR, 'telegram-12345.jsonl'),
      [
        JSON.stringify({ ts: '2026-02-01T10:00:00Z', user: 'hello' }),
        JSON.stringify({ ts: '2026-02-01T10:01:00Z', assistant: 'hi' }),
      ].join('\n'),
      'utf-8'
    );

    const res = await inject({ method: 'GET', url: '/api/dashboard/conversations' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.conversations)).toBe(true);
    expect(body.conversations[0]).toHaveProperty('id', 'telegram-12345');
  });

  it('GET /api/dashboard/conversations/:id returns messages', async () => {
    writeFileSync(
      join(SESSIONS_DIR, 'discord-abc.jsonl'),
      [
        JSON.stringify({ ts: '2026-02-01T10:00:00Z', user: 'u1', assistant: 'a1' }),
        JSON.stringify({ ts: '2026-02-01T10:02:00Z', user: 'u2' }),
      ].join('\n'),
      'utf-8'
    );

    const res = await inject({ method: 'GET', url: '/api/dashboard/conversations/discord-abc?limit=10&offset=0' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('id', 'discord-abc');
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.total).toBeGreaterThan(0);
  });

  it('GET /api/dashboard/conversations/:id rejects invalid ids', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/conversations/..%2Fbad' });
    expect(res.statusCode).toBe(400);
  });
});

describe('Messages endpoints', () => {
  it('POST /api/dashboard/messages/send sends proactive message', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboard/messages/send',
      payload: { message: 'Hello channel' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('sent', true);
  });

  it('POST /api/dashboard/messages/send rejects empty message', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboard/messages/send',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error', 'message required');
  });

  it('POST /api/dashboard/messages/agent runs agent turn', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboard/messages/agent',
      payload: { message: 'ping' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('ok', true);
    expect(res.json()).toHaveProperty('response', 'ok');
  });
});

describe('Cron prompt-file endpoint', () => {
  it('GET /api/dashboard/cron/prompt-file rejects missing path', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/cron/prompt-file' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error', 'path required');
  });

  it('GET /api/dashboard/cron/prompt-file rejects invalid path traversal', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/cron/prompt-file?path=../../etc/passwd' });
    expect(res.statusCode).toBe(400);
  });
});

describe('Restart endpoint', () => {
  it('POST /api/dashboard/restart returns restarting true', async () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

    const res = await inject({ method: 'POST', url: '/api/dashboard/restart' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ restarting: true });

    vi.runOnlyPendingTimers();
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe('Code Agents endpoints', () => {
  it('GET /api/dashboard/code-agents returns agents', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/code-agents' });
    expect(res.statusCode).toBe(200);
    expect(res.json().agents).toHaveLength(1);
  });

  it('GET /api/dashboard/code-agents/:id returns one agent', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/code-agents/ca-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('id', 'ca-1');
  });

  it('POST /api/dashboard/code-agents/:id/cancel cancels agent', async () => {
    const res = await inject({ method: 'POST', url: '/api/dashboard/code-agents/ca-1/cancel' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('cancelled', true);
  });
});

describe('Approvals endpoints', () => {
  it('GET /api/dashboard/approvals returns pending and recent', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/approvals' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('pending');
    expect(res.json()).toHaveProperty('recent');
  });

  it('POST /api/dashboard/approvals/:id/approve approves pending request', async () => {
    const res = await inject({ method: 'POST', url: '/api/dashboard/approvals/ap-1/approve' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('approved', true);
  });

  it('POST /api/dashboard/approvals/:id/deny returns 400 when already resolved', async () => {
    const res = await inject({ method: 'POST', url: '/api/dashboard/approvals/ap-2/deny' });
    expect(res.statusCode).toBe(400);
  });
});

describe('Digests endpoints', () => {
  it('GET /api/dashboard/digests returns digest list', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/digests' });
    expect(res.statusCode).toBe(200);
    expect(res.json().digests).toHaveLength(1);
  });

  it('GET /api/dashboard/digests/:id returns one digest', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/digests/dg-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('id', 'dg-1');
  });

  it('POST /api/dashboard/digests/:digestId/articles/:articleId/read updates read flag', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboard/digests/dg-1/articles/a-1/read',
      payload: { read: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: true, read: true });
  });

  it('DELETE /api/dashboard/digests/:id deletes digest', async () => {
    const res = await inject({ method: 'DELETE', url: '/api/dashboard/digests/dg-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
  });
});

describe('Skills endpoints', () => {
  it('GET /api/dashboard/skills returns skill list', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/skills' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().skills)).toBe(true);
    expect(res.json().skills.some((s: any) => s.name === 'test-skill')).toBe(true);
  });

  it('GET /api/dashboard/skills/:name returns skill details', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboard/skills/test-skill' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('name', 'test-skill');
    expect(res.json()).toHaveProperty('rawContent');
  });

  it('PUT /api/dashboard/skills/:name updates enabled state', async () => {
    const res = await inject({
      method: 'PUT',
      url: '/api/dashboard/skills/test-skill',
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('updated', true);
  });

  it('POST /api/dashboard/skills creates skill', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboard/skills',
      payload: { name: 'new-skill', content: '---\nname: new-skill\ndescription: New\n---\n\nBody' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('created', true);
  });

  it('DELETE /api/dashboard/skills/:name deletes skill', async () => {
    const res = await inject({ method: 'DELETE', url: '/api/dashboard/skills/disabled-skill' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('deleted', true);
  });
});
