// Fetch tool — lightweight HTTP requests and web search without browser overhead

import type { LookupAddress } from 'dns';
import { lookup } from 'dns/promises';
import { BlockList, isIP } from 'net';
import type { LookupFunction } from 'net';
import { Agent } from 'undici';
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

interface ValidatedTarget {
  url: URL;
  addresses: LookupAddress[];
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'metadata.google.internal.',
  'instance-data',
]);
const BLOCKED_HOST_SUFFIXES = ['.internal', '.local', '.lan', '.home', '.localhost'];

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

async function validateTarget(rawUrl: string): Promise<ValidatedTarget> {
  const parsed = new URL(rawUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Blocked host: ${hostname}`);
  }
  if (BLOCKED_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix))) {
    throw new Error(`Blocked internal host: ${hostname}`);
  }

  const literalFamily = isIP(hostname);
  if (literalFamily !== 0 && isBlockedIpAddress(hostname)) {
    throw new Error(`Blocked target IP: ${hostname}`);
  }

  let addresses: LookupAddress[];
  if (literalFamily === 0) {
    addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length) {
      throw new Error(`Could not resolve host: ${hostname}`);
    }
    for (const rec of addresses) {
      if (isBlockedIpAddress(rec.address)) {
        throw new Error(`Blocked resolved IP for ${hostname}: ${rec.address}`);
      }
    }
  } else {
    addresses = [{ address: hostname, family: literalFamily }];
  }

  return { url: parsed, addresses };
}

function createPinnedAgent(addresses: LookupAddress[]): Agent {
  const pinned = addresses.map(record => ({ ...record }));
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : 0;
    const eligible = requestedFamily
      ? pinned.filter(record => record.family === requestedFamily)
      : pinned;
    if (!eligible.length) {
      const error = Object.assign(new Error('No validated address matches the requested family'), { code: 'ENOTFOUND' });
      callback(error, '');
      return;
    }
    if (options.all) {
      callback(null, eligible.map(record => ({ ...record })));
      return;
    }
    callback(null, eligible[0].address, eligible[0].family);
  };

  return new Agent({
    connect: { lookup: pinnedLookup },
    autoSelectFamily: true,
  });
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

export async function executeFetch(
  input: FetchInput,
  _config: ToolConfig,
  abortSignal?: AbortSignal,
): Promise<string> {
  const { url, method = 'GET', headers = {}, body } = input;

  if (!url) return 'Error: url is required';

  let requestTimedOut = false;
  let cleanupActiveRequest: (() => void) | null = null;
  let activeDispatcher: Agent | null = null;
  try {
    if (abortSignal?.aborted) return 'Error: Request cancelled';
    let target = await validateTarget(url);
    if (abortSignal?.aborted) return 'Error: Request cancelled';
    const defaultHeaders: Record<string, string> = {
      'User-Agent': 'SkimpyClaw/1.0',
    };
    let requestMethod = method.toUpperCase();
    let requestBody = body || undefined;
    let response: Response | null = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (abortSignal?.aborted) return 'Error: Request cancelled';
      const requestController = new AbortController();
      requestTimedOut = false;
      const timeout = setTimeout(() => {
        requestTimedOut = true;
        requestController.abort();
      }, TIMEOUT_MS);
      const onAbort = () => requestController.abort();
      const cleanupRequest = () => {
        clearTimeout(timeout);
        abortSignal?.removeEventListener('abort', onAbort);
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      const dispatcher = createPinnedAgent(target.addresses);
      try {
        response = await fetch(target.url, {
          method: requestMethod,
          headers: { ...defaultHeaders, ...headers },
          body: requestBody,
          signal: requestController.signal,
          redirect: 'manual',
          dispatcher,
        } as RequestInit & { dispatcher: Agent });
      } catch (err) {
        cleanupRequest();
        dispatcher.destroy();
        throw err;
      }

      if (!isRedirectStatus(response.status)) {
        cleanupActiveRequest = cleanupRequest;
        activeDispatcher = dispatcher;
        break;
      }
      cleanupRequest();
      try {
        await response.body?.cancel();
        await dispatcher.close();
      } catch (err) {
        dispatcher.destroy();
        throw err;
      }
      if (hop === MAX_REDIRECTS) {
        return `Error: Too many redirects (>${MAX_REDIRECTS})`;
      }

      const location = response.headers.get('location');
      if (!location) {
        return `Error: Redirect response missing Location header (HTTP ${response.status})`;
      }
      target = await validateTarget(new URL(location, target.url).toString());
      if (abortSignal?.aborted) return 'Error: Request cancelled';
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
    const rawBody = await response.text();
    let responseBody: string;

    if (contentType.includes('json')) {
      try {
        responseBody = JSON.stringify(JSON.parse(rawBody), null, 2);
      } catch {
        responseBody = rawBody;
      }
    } else if (contentType.includes('html')) {
      responseBody = htmlToText(rawBody);
    } else {
      responseBody = rawBody;
    }

    if (responseBody.length > MAX_RESPONSE_CHARS) {
      responseBody = responseBody.slice(0, MAX_RESPONSE_CHARS) + `\n\n[Truncated: ${responseBody.length} chars total]`;
    }

    cleanupActiveRequest?.();
    cleanupActiveRequest = null;
    await activeDispatcher?.close();
    activeDispatcher = null;
    return `HTTP ${status}\n\n${responseBody}`;
  } catch (err) {
    cleanupActiveRequest?.();
    cleanupActiveRequest = null;
    activeDispatcher?.destroy();
    activeDispatcher = null;
    if (abortSignal?.aborted) {
      return 'Error: Request cancelled';
    }
    if (requestTimedOut) {
      return `Error: Request timed out after ${TIMEOUT_MS / 1000}s`;
    }
    if (err instanceof Error && err.name === 'TimeoutError') {
      return `Error: Request timed out after ${TIMEOUT_MS / 1000}s`;
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
