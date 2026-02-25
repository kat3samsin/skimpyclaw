import { describe, it, expect } from 'vitest';
import {
  isPathLikeToken,
  extractScriptTarget,
  extractPathsFromCommand,
  validateBashPaths,
} from '../tools/bash-path-validation.js';

describe('isPathLikeToken', () => {
  it('detects absolute paths', () => {
    expect(isPathLikeToken('/etc/passwd')).toBe(true);
    expect(isPathLikeToken('/home/user/file.txt')).toBe(true);
  });

  it('detects relative paths', () => {
    expect(isPathLikeToken('./foo')).toBe(true);
    expect(isPathLikeToken('../bar')).toBe(true);
    expect(isPathLikeToken('.')).toBe(true);
    expect(isPathLikeToken('..')).toBe(true);
  });

  it('detects home-relative paths', () => {
    expect(isPathLikeToken('~/Documents')).toBe(true);
    expect(isPathLikeToken('~')).toBe(true);
  });

  it('rejects flags', () => {
    expect(isPathLikeToken('-f')).toBe(false);
    expect(isPathLikeToken('--file')).toBe(false);
    expect(isPathLikeToken('-')).toBe(false);
    expect(isPathLikeToken('--')).toBe(false);
  });

  it('rejects bare words', () => {
    expect(isPathLikeToken('foo')).toBe(false);
    expect(isPathLikeToken('bar.txt')).toBe(false);
    expect(isPathLikeToken('some-command')).toBe(false);
  });

  it('rejects empty/whitespace', () => {
    expect(isPathLikeToken('')).toBe(false);
    expect(isPathLikeToken('  ')).toBe(false);
  });
});

describe('extractScriptTarget', () => {
  it('extracts script path from python command', () => {
    expect(extractScriptTarget(['python3', 'script.py'])).toBe('script.py');
    expect(extractScriptTarget(['python3', '-u', 'script.py'])).toBe('script.py');
    expect(extractScriptTarget(['python', '/home/user/run.py'])).toBe('/home/user/run.py');
  });

  it('extracts script path from node command', () => {
    expect(extractScriptTarget(['node', 'app.js'])).toBe('app.js');
    expect(extractScriptTarget(['node', '--experimental-modules', 'app.js'])).toBe('app.js');
  });

  it('extracts script path from ruby/perl', () => {
    expect(extractScriptTarget(['ruby', 'script.rb'])).toBe('script.rb');
    expect(extractScriptTarget(['perl', 'script.pl'])).toBe('script.pl');
  });

  it('extracts script path from shell interpreters', () => {
    expect(extractScriptTarget(['bash', 'script.sh'])).toBe('script.sh');
    expect(extractScriptTarget(['sh', './run.sh'])).toBe('./run.sh');
  });

  it('returns null for inline execution (-c, -e)', () => {
    expect(extractScriptTarget(['python3', '-c', 'print("hi")'])).toBeNull();
    expect(extractScriptTarget(['node', '-e', 'console.log(1)'])).toBeNull();
    expect(extractScriptTarget(['perl', '-e', 'print 1'])).toBeNull();
    expect(extractScriptTarget(['bash', '-c', 'echo hello'])).toBeNull();
  });

  it('returns null for module execution (-m)', () => {
    expect(extractScriptTarget(['python3', '-m', 'http.server'])).toBeNull();
  });

  it('returns null for non-interpreter commands', () => {
    expect(extractScriptTarget(['ls', '-la'])).toBeNull();
    expect(extractScriptTarget(['grep', 'pattern', 'file.txt'])).toBeNull();
  });

  it('handles env var prefix in segment', () => {
    expect(extractScriptTarget(['NODE_ENV=prod', 'node', 'app.js'])).toBe('app.js');
  });

  it('skips flags with values', () => {
    expect(extractScriptTarget(['python3', '-W', 'ignore', 'script.py'])).toBe('script.py');
  });

  it('returns null for no arguments', () => {
    expect(extractScriptTarget(['python3'])).toBeNull();
    expect(extractScriptTarget([])).toBeNull();
  });
});

describe('extractPathsFromCommand', () => {
  const cwd = '/home/user/project';

  it('extracts absolute paths from simple commands', () => {
    const paths = extractPathsFromCommand('cat /etc/passwd', cwd);
    expect(paths).toContain('/etc/passwd');
  });

  it('extracts relative paths and resolves them', () => {
    const paths = extractPathsFromCommand('cat ./data/file.txt', cwd);
    expect(paths).toContain('/home/user/project/data/file.txt');
  });

  it('extracts home-relative paths', () => {
    const paths = extractPathsFromCommand('cat ~/secret.txt', cwd);
    expect(paths.length).toBe(1);
    expect(paths[0]).toMatch(/secret\.txt$/);
  });

  it('extracts paths from piped commands', () => {
    const paths = extractPathsFromCommand('cat /etc/hosts | grep /var/log/syslog', cwd);
    expect(paths).toContain('/etc/hosts');
    expect(paths).toContain('/var/log/syslog');
  });

  it('extracts paths from chained commands', () => {
    const paths = extractPathsFromCommand('ls /tmp && cat /etc/passwd', cwd);
    expect(paths).toContain('/tmp');
    expect(paths).toContain('/etc/passwd');
  });

  it('extracts interpreter script targets', () => {
    const paths = extractPathsFromCommand('python3 /opt/scripts/exploit.py', cwd);
    expect(paths).toContain('/opt/scripts/exploit.py');
  });

  it('extracts both script target and path args', () => {
    const paths = extractPathsFromCommand('python3 ./script.py /data/input.csv', cwd);
    expect(paths).toContain('/home/user/project/script.py');
    expect(paths).toContain('/data/input.csv');
  });

  it('deduplicates paths', () => {
    const paths = extractPathsFromCommand('cat /etc/passwd /etc/passwd', cwd);
    expect(paths.length).toBe(1);
  });

  it('returns empty for commands with no path args', () => {
    const paths = extractPathsFromCommand('echo hello world', cwd);
    expect(paths).toEqual([]);
  });

  it('returns empty for inline interpreter execution', () => {
    const paths = extractPathsFromCommand('python3 -c "print(1)"', cwd);
    expect(paths).toEqual([]);
  });

  it('handles bare words that are not paths', () => {
    const paths = extractPathsFromCommand('git status', cwd);
    expect(paths).toEqual([]);
  });
});

describe('validateBashPaths', () => {
  // Use /home/user paths to avoid macOS /tmp → /private/tmp symlink issues
  const allowedPaths = ['/home/user/project', '/home/user/data'];

  it('returns null when all paths are allowed', () => {
    expect(validateBashPaths('cat /home/user/project/file.txt', undefined, allowedPaths)).toBeNull();
    expect(validateBashPaths('ls /home/user/data/stuff', undefined, allowedPaths)).toBeNull();
  });

  it('returns error when path is outside allowed dirs', () => {
    const result = validateBashPaths('cat /etc/passwd', undefined, allowedPaths);
    expect(result).toContain('Error');
    expect(result).toContain('/etc/passwd');
  });

  it('blocks interpreter commands targeting outside paths', () => {
    const result = validateBashPaths('python3 /opt/evil.py', undefined, allowedPaths);
    expect(result).toContain('Error');
    expect(result).toContain('/opt/evil.py');
  });

  it('allows interpreter commands targeting allowed paths', () => {
    expect(validateBashPaths('python3 /home/user/project/run.py', undefined, allowedPaths)).toBeNull();
  });

  it('returns null when no allowedPaths configured (permissive)', () => {
    expect(validateBashPaths('cat /etc/passwd', undefined, [])).toBeNull();
  });

  it('blocks paths in chained commands', () => {
    const result = validateBashPaths('ls /home/user/data && cat /etc/shadow', undefined, allowedPaths);
    expect(result).toContain('Error');
    expect(result).toContain('/etc/shadow');
  });

  it('lists all blocked paths in error', () => {
    const result = validateBashPaths('cat /etc/passwd /var/secret', undefined, allowedPaths);
    expect(result).toContain('/etc/passwd');
    expect(result).toContain('/var/secret');
  });

  it('returns null for commands with no path arguments', () => {
    expect(validateBashPaths('echo hello', undefined, allowedPaths)).toBeNull();
    expect(validateBashPaths('git status', undefined, allowedPaths)).toBeNull();
  });
});
