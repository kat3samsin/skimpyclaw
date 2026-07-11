import { describe, it, expect } from 'vitest';
import { ToolCallGuard } from '../providers/tool-guard.js';

describe('ToolCallGuard', () => {
  describe('spin detection', () => {
    it('allows first few identical calls', () => {
      const guard = new ToolCallGuard();
      const r1 = guard.recordCall('read_file', { path: '/foo' });
      const r2 = guard.recordCall('read_file', { path: '/foo' });
      expect(r1.blocked).toBe(false);
      expect(r1.warning).toBeUndefined();
      expect(r2.blocked).toBe(false);
      expect(r2.warning).toBeUndefined();
    });

    it('warns at 3 identical calls', () => {
      const guard = new ToolCallGuard();
      guard.recordCall('read_file', { path: '/foo' });
      guard.recordCall('read_file', { path: '/foo' });
      const r3 = guard.recordCall('read_file', { path: '/foo' });
      expect(r3.blocked).toBe(false);
      expect(r3.warning).toBeDefined();
    });

    it('blocks at 5 identical calls', () => {
      const guard = new ToolCallGuard();
      for (let i = 0; i < 4; i++) {
        guard.recordCall('read_file', { path: '/foo' });
      }
      const r5 = guard.recordCall('read_file', { path: '/foo' });
      expect(r5.blocked).toBe(true);
      expect(r5.warning).toContain('Blocked');
    });

    it('resets consecutive count on different call', () => {
      const guard = new ToolCallGuard();
      guard.recordCall('read_file', { path: '/foo' });
      guard.recordCall('read_file', { path: '/foo' });
      guard.recordCall('write_file', { path: '/bar', content: 'x' }); // different
      const r = guard.recordCall('read_file', { path: '/foo' });
      expect(r.blocked).toBe(false);
      expect(r.warning).toBeUndefined();
    });
  });

  describe('no-progress detection', () => {
    it('nudges after 5 identical results', () => {
      const guard = new ToolCallGuard();
      for (let i = 0; i < 4; i++) {
        const r = guard.recordResult('same result');
        expect(r.nudge).toBeUndefined();
      }
      const r5 = guard.recordResult('same result');
      expect(r5.nudge).toBeDefined();
      expect(r5.nudge).toContain('No progress');
    });

    it('does not nudge with varying results', () => {
      const guard = new ToolCallGuard();
      for (let i = 0; i < 10; i++) {
        const r = guard.recordResult(`result ${i}`);
        expect(r.nudge).toBeUndefined();
      }
    });
  });

  describe('token tracking', () => {
    it('warns at 80 percent and stops at the configured limit', () => {
      const guard = new ToolCallGuard(100);
      const warning = guard.recordTokens(40, 40);
      const exceeded = guard.recordTokens(10, 10);

      expect(warning.exceeded).toBe(false);
      expect(warning.warning).toContain('80/100');
      expect(exceeded.exceeded).toBe(true);
      expect(exceeded.warning).toContain('limit: 100');
      const stats = guard.getStats();
      expect(stats.totalTokens).toBe(100);
    });

    it('uses the documented 200000-token default', () => {
      const guard = new ToolCallGuard();
      expect(guard.recordTokens(199_999, 0).exceeded).toBe(false);
      expect(guard.recordTokens(1, 0).exceeded).toBe(true);
    });

    it('fails closed when usage is unavailable', () => {
      const guard = new ToolCallGuard(100);
      const result = guard.recordTokens(undefined, undefined);
      expect(result.exceeded).toBe(true);
      expect(result.usageUnavailable).toBe(true);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      const guard = new ToolCallGuard();
      guard.recordCall('read_file', { path: '/foo' });
      guard.recordResult('result');
      guard.recordTokens(1000, 500);
      guard.reset();
      const stats = guard.getStats();
      expect(stats.callCount).toBe(0);
      expect(stats.totalTokens).toBe(0);
    });
  });

  describe('getStats', () => {
    it('tracks call count and tokens', () => {
      const guard = new ToolCallGuard();
      guard.recordCall('read_file', { path: '/foo' });
      guard.recordCall('write_file', { path: '/bar', content: 'x' });
      guard.recordTokens(1000, 500);
      guard.recordTokens(2000, 1000);
      const stats = guard.getStats();
      expect(stats.callCount).toBe(2);
      expect(stats.totalTokens).toBe(4500);
    });
  });
});
