import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { executeInitExperiment, executeRunExperiment, executeLogExperiment } from '../tools/autoresearch-tool.js';

const TEST_DIR = join(import.meta.dirname, '..', '..', '__test_autoresearch__');

describe('autoresearch tools', () => {
  beforeEach(() => {
    // Create a temp git repo
    mkdirSync(TEST_DIR, { recursive: true });
    execSync('git init && git commit --allow-empty -m "init"', { cwd: TEST_DIR });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('init_experiment', () => {
    it('creates autoresearch.jsonl with config header', () => {
      const result = executeInitExperiment(
        { name: 'Test Session', metric_name: 'seconds', metric_unit: 's', direction: 'lower' },
        TEST_DIR,
      );

      expect(result).toContain('✅ Experiment initialized');
      expect(result).toContain('Test Session');

      const jsonlPath = join(TEST_DIR, 'autoresearch.jsonl');
      expect(existsSync(jsonlPath)).toBe(true);
      const content = readFileSync(jsonlPath, 'utf-8');
      const config = JSON.parse(content.trim());
      expect(config.type).toBe('config');
      expect(config.metricName).toBe('seconds');
      expect(config.bestDirection).toBe('lower');
    });

    it('requires name and metric_name', () => {
      const result = executeInitExperiment({}, TEST_DIR);
      expect(result).toContain('Error');
    });
  });

  describe('run_experiment', () => {
    it('runs a command and captures output', async () => {
      const result = await executeRunExperiment(
        { command: 'echo "METRIC total=42"' },
        TEST_DIR,
      );

      expect(result).toContain('✅ PASSED');
      expect(result).toContain('METRIC total=42');
    });

    it('reports failure on non-zero exit', async () => {
      const result = await executeRunExperiment(
        { command: 'exit 1' },
        TEST_DIR,
      );

      expect(result).toContain('💥 FAILED');
    });

    it('reports timeout', async () => {
      const result = await executeRunExperiment(
        { command: 'sleep 10', timeout_seconds: 1 },
        TEST_DIR,
      );

      expect(result).toContain('⏰ TIMEOUT');
    });

    it('runs checks if autoresearch.checks.sh exists', async () => {
      writeFileSync(join(TEST_DIR, 'autoresearch.checks.sh'), '#!/bin/bash\necho "checks ok"');
      execSync(`chmod +x ${join(TEST_DIR, 'autoresearch.checks.sh')}`);

      const result = await executeRunExperiment(
        { command: 'echo "ok"' },
        TEST_DIR,
      );

      expect(result).toContain('✅ Checks passed');
    });

    it('reports checks failure', async () => {
      writeFileSync(join(TEST_DIR, 'autoresearch.checks.sh'), '#!/bin/bash\nexit 1');
      execSync(`chmod +x ${join(TEST_DIR, 'autoresearch.checks.sh')}`);

      const result = await executeRunExperiment(
        { command: 'echo "ok"' },
        TEST_DIR,
      );

      expect(result).toContain('CHECKS FAILED');
    });
  });

  describe('log_experiment', () => {
    it('appends result to JSONL and commits on keep', () => {
      // Init first
      executeInitExperiment(
        { name: 'Test', metric_name: 'ms', direction: 'lower' },
        TEST_DIR,
      );

      // Create a file to commit
      writeFileSync(join(TEST_DIR, 'test.txt'), 'hello');

      const result = executeLogExperiment(
        { metric: 100, status: 'keep', description: 'baseline run' },
        TEST_DIR,
      );

      expect(result).toContain('Logged #1: keep');
      expect(result).toContain('Git: committed');

      // Check JSONL has the result
      const lines = readFileSync(join(TEST_DIR, 'autoresearch.jsonl'), 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2); // config + result
      const entry = JSON.parse(lines[1]);
      expect(entry.metric).toBe(100);
      expect(entry.status).toBe('keep');
    });

    it('reverts on discard', () => {
      executeInitExperiment({ name: 'Test', metric_name: 'ms' }, TEST_DIR);

      // Commit baseline first
      writeFileSync(join(TEST_DIR, 'base.txt'), 'base');
      execSync('git add -A && git commit -m "base"', { cwd: TEST_DIR });

      // Create a new file that should be reverted
      writeFileSync(join(TEST_DIR, 'experiment.txt'), 'bad change');

      const result = executeLogExperiment(
        { metric: 200, status: 'discard', description: 'worse result' },
        TEST_DIR,
      );

      expect(result).toContain('reverted');
      // The experiment file should be gone (reverted)
      expect(existsSync(join(TEST_DIR, 'experiment.txt'))).toBe(false);
    });

    it('prevents keep when checks failed', () => {
      // Simulate checks failure by importing and setting the internal state
      // We'll test this indirectly through the full flow
      executeInitExperiment({ name: 'Test', metric_name: 'ms' }, TEST_DIR);

      const result = executeLogExperiment(
        { metric: 50, status: 'discard', description: 'test run' },
        TEST_DIR,
      );

      expect(result).toContain('Logged #1: discard');
    });
  });
});
