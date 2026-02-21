import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { registerDashboard } from '../dashboard.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  registerDashboard(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('Dashboard HTML', () => {
  let html: string;

  beforeAll(async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    html = res.body;
  });

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

  it('has a single page-health element', () => {
    const panels = html.match(/id="page-health"/g);
    expect(panels).toHaveLength(1);
  });

  it('unified health panel contains doctor diagnostics elements', () => {
    // Doctor summary and categories are inside page-health
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
    // Old doctor re-run button should not exist
    expect(html).not.toContain('id="doctorRerunBtn"');
  });

  it('loadHealth function fetches both doctor and health APIs', () => {
    // The unified loadHealth calls both endpoints in parallel
    expect(html).toContain("api('doctor')");
    expect(html).toContain("api('health')");
  });

  it('onTabActivated does not reference doctor tab', () => {
    expect(html).not.toContain("=== 'doctor'");
    expect(html).not.toContain('loadDoctor()');
  });
});
