import { spawnSync } from 'child_process';

interface SecurityResult {
  ok: boolean;
  detail?: string;
}

function runSecurityCommand(args: string[]): SecurityResult {
  const result = spawnSync('security', args, {
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    return { ok: false, detail: result.error.message };
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim() || `exit ${result.status}`;
    return { ok: false, detail };
  }

  return { ok: true, detail: (result.stdout || '').trim() };
}

let availabilityCache: { checked: boolean; ok: boolean; detail?: string } = {
  checked: false,
  ok: false,
};

export function secureStoreAvailable(): { ok: boolean; detail?: string } {
  if (availabilityCache.checked) {
    return { ok: availabilityCache.ok, detail: availabilityCache.detail };
  }

  if (process.platform !== 'darwin') {
    availabilityCache = {
      checked: true,
      ok: false,
      detail: 'macOS Keychain is only available on darwin',
    };
    return { ok: false, detail: availabilityCache.detail };
  }

  const probe = runSecurityCommand(['list-keychains']);
  availabilityCache = {
    checked: true,
    ok: probe.ok,
    detail: probe.ok ? undefined : probe.detail,
  };

  return { ok: availabilityCache.ok, detail: availabilityCache.detail };
}

export function clearSecureStoreAvailabilityCacheForTests(): void {
  availabilityCache = { checked: false, ok: false };
}

export function requireSecureStore(purpose: string): void {
  const availability = secureStoreAvailable();
  if (!availability.ok) {
    throw new Error(
      `[secure-store] ${purpose} requires macOS Keychain, but it is unavailable${availability.detail ? `: ${availability.detail}` : ''}`,
    );
  }
}

export function getSecureValue(service: string, account: string): string | null {
  requireSecureStore('Secret retrieval');

  const result = runSecurityCommand([
    'find-generic-password',
    '-s',
    service,
    '-a',
    account,
    '-w',
  ]);

  if (!result.ok) {
    return null;
  }

  return (result.detail || '').trim();
}

export function setSecureValue(service: string, account: string, value: string): void {
  requireSecureStore('Secret storage');

  const result = runSecurityCommand([
    'add-generic-password',
    '-U',
    '-s',
    service,
    '-a',
    account,
    '-w',
    value,
  ]);

  if (!result.ok) {
    throw new Error(`[secure-store] Failed writing ${service}/${account}: ${result.detail || 'unknown error'}`);
  }
}
