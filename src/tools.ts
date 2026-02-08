// Tool definitions and executors for Anthropic API tool_use

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'fs';
import { join, resolve, dirname, sep } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { isBashCommandSafe } from './security.js';
import type { ToolConfig } from './types.js';

// Claude Code canonical tool names (stealth mode for OAuth compatibility)
// Maps our internal names to Claude Code's exact casing
const TOOL_NAME_MAP: Record<string, string> = {
  'Read': 'read_file',
  'Write': 'write_file',
  'Glob': 'list_directory',
  'Bash': 'bash',
};

// Reverse map: internal name -> Claude Code name
const INTERNAL_TO_CC: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_NAME_MAP).map(([cc, internal]) => [internal, cc])
);

/** Convert Claude Code tool name back to our internal name */
export function fromClaudeCodeName(name: string): string {
  return TOOL_NAME_MAP[name] || name;
}

/** Convert our internal name to Claude Code tool name */
export function toClaudeCodeName(name: string): string {
  return INTERNAL_TO_CC[name] || name;
}

// Anthropic API tool definitions — names match Claude Code for OAuth stealth
export const TOOL_DEFINITIONS = [
  {
    name: 'Read',
    description: 'Read the contents of a file at the given absolute path.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file. Creates parent directories if needed. Overwrites existing files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Glob',
    description: 'List files and directories at the given path. Returns name, type (file/dir), and size.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute path to the directory to list' },
      },
      required: ['path'],
    },
  },
  {
    name: 'Bash',
    description: 'Execute a shell command and return stdout/stderr. Use for CLI tools like gh, icalBuddy, date, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Browser',
    description: 'Control a headless browser (Playwright). Actions: open, click, type, waitFor, screenshot, wait, close.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', description: 'open | click | type | waitFor | screenshot | wait | close' },
        type: { type: 'string', description: 'Browser type: chromium | firefox | webkit (optional, config default)' },
        url: { type: 'string', description: 'URL to open (open action)' },
        selector: { type: 'string', description: 'CSS selector (click/type/waitFor)' },
        text: { type: 'string', description: 'Text to type or wait for (type/waitFor)' },
        file_path: { type: 'string', description: 'Absolute path to save screenshot (optional)' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (optional)' },
        timeMs: { type: 'number', description: 'Time to wait in ms (wait action)' },
        headless: { type: 'boolean', description: 'Override headless for open (optional)' },
        slowMoMs: { type: 'number', description: 'Slow motion delay per action (ms) (optional)' },
        userAgent: { type: 'string', description: 'Override user agent (optional)' },
        viewport: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
      },
      required: ['action'],
    },
  },
];

// --- Path Validation ---

function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  const resolved = resolve(filePath);
  return allowedPaths.some((allowed) => {
    const allowedRoot = resolve(allowed);
    return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${sep}`);
  });
}

// --- Tool Executor ---

export async function executeTool(
  name: string,
  input: Record<string, any>,
  config: ToolConfig
): Promise<string> {
  // Map Claude Code names to internal names
  const internalName = fromClaudeCodeName(name).toLowerCase();
  try {
    switch (internalName) {
      case 'read_file':
        return executeReadFile(input.file_path || input.path, config);
      case 'write_file':
        return executeWriteFile(input.file_path || input.path, input.content, config);
      case 'list_directory':
        return executeListDirectory(input.path, config);
      case 'bash':
        return await executeBash(input.command, input.cwd, config);
      case 'browser':
        return await executeBrowser(input, config);
      default:
        return `Error: Unknown tool "${name}"`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// --- Individual Tool Implementations ---

function executeReadFile(path: string, config: ToolConfig): string {
  if (!isPathAllowed(path, config.allowedPaths)) {
    return `Error: Path not allowed. Permitted: ${config.allowedPaths.join(', ')}`;
  }
  if (!existsSync(path)) {
    return `Error: File not found: ${path}`;
  }
  const content = readFileSync(path, 'utf-8');
  if (content.length > 100_000) {
    return content.slice(0, 100_000) + '\n\n[TRUNCATED - file exceeds 100KB]';
  }
  return content;
}

function executeWriteFile(path: string, content: string, config: ToolConfig): string {
  if (!isPathAllowed(path, config.allowedPaths)) {
    return `Error: Path not allowed. Permitted: ${config.allowedPaths.join(', ')}`;
  }
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, content, 'utf-8');
  return `Written: ${path} (${content.length} bytes)`;
}

function executeListDirectory(path: string, config: ToolConfig): string {
  if (!isPathAllowed(path, config.allowedPaths)) {
    return `Error: Path not allowed. Permitted: ${config.allowedPaths.join(', ')}`;
  }
  if (!existsSync(path)) {
    return `Error: Directory not found: ${path}`;
  }
  const entries = readdirSync(path, { withFileTypes: true });
  if (entries.length === 0) return '(empty directory)';

  const lines = entries.map(e => {
    const type = e.isDirectory() ? 'dir' : 'file';
    if (e.isFile()) {
      const stat = statSync(join(path, e.name));
      return `${type}\t${e.name}\t${stat.size}`;
    }
    return `${type}\t${e.name}`;
  });
  return lines.join('\n');
}

function executeBash(command: string, cwd: string | undefined, config: ToolConfig): Promise<string> {
  if (!isBashCommandSafe(command)) {
    return Promise.resolve('Error: Command blocked by safety filter.');
  }
  if (cwd && !isPathAllowed(cwd, config.allowedPaths)) {
    return Promise.resolve('Error: Working directory not in allowed paths.');
  }

  const timeout = config.bashTimeout || 30_000;

  return new Promise((res) => {
    exec(command, {
      cwd: cwd || undefined,
      timeout,
      env: { ...process.env },
      maxBuffer: 5 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const parts = [stdout, stderr, `Exit code: ${error.code ?? 'unknown'}`].filter(Boolean);
        res(parts.join('\n').slice(0, 50_000));
        return;
      }
      const output = [stdout, stderr].filter(Boolean).join('\n');
      res(output.slice(0, 50_000) || '(no output)');
    });
  });
}

// --- Browser Tool (Playwright) ---

let playwrightModule: any | null = null;
let browserContext: any | null = null;
let browserPage: any | null = null;
let browserOptionsKey: string | null = null;

async function getPlaywright(): Promise<any> {
  if (!playwrightModule) {
    playwrightModule = await import('playwright');
  }
  return playwrightModule;
}

function resolveScreenshotPath(filePath?: string): string {
  if (filePath) return filePath;
  const dir = join(homedir(), '.skimpyclaw', 'screenshots');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(dir, `shot-${stamp}.png`);
}

function isFileUrlAllowed(url: string, config: ToolConfig): boolean {
  if (!url.startsWith('file://')) return true;
  if (!config.browser?.allowFile) return false;
  const path = url.replace('file://', '');
  return isPathAllowed(path, config.allowedPaths);
}

function buildBrowserOptions(config: ToolConfig, overrides?: Record<string, any>) {
  const type = overrides?.type ?? config.browser?.type ?? 'chromium';
  const headless = overrides?.headless ?? config.browser?.headless ?? true;
  const slowMo = overrides?.slowMoMs ?? config.browser?.slowMoMs;
  const userAgent = overrides?.userAgent ?? config.browser?.userAgent;
  const viewport = overrides?.viewport ?? config.browser?.viewport;
  const profileDir = overrides?.profileDir ?? config.browser?.profileDir ?? join(homedir(), '.skimpyclaw', 'browser-profile');
  return { type, headless, slowMo, userAgent, viewport, profileDir };
}

async function ensureBrowser(config: ToolConfig, overrides?: Record<string, any>): Promise<void> {
  const options = buildBrowserOptions(config, overrides);
  const optionsKey = JSON.stringify(options);

  if (browserContext && browserPage && browserOptionsKey === optionsKey) return;

  if (browserPage) {
    await browserPage.close().catch(() => {});
    browserPage = null;
  }
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
  }

  if (!isPathAllowed(options.profileDir, config.allowedPaths)) {
    throw new Error(`Profile dir not allowed. Add to allowedPaths: ${options.profileDir}`);
  }
  if (!existsSync(options.profileDir)) {
    mkdirSync(options.profileDir, { recursive: true });
  }

  const pw = await getPlaywright();
  const browserLauncher = pw[options.type as keyof typeof pw] || pw.chromium;
  browserContext = await browserLauncher.launchPersistentContext(options.profileDir, {
    headless: options.headless,
    slowMo: options.slowMo,
    userAgent: options.userAgent,
    viewport: options.viewport,
  });

  const pages = browserContext.pages();
  browserPage = pages.length > 0 ? pages[0] : await browserContext.newPage();
  browserOptionsKey = optionsKey;
}

async function executeBrowser(input: Record<string, any>, config: ToolConfig): Promise<string> {
  if (!config.browser?.enabled) {
    return 'Error: Browser tool is disabled. Enable it in config (tools.browser.enabled).';
  }

  const action = String(input.action || '').toLowerCase();
  const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : 30_000;

  switch (action) {
    case 'open': {
      const url = input.url as string | undefined;
      if (!url) return 'Error: url is required for open.';
      if (!isFileUrlAllowed(url, config)) {
        return 'Error: file:// URLs are blocked. Enable tools.browser.allowFile to allow.';
      }
      await ensureBrowser(config, input);
      await browserPage.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      return `Opened: ${url}`;
    }
    case 'click': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const selector = input.selector as string | undefined;
      if (!selector) return 'Error: selector is required for click.';
      await browserPage.click(selector, { timeout: timeoutMs });
      return `Clicked: ${selector}`;
    }
    case 'type': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const selector = input.selector as string | undefined;
      const text = input.text as string | undefined;
      if (!selector || text === undefined) return 'Error: selector and text are required for type.';
      await browserPage.fill(selector, text, { timeout: timeoutMs });
      return `Typed into: ${selector}`;
    }
    case 'waitfor': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const selector = input.selector as string | undefined;
      const text = input.text as string | undefined;
      if (!selector && !text) return 'Error: selector or text is required for waitFor.';
      if (selector) {
        await browserPage.waitForSelector(selector, { timeout: timeoutMs });
        return `Waited for selector: ${selector}`;
      }
      await browserPage.waitForSelector(`text=${text}`, { timeout: timeoutMs });
      return `Waited for text: ${text}`;
    }
    case 'screenshot': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const filePath = resolveScreenshotPath(input.file_path);
      if (!isPathAllowed(filePath, config.allowedPaths)) {
        return `Error: Path not allowed. Permitted: ${config.allowedPaths.join(', ')}`;
      }
      await browserPage.screenshot({ path: filePath, fullPage: true });
      return `Saved screenshot: ${filePath}`;
    }
    case 'wait': {
      const waitMs = typeof input.timeMs === 'number' ? input.timeMs : timeoutMs;
      await new Promise((r) => setTimeout(r, waitMs));
      return `Waited ${waitMs}ms`;
    }
    case 'close': {
      if (browserPage) {
        await browserPage.close().catch(() => {});
        browserPage = null;
      }
      if (browserContext) {
        await browserContext.close().catch(() => {});
        browserContext = null;
      }
      browserOptionsKey = null;
      return 'Browser closed.';
    }
    default:
      return `Error: Unknown browser action "${action}"`;
  }
}
