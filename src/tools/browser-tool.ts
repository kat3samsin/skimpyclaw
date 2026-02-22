import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

import type { ToolConfig } from '../types.js';
import { isPathAllowed } from './path-utils.js';

let playwrightModule: any | null = null;
let browserContext: any | null = null;
let browserPage: any | null = null;
let browserOptionsKey: string | null = null;

async function getPlaywright(): Promise<any> {
  if (!playwrightModule) {
    try {
      playwrightModule = await import('playwright');
    } catch {
      throw new Error('Playwright not installed. Run: npx playwright install');
    }
  }
  return playwrightModule;
}

function resolveScreenshotPath(filePath: string | undefined, config: ToolConfig): string {
  if (filePath) {
    if (!isPathAllowed(filePath, config.allowedPaths)) {
      throw new Error(`Path not allowed. Permitted: ${config.allowedPaths.join(', ')}`);
    }
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return filePath;
  }
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
  const filePath = new URL(url).pathname;
  return isPathAllowed(filePath, config.allowedPaths);
}

/** Pick override only if it's a meaningful value (not empty string, not 0 for non-numeric fields). */
function pick<T>(override: T | undefined, configVal: T | undefined, fallback?: T): T | undefined {
  if (override !== undefined && override !== null && override !== '') return override;
  if (configVal !== undefined && configVal !== null && configVal !== '') return configVal;
  return fallback as T | undefined;
}

function buildBrowserOptions(config: ToolConfig, overrides?: Record<string, any>) {
  // Config values take priority for security/environment settings.
  // Overrides (from model tool calls) only apply when config doesn't specify a value.
  const type = pick(overrides?.type, config.browser?.type, 'chromium') as string;
  const headless = config.browser?.headless ?? overrides?.headless ?? true;
  const slowMo = config.browser?.slowMoMs ?? ((typeof overrides?.slowMoMs === 'number' && overrides.slowMoMs > 0) ? overrides.slowMoMs : undefined);
  const userAgent = pick(config.browser?.userAgent, overrides?.userAgent) as string | undefined;
  const viewport = config.browser?.viewport ?? (overrides?.viewport?.width ? overrides.viewport : undefined);
  // Security: profileDir and executablePath are config-only — never allow model overrides
  const profileDir = config.browser?.profileDir || join(homedir(), '.skimpyclaw', 'browser-profile');
  const executablePath = config.browser?.executablePath;
  return { type, headless, slowMo, userAgent, viewport, profileDir, executablePath };
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
  try {
    browserContext = await browserLauncher.launchPersistentContext(options.profileDir, {
      headless: options.headless,
      slowMo: options.slowMo,
      userAgent: options.userAgent,
      viewport: options.viewport,
      executablePath: options.executablePath,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to launch browser (${options.type}): ${msg}. Ensure the browser is installed: npx playwright install ${options.type}`);
  }

  const pages = browserContext.pages();
  browserPage = pages.length > 0 ? pages[0] : await browserContext.newPage();

  // Remove navigator.webdriver flag that sites use to detect automation
  await browserPage.addInitScript(`Object.defineProperty(navigator, 'webdriver', { get: () => false })`);
  browserOptionsKey = optionsKey;
}

export async function executeBrowser(input: Record<string, any>, config: ToolConfig): Promise<string> {
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
    case 'select': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const selector = input.selector as string | undefined;
      const value = input.text as string | undefined;
      if (!selector || value === undefined) return 'Error: selector and text (value) are required for select.';
      await browserPage.selectOption(selector, value, { timeout: timeoutMs });
      return `Selected "${value}" in: ${selector}`;
    }
    case 'hover': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const selector = input.selector as string | undefined;
      if (!selector) return 'Error: selector is required for hover.';
      await browserPage.hover(selector, { timeout: timeoutMs });
      return `Hovered: ${selector}`;
    }
    case 'scroll': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const selector = input.selector as string | undefined;
      if (selector) {
        await browserPage.evaluate(`{
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) el.scrollIntoView({ behavior: 'smooth' });
        }`);
        return `Scrolled into view: ${selector}`;
      }
      const direction = (input.direction as string || 'down').toLowerCase();
      const amount = typeof input.amount === 'number' ? input.amount : undefined;
      const dir = direction === 'up' ? -1 : 1;
      const scrollExpr = amount != null
        ? `window.scrollBy(0, ${dir * amount})`
        : `window.scrollBy(0, ${dir} * window.innerHeight)`;
      await browserPage.evaluate(scrollExpr);
      return `Scrolled ${direction}${amount ? ` ${amount}px` : ' one viewport'}`;
    }
    case 'evaluate': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const script = input.script as string | undefined;
      if (!script) return 'Error: script is required for evaluate.';
      const result = await browserPage.evaluate(script);
      return JSON.stringify(result);
    }
    case 'gettext': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const selector = input.selector as string | undefined;
      if (selector) {
        const text = await browserPage.textContent(selector, { timeout: timeoutMs });
        return text ?? '(no text content)';
      }
      const bodyText = await browserPage.evaluate('document.body.innerText');
      return bodyText || '(empty page)';
    }
    case 'screenshot': {
      if (!browserPage) return 'Error: Browser not open. Call open(url) first.';
      const filePath = resolveScreenshotPath(input.file_path, config);
      await browserPage.screenshot({ path: filePath, fullPage: true });
      return `Saved screenshot: ${filePath}`;
    }
    case 'wait': {
      const waitMs = typeof input.timeMs === 'number' ? input.timeMs : timeoutMs;
      await new Promise((r) => setTimeout(r, waitMs));
      return `Waited ${waitMs}ms`;
    }
    case 'close': {
      await cleanupBrowser();
      return 'Browser closed.';
    }
    default:
      return `Error: Unknown browser action "${action}"`;
  }
}

export async function cleanupBrowser(): Promise<void> {
  if (browserPage) {
    await browserPage.close().catch(() => {});
    browserPage = null;
  }
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
  }
  browserOptionsKey = null;
}

// Prevent orphaned browser processes on exit
const handleExit = () => {
  if (browserContext) {
    browserContext.close().catch(() => {});
    browserContext = null;
    browserPage = null;
    browserOptionsKey = null;
  }
};
process.on('SIGTERM', handleExit);
process.on('SIGINT', handleExit);
process.on('exit', handleExit);
