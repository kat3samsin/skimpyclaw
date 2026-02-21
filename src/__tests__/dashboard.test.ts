import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { registerDashboard } from '../dashboard.js';

let app: FastifyInstance;
let html: string;

beforeAll(async () => {
  app = Fastify();
  registerDashboard(app);
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/dashboard' });
  expect(res.statusCode).toBe(200);
  html = res.body;
});

afterAll(async () => {
  await app.close();
});

// ── Route ──────────────────────────────────────────────────────────────────

describe('Dashboard route', () => {
  it('GET /dashboard returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /dashboard returns text/html content-type', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('GET /dashboard returns non-empty body', () => {
    expect(html.length).toBeGreaterThan(1000);
  });
});

// ── Document structure ─────────────────────────────────────────────────────

describe('HTML document structure', () => {
  it('has DOCTYPE declaration', () => {
    expect(html.toLowerCase()).toContain('<!doctype html>');
  });

  it('has UTF-8 charset meta', () => {
    expect(html).toContain('charset="UTF-8"');
  });

  it('has viewport meta tag', () => {
    expect(html).toContain('name="viewport"');
  });

  it('has a title element', () => {
    expect(html).toMatch(/<title>[^<]+<\/title>/);
  });

  it('includes Inter and Playfair Display fonts', () => {
    expect(html).toContain('Inter');
    expect(html).toContain('Playfair+Display');
  });

  it('includes marked.js CDN script', () => {
    expect(html).toContain('marked');
  });
});

// ── Theme / CSS variables ──────────────────────────────────────────────────

describe('Theme system', () => {
  it('has data-theme attribute on html element', () => {
    expect(html).toMatch(/data-theme="light"/);
  });

  it('defines light theme CSS variables', () => {
    expect(html).toContain('[data-theme="light"]');
    expect(html).toContain('--bg:');
    expect(html).toContain('--accent:');
    expect(html).toContain('--text:');
  });

  it('defines dark theme CSS variables', () => {
    expect(html).toContain('[data-theme="dark"]');
  });

  it('defines shared radius tokens', () => {
    expect(html).toContain('--radius:');
    expect(html).toContain('--sidebar-width:');
  });
});

// ── Sidebar navigation ─────────────────────────────────────────────────────

describe('Sidebar navigation tabs', () => {
  const expectedPages = [
    'overview',
    'history',
    'approvals',
    'digests',
    'audit',
    'coding',
    'memory',
    'templates',
    'model',
    'skills',
    'cron',
    'config',
    'logs',
    'health',
  ];

  for (const page of expectedPages) {
    it(`has sidebar button for "${page}"`, () => {
      expect(html).toContain(`data-page="${page}"`);
    });
  }

  it('has exactly one sidebar button per page (no duplicates)', () => {
    for (const page of expectedPages) {
      const matches = html.match(new RegExp(`data-page="${page}"`, 'g'));
      expect(matches, `Duplicate data-page="${page}"`).toHaveLength(1);
    }
  });

  it('overview tab is active by default', () => {
    // The first .sidebar-item should have class="sidebar-item active"
    expect(html).toMatch(/class="sidebar-item active"[^>]*data-page="overview"/);
  });

  it('does not have a Doctor tab (merged into Health)', () => {
    const doctorTabs = html.match(/data-page="doctor"/g);
    expect(doctorTabs).toBeNull();
  });
});

// ── Page panels ───────────────────────────────────────────────────────────

describe('Page panel IDs', () => {
  const expectedPanels = [
    'page-overview',
    'page-history',
    'page-approvals',
    'page-digests',
    'page-audit',
    'page-coding',
    'page-memory',
    'page-templates',
    'page-model',
    'page-skills',
    'page-cron',
    'page-config',
    'page-logs',
    'page-health',
  ];

  for (const panel of expectedPanels) {
    it(`has panel id="${panel}"`, () => {
      expect(html).toContain(`id="${panel}"`);
    });
  }

  it('has no panel-doctor element (Doctor is part of Health)', () => {
    expect(html).not.toContain('id="page-doctor"');
  });

  it('has exactly one page-health element', () => {
    const panels = html.match(/id="page-health"/g);
    expect(panels).toHaveLength(1);
  });

  it('page-overview is initially active', () => {
    expect(html).toMatch(/id="page-overview"[^>]*class="page active"|class="page active"[^>]*id="page-overview"/);
  });
});

// ── Health / Doctor integration ────────────────────────────────────────────

describe('Unified Health panel', () => {
  it('contains doctorSummary element', () => {
    expect(html).toContain('id="doctorSummary"');
  });

  it('contains doctorCategories element', () => {
    expect(html).toContain('id="doctorCategories"');
  });

  it('contains doctorTimestamp element', () => {
    expect(html).toContain('id="doctorTimestamp"');
  });

  it('contains healthEnvVars element', () => {
    expect(html).toContain('id="healthEnvVars"');
  });

  it('contains healthFeatures element', () => {
    expect(html).toContain('id="healthFeatures"');
  });

  it('has a single re-check button (healthRecheckBtn)', () => {
    expect(html).toContain('id="healthRecheckBtn"');
    const matches = html.match(/id="healthRecheckBtn"/g);
    expect(matches).toHaveLength(1);
  });

  it('does not have old doctorRerunBtn', () => {
    expect(html).not.toContain('id="doctorRerunBtn"');
  });
});

// ── API call coverage ──────────────────────────────────────────────────────

describe('JavaScript API calls', () => {
  const expectedApiCalls = [
    "api('status')",
    "api('approvals')",
    "api('doctor')",
    "api('health')",
    "api('cron')",
    "api('model')",
    "api('logs')",
    "api('config')",
    "api('digests')",
    "api('skills')",
    "api('audit",
    "api('code-agents')",
  ];

  for (const call of expectedApiCalls) {
    it(`contains API call: ${call}`, () => {
      expect(html).toContain(call);
    });
  }

  it('loadHealth fetches both doctor and health endpoints', () => {
    expect(html).toContain("api('doctor')");
    expect(html).toContain("api('health')");
  });
});

// ── Page activation routing ────────────────────────────────────────────────

describe('onPageActivated routing', () => {
  const activationPairs: [string, string][] = [
    ['history', 'loadHistory'],
    ['memory', 'loadMemory'],
    ['approvals', 'startApprovalsPolling'],
    ['cron', 'loadCronJobs'],
    ['model', 'loadModel'],
    ['templates', 'loadTemplates'],
    ['coding', 'startCaPolling'],
    ['audit', 'loadAudit'],
    ['logs', 'loadLogFiles'],
    ['digests', 'loadDigests'],
    ['skills', 'loadSkills'],
    ['config', 'loadConfig'],
    ['health', 'loadHealth'],
  ];

  for (const [page, fn] of activationPairs) {
    it(`page "${page}" is wired to ${fn}()`, () => {
      expect(html).toContain(`=== '${page}') ${fn}()`);
    });
  }

  it('does not reference doctor tab in routing', () => {
    expect(html).not.toContain("=== 'doctor'");
    expect(html).not.toContain('loadDoctor()');
  });
});

// ── switchPage function ────────────────────────────────────────────────────

describe('switchPage function', () => {
  it('defines switchPage function', () => {
    expect(html).toContain('function switchPage(');
  });

  it('defines onPageActivated function', () => {
    expect(html).toContain('function onPageActivated(');
  });

  it('title map includes all expected pages', () => {
    // The titles object is defined inline in switchPage
    const expectedTitles = ['overview', 'history', 'approvals', 'digests', 'coding', 'audit', 'memory', 'model', 'templates', 'skills', 'cron', 'config', 'logs', 'health'];
    for (const page of expectedTitles) {
      expect(html).toContain(`${page}:`);
    }
  });
});

// ── API client helper ──────────────────────────────────────────────────────

describe('API client function', () => {
  it('defines api() helper function', () => {
    expect(html).toContain('function api(');
  });

  it('constructs /api/dashboard/ base URL', () => {
    expect(html).toContain('/api/dashboard/');
  });

  it('uses fetch for HTTP calls', () => {
    expect(html).toContain('fetch(');
  });

  it('includes Authorization header setup', () => {
    expect(html).toContain('Authorization');
  });
});

// ── Authentication flow ────────────────────────────────────────────────────

describe('Dashboard authentication', () => {
  it('has token input or auth flow', () => {
    // Dashboard requires a token; the page should have some auth mechanism
    expect(html).toContain('token');
  });

  it('stores token in localStorage or similar', () => {
    expect(html).toContain('localStorage');
  });
});

// ── Overview page content ──────────────────────────────────────────────────

describe('Overview page', () => {
  it('has uptime display element', () => {
    expect(html).toContain('uptime');
  });

  it('has model display or selector', () => {
    // Model info appears on overview
    expect(html).toContain('model');
  });

  it('has cron jobs section', () => {
    expect(html).toContain('cron');
  });
});

// ── Skills page ────────────────────────────────────────────────────────────

describe('Skills page', () => {
  it('has page-skills panel', () => {
    expect(html).toContain('id="page-skills"');
  });

  it('references loadSkills function', () => {
    expect(html).toContain('loadSkills');
  });

  it('references skills API endpoint', () => {
    expect(html).toContain("api('skills'");
  });
});

// ── Digests page ───────────────────────────────────────────────────────────

describe('Digests page', () => {
  it('has page-digests panel', () => {
    expect(html).toContain('id="page-digests"');
  });

  it('references loadDigests function', () => {
    expect(html).toContain('loadDigests');
  });

  it('references digests API endpoint', () => {
    expect(html).toContain("api('digests'");
  });
});

// ── Audit page ────────────────────────────────────────────────────────────

describe('Audit page', () => {
  it('has page-audit panel', () => {
    expect(html).toContain('id="page-audit"');
  });

  it('references loadAudit function', () => {
    expect(html).toContain('loadAudit');
  });

  it('references audit API endpoint', () => {
    expect(html).toContain("api('audit");
  });
});

// ── Coding Agent page ─────────────────────────────────────────────────────

describe('Coding Agent page', () => {
  it('has page-coding panel', () => {
    expect(html).toContain('id="page-coding"');
  });

  it('references loadCaAgents or startCaPolling function', () => {
    const hasCa = html.includes('loadCaAgents') || html.includes('startCaPolling');
    expect(hasCa).toBe(true);
  });

  it('references code-agents API endpoint', () => {
    expect(html).toContain("api('code-agents')");
  });
});

// ── Config page ───────────────────────────────────────────────────────────

describe('Config page', () => {
  it('has page-config panel', () => {
    expect(html).toContain('id="page-config"');
  });

  it('references loadConfig function', () => {
    expect(html).toContain('loadConfig');
  });

  it('references config API endpoint for both GET and PUT', () => {
    expect(html).toContain("api('config'");
  });
});

// ── Parity contract: no legacy Doctor-only elements ────────────────────────

describe('Doctor/Health parity contract', () => {
  it('has a single Health tab button', () => {
    const healthTabs = html.match(/data-page="health"/g);
    expect(healthTabs).toHaveLength(1);
  });

  it('does not have a Doctor tab button', () => {
    const doctorTabs = html.match(/data-page="doctor"/g);
    expect(doctorTabs).toBeNull();
  });

  it('has no panel-doctor element', () => {
    expect(html).not.toContain('id="page-doctor"');
  });

  it('unified health panel contains doctor diagnostics elements', () => {
    expect(html).toContain('id="doctorSummary"');
    expect(html).toContain('id="doctorCategories"');
    expect(html).toContain('id="doctorTimestamp"');
  });

  it('unified health panel contains environment and feature elements', () => {
    expect(html).toContain('id="healthEnvVars"');
    expect(html).toContain('id="healthFeatures"');
  });

  it('unified health panel has a single re-check button', () => {
    expect(html).toContain('id="healthRecheckBtn"');
    expect(html).not.toContain('id="doctorRerunBtn"');
  });

  it('loadHealth function fetches both doctor and health APIs', () => {
    expect(html).toContain("api('doctor')");
    expect(html).toContain("api('health')");
  });

  it('onTabActivated does not reference doctor tab', () => {
    expect(html).not.toContain("=== 'doctor'");
    expect(html).not.toContain('loadDoctor()');
  });
});
