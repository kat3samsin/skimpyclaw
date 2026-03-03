// Shared sandbox runtime detection helpers (used by setup.ts and cli.ts)

import { spawnSync } from 'child_process';

export type SandboxRuntime = 'container' | 'docker';

export function detectSandboxRuntime(preferred?: SandboxRuntime | string | null): SandboxRuntime | null {
  if (preferred === 'container' || preferred === 'docker') {
    return spawnSync(preferred, ['--version'], { encoding: 'utf-8' }).status === 0 ? preferred : null;
  }

  if (spawnSync('container', ['--version'], { encoding: 'utf-8' }).status === 0) {
    return 'container';
  }
  if (spawnSync('docker', ['--version'], { encoding: 'utf-8' }).status === 0) {
    return 'docker';
  }
  return null;
}

export function isSandboxRuntimeRunning(runtime: SandboxRuntime): boolean {
  if (runtime === 'container') {
    return spawnSync('container', ['system', 'status'], { encoding: 'utf-8' }).status === 0;
  }
  return spawnSync('docker', ['info'], { encoding: 'utf-8' }).status === 0;
}

export function sandboxNetworkExists(runtime: SandboxRuntime, network: string): boolean {
  if (runtime === 'container') {
    const result = spawnSync('container', ['network', 'ls'], { encoding: 'utf-8' });
    if (result.status !== 0) return false;
    return result.stdout.split('\n').some((line) => line.trim().split(/\s+/)[0] === network);
  }
  const result = spawnSync('docker', ['network', 'inspect', network], { encoding: 'utf-8' });
  return result.status === 0;
}

export function defaultSandboxNetwork(runtime: SandboxRuntime): string {
  return runtime === 'container' ? 'default' : 'bridge';
}

export function sandboxImageExists(runtime: SandboxRuntime, image: string): boolean {
  return spawnSync(runtime, ['image', 'inspect', image], { encoding: 'utf-8' }).status === 0;
}
