#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SECRET_PATTERNS = [
  { name: 'AWS access key', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'GitHub token', regex: /ghp_[A-Za-z0-9]{36,}/g },
  { name: 'GitHub fine-grained token', regex: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'Slack token', regex: /xox[baprs]-[A-Za-z0-9-]+/g },
  { name: 'Private key block', regex: /-----BEGIN (?:RSA|OPENSSH|EC|DSA)? ?PRIVATE KEY-----/g },
  { name: 'OpenAI-style key', regex: /sk-[A-Za-z0-9]{20,}/g },
];

const ABSOLUTE_PATH_PATTERNS = [
  { name: 'macOS user dir', regex: /\/Users\/[A-Za-z0-9._-]+\/[A-Za-z0-9._\/-]+/g },
  { name: 'Linux home dir', regex: /\/home\/[A-Za-z0-9._-]+\/[A-Za-z0-9._\/-]+/g },
  { name: 'Windows user dir', regex: /[A-Za-z]:\\\\Users\\\\[^\\\s"']+\\\\[^\s"']+/g },
  { name: 'tmp-like system dir', regex: /\/(?:private\/)?var\/folders\/[A-Za-z0-9\/._-]+/g },
];

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.sh', '.md', '.toml', '.ini', '.conf', '.txt'
]);

function getTrackedFiles() {
  const out = execSync('git ls-files', { encoding: 'utf8' });
  return out
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => f.startsWith('src/') || f.startsWith('scripts/') || f.startsWith('.github/') || f === 'package.json');
}

function isScannable(file) {
  const base = path.basename(file).toLowerCase();
  if (/^\.env(\..+)?$/.test(base) && !/^\.env\.(example|sample|template)$/.test(base)) {
    return true;
  }
  return CODE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function lineAndCol(content, index) {
  const prefix = content.slice(0, index);
  const lines = prefix.split('\n');
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

function shouldIgnoreLine(line) {
  return line.includes('scan:allow') || line.includes('scan-ignore');
}

const findings = [];

for (const file of getTrackedFiles()) {
  if (!isScannable(file)) continue;

  const base = path.basename(file).toLowerCase();
  if (/^\.env(\..+)?$/.test(base) && !/^\.env\.(example|sample|template)$/.test(base)) {
    findings.push({
      file,
      line: 1,
      col: 1,
      kind: 'Tracked .env file',
      match: base,
    });
    continue;
  }

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  for (const { name, regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const { line, col } = lineAndCol(content, match.index);
      const sourceLine = content.split('\n')[line - 1] || '';
      if (shouldIgnoreLine(sourceLine)) continue;
      findings.push({ file, line, col, kind: name, match: match[0].slice(0, 80) });
    }
  }

  for (const { name, regex } of ABSOLUTE_PATH_PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const { line, col } = lineAndCol(content, match.index);
      const sourceLine = content.split('\n')[line - 1] || '';
      if (shouldIgnoreLine(sourceLine)) continue;
      findings.push({ file, line, col, kind: `Hardcoded directory (${name})`, match: match[0].slice(0, 120) });
    }
  }
}

if (findings.length) {
  console.error('\n[security-scan] Found potential issues:\n');
  for (const f of findings) {
    console.error(`- ${f.file}:${f.line}:${f.col} | ${f.kind} | ${f.match}`);
  }
  console.error('\n[security-scan] Failing build. Remove secrets/hardcoded paths or add scan-ignore for intentional test fixtures.');
  process.exit(1);
}

console.log('[security-scan] OK — no obvious secrets, tracked .env files, or hardcoded directories found.');
