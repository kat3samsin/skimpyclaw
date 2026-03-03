import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    realpathSync: vi.fn(),
  };
});

import { existsSync, realpathSync } from 'fs';
import { isBlockedPath, validateMountPaths, translatePath } from '../sandbox/mount-security.js';

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockRealpathSync = realpathSync as unknown as ReturnType<typeof vi.fn>;

describe('sandbox/mount-security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isBlockedPath', () => {
    it('blocks .ssh', () => {
      expect(isBlockedPath('/home/user/.ssh')).toBe(true);
      expect(isBlockedPath('/home/user/.ssh/id_rsa')).toBe(true);
    });

    it('blocks .gnupg', () => {
      expect(isBlockedPath('/home/user/.gnupg')).toBe(true);
    });

    it('blocks .aws', () => {
      expect(isBlockedPath('/home/user/.aws')).toBe(true);
    });

    it('blocks credentials', () => {
      expect(isBlockedPath('/some/path/credentials')).toBe(true);
    });

    it('blocks .env', () => {
      expect(isBlockedPath('/project/.env')).toBe(true);
    });

    it('blocks .kube', () => {
      expect(isBlockedPath('/home/user/.kube/config')).toBe(true);
    });

    it('blocks .docker/config.json compound pattern', () => {
      expect(isBlockedPath('/home/user/.docker/config.json')).toBe(true);
    });

    it('allows normal paths', () => {
      expect(isBlockedPath('/home/user/project')).toBe(false);
      expect(isBlockedPath('/workspace/src/index.ts')).toBe(false);
      expect(isBlockedPath('/tmp/test')).toBe(false);
    });
  });

  describe('validateMountPaths', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockRealpathSync.mockImplementation((p: string) => p);
    });

    it('maps to /workspace/<basename>', () => {
      const mounts = validateMountPaths(['/home/user/myproject']);
      const projectMount = mounts.find((m) => m.host === '/home/user/myproject');
      expect(projectMount).toBeDefined();
      expect(projectMount!.container).toBe('/workspace/myproject');
      expect(projectMount!.readOnly).toBe(false);
    });

    it('deduplicates basenames with suffix', () => {
      const mounts = validateMountPaths(['/a/project', '/b/project']);
      const containers = mounts.filter((m) => m.host.endsWith('/project')).map((m) => m.container);
      expect(containers).toContain('/workspace/project');
      expect(containers).toContain('/workspace/project_1');
    });

    it('adds ~/.skimpyclaw at /workspace/config', () => {
      const mounts = validateMountPaths(['/home/user/project']);
      const configMount = mounts.find((m) => m.container === '/workspace/config');
      expect(configMount).toBeDefined();
    });

    it('throws on blocked paths', () => {
      expect(() => validateMountPaths(['/home/user/.ssh'])).toThrow('Blocked path');
    });

    it('skips missing paths', () => {
      mockExistsSync.mockImplementation((p: string) => {
        // Only ~/.skimpyclaw exists for the auto-add
        return typeof p === 'string' && p.includes('.skimpyclaw');
      });
      const mounts = validateMountPaths(['/nonexistent/path']);
      // Should only have the auto-added config mount
      const nonConfig = mounts.filter((m) => m.container !== '/workspace/config');
      expect(nonConfig).toHaveLength(0);
    });

    it('does not duplicate ~/.skimpyclaw if already in list', () => {
      // Simulate ~/.skimpyclaw being passed explicitly
      const home = process.env.HOME || '/Users/katre';
      const skDir = `${home}/.skimpyclaw`;
      mockRealpathSync.mockImplementation((p: string) => p);
      // .skimpyclaw is NOT blocked, so it should be mounted
      // But it should not appear twice
      const mounts = validateMountPaths([skDir]);
      const configMounts = mounts.filter((m) => m.host === skDir);
      expect(configMounts).toHaveLength(1);
    });
  });

  describe('translatePath', () => {
    const mounts = [
      { host: '/Users/katre/Sites/skimpyclaw', container: '/workspace/skimpyclaw', readOnly: false },
      { host: '/Users/katre/.skimpyclaw', container: '/workspace/config', readOnly: false },
    ];

    it('translates host path to container path', () => {
      expect(translatePath('/Users/katre/Sites/skimpyclaw/src/index.ts', mounts))
        .toBe('/workspace/skimpyclaw/src/index.ts');
    });

    it('translates exact mount root', () => {
      expect(translatePath('/Users/katre/Sites/skimpyclaw', mounts))
        .toBe('/workspace/skimpyclaw');
    });

    it('translates config path', () => {
      expect(translatePath('/Users/katre/.skimpyclaw/config.json', mounts))
        .toBe('/workspace/config/config.json');
    });

    it('translates /Users path to /System/Volumes/Data mount on macOS', () => {
      const macMounts = [
        { host: '/System/Volumes/Data/Users/katre/.skimpyclaw', container: '/workspace/config', readOnly: false },
      ];
      expect(translatePath('/Users/katre/.skimpyclaw/state/japan-flight-watch.json', macMounts))
        .toBe('/workspace/config/state/japan-flight-watch.json');
    });

    it('returns original path if no mount matches', () => {
      expect(translatePath('/tmp/random/file', mounts)).toBe('/tmp/random/file');
    });

    it('expands ~ to home directory before matching', () => {
      const home = process.env.HOME || '/Users/katre';
      const homeMounts = [
        { host: `${home}/.skimpyclaw`, container: '/workspace/config', readOnly: false },
      ];
      expect(translatePath('~/.skimpyclaw/agents/main/HEARTBEAT.md', homeMounts))
        .toBe('/workspace/config/agents/main/HEARTBEAT.md');
    });

    it('matches most specific mount first', () => {
      const nestedMounts = [
        { host: '/Users/katre', container: '/workspace/home', readOnly: false },
        { host: '/Users/katre/Sites/skimpyclaw', container: '/workspace/skimpyclaw', readOnly: false },
      ];
      expect(translatePath('/Users/katre/Sites/skimpyclaw/src/file.ts', nestedMounts))
        .toBe('/workspace/skimpyclaw/src/file.ts');
    });
  });
});
