// Fetch tool — lightweight HTTP requests and web search without browser overhead

import { lookup } from 'dns/promises';
import { BlockList, isIP } from 'net';
import type { ToolConfig } from '../types.js';

export interface FetchInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const MAX_RESPONSE_CHARS = 50_000;
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'metadata.google.internal.',
  'instance-data',
]);

const IP_BLOCKLIST = (() => {
  const blockList = new BlockList();
  blockList.addSubnet('0.0.0.0', 8, 'ipv4');
  blockList.addSubnet('10.0.0.0', 8, 'ipv4');
  blockList.addSubnet('100.64.0.0', 10, 'ipv4');
  blockList.addSubnet('127.0.0.0', 8, 'ipv4');
  blockList.addSubnet('169.254.0.0', 16, 'ipv4');
  blockList.addSubnet('172.16.0.0', 12, 'ipv4');
  blockList.addSubnet('192.0.0.0', 24, 'ipv4');
  blockList.addSubnet('192.0.2.0', 24, 'ipv4');
  blockList.addSubnet('192.168.0.0', 16, 'ipv4');
  blockList.addSubnet('198.18.0.0', 15, 'ipv4');
  blockList.addSubnet('198.51.100.0', 24, 'ipv4');
  blockList.addSubnet('203.0.113.0', 24, 'ipv4');
  blockList.addSubnet('224.0.0.0', 4, 'ipv4');
  blockList.addSubnet('240.0.0.0', 4, 'ipv4');
  blockList.addAddress('::', 'ipv6');
  blockList.addAddress('::1', 'ipv6');
  blockList.addSubnet('fc00::', 7, 'ipv6');
  blockList.addSubnet('fe80::', 10, 'ipv6');
  blockList.addSubnet('ff00::', 8, 'ipv6');
  blockList.addSubnet('2001:db8::', 32, 'ipv6');
  return blockList;
})();

function isBlockedIpAddress(address: string): boolean {
  if (address.startsWith('::ffff:')) {
    return isBlockedIpAddress(address.slice('::ffff:'.length));
  }
  const family = isIP(address);
  if (family === 4) return IP_BLOCKLIST.check(address, 'ipv4');
  if (family === 6) return IP_BLOCKLIST.check(address, 'ipv6');
  return true;
}

async function validateTarget(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Blocked host: ${hostname}`);
  }

  if (isIP(hostname) !== 0 && isBlockedIpAddress(hostname)) {
    throw new Error(`Blocked target IP: ${hostname}`);
  }

  if (isIP(hostname) === 0) {
    const resolved = await lookup(hostname, { all: true, verbatim: true });
    for (const rec of resolved) {
      if (isBlockedIpAddress(rec.address)) {
        throw new Error(`Blocked resolved IP for ${hostname}: ${rec.address}`);
      }
    }
  }

  return parsed;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Strip HTML tags and decode common entities. Returns plain text.
 */
function htmlToText(html: string): string {
  return html
    // Remove script/style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Convert block elements to newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function executeFetch(input: FetchInput, _config: ToolConfig): Promise<string> {
  const { url, method = 'GET', headers = {}, body } = input;

  if (!url) return 'Error: url is required';

  try {
    let target = await validateTarget(url);
    const defaultHeaders: Record<string, string> = {
      'User-Agent': 'SkimpyClaw/1.0',
    };
    let requestMethod = method.toUpperCase();
    let requestBody = body || undefined;
    let response: Response | null = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await fetch(target, {
        method: requestMethod,
        headers: { ...defaultHeaders, ...headers },
        body: requestBody,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      });

      if (!isRedirectStatus(response.status)) {
        break;
      }
      if (hop === MAX_REDIRECTS) {
        return `Error: Too many redirects (>${MAX_REDIRECTS})`;
      }

      const location = response.headers.get('location');
      if (!location) {
        return `Error: Redirect response missing Location header (HTTP ${response.status})`;
      }
      target = await validateTarget(new URL(location, target).toString());
      if ((response.status === 301 || response.status === 302 || response.status === 303) && requestMethod !== 'GET' && requestMethod !== 'HEAD') {
        requestMethod = 'GET';
        requestBody = undefined;
      }
    }
    if (!response) {
      return 'Error: Request did not produce a response';
    }

    const status = `${response.status} ${response.statusText}`;
    const contentType = response.headers.get('content-type') || '';
    let responseBody: string;

    if (contentType.includes('json')) {
      const text = await response.text();
      try {
        responseBody = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        responseBody = text;
      }
    } else if (contentType.includes('html')) {
      const html = await response.text();
      responseBody = htmlToText(html);
    } else {
      responseBody = await response.text();
    }

    if (responseBody.length > MAX_RESPONSE_CHARS) {
      responseBody = responseBody.slice(0, MAX_RESPONSE_CHARS) + `\n\n[Truncated: ${responseBody.length} chars total]`;
    }

    return `HTTP ${status}\n\n${responseBody}`;
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return `Error: Request timed out after ${TIMEOUT_MS / 1000}s`;
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
