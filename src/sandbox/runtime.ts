import { spawn, spawnSync } from 'child_process';

export interface ContainerOpts {
  image: string;
  cpus?: number;
  memory?: string;
  network?: string;
  mounts?: Array<{ host: string; container: string; readOnly?: boolean }>;
  env?: Record<string, string>;
  user?: string;
}

export interface ExecOpts {
  stdin?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT = 30_000;
const CONTAINER_PREFIX = 'skimpyclaw-sbx-';

/** Resolved container CLI binary. Set once via setRuntime() or auto-detected on first use. */
let runtimeBinary: string | null = null;

/** Set the container runtime binary ('container' or 'docker'). */
export function setRuntime(runtime: 'container' | 'docker'): void {
  runtimeBinary = runtime;
}

/** Get the container runtime binary, auto-detecting if not explicitly set. */
export function getRuntime(): string {
  if (runtimeBinary) return runtimeBinary;

  // Auto-detect: prefer Apple Containers, fall back to Docker
  if (spawnSync('container', ['--version'], { stdio: 'ignore' }).status === 0) {
    runtimeBinary = 'container';
  } else if (spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0) {
    runtimeBinary = 'docker';
  } else {
    throw new Error('No container runtime found. Install Apple Containers or Docker.');
  }

  return runtimeBinary;
}

/**
 * Check if a usable container runtime is available.
 * Returns the runtime name if found, null otherwise. Never throws.
 */
export function probeRuntime(preferred?: string): string | null {
  // If a preferred runtime is specified, check that one first
  if (preferred) {
    const result = spawnSync(preferred, ['--version'], { stdio: 'ignore' });
    if (result.status === 0) return preferred;
  }

  // Auto-detect: prefer Apple Containers, fall back to Docker
  if (spawnSync('container', ['--version'], { stdio: 'ignore' }).status === 0) {
    return 'container';
  }
  if (spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0) {
    return 'docker';
  }

  return null;
}

/** Reset runtime detection (for testing). */
export function resetRuntime(): void {
  runtimeBinary = null;
}

function runCommand(
  cmd: string,
  args: string[],
  opts?: { stdin?: string; timeout?: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
    const child = spawn(cmd, args, {
      stdio: [opts?.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(timeout),
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    if (opts?.stdin && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }

    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code ?? 1,
      });
    });

    child.on('error', (err) => {
      const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
      if ((err as NodeJS.ErrnoException).name === 'AbortError') {
        reject(new Error(`Sandbox command timed out after ${Math.round(timeout / 1000)}s`));
        return;
      }
      reject(err);
    });
  });
}

function formatCreateContainerError(runtime: string, network: string | undefined, stderr: string): string {
  const raw = stderr.trim();
  if (raw.includes('network bridge not found')) {
    return `network "${network || 'bridge'}" not found for ${runtime}. ` +
      `Use sandbox.network="${runtime === 'container' ? 'default' : 'bridge'}" and retry.`;
  }
  if (raw.includes('pull access denied') || raw.includes('not found')) {
    return `sandbox image is missing. Build it with: ${runtime} build -t skimpyclaw-sandbox:latest sandbox/`;
  }
  return raw;
}

export async function createContainer(name: string, opts: ContainerOpts): Promise<void> {
  const runtime = getRuntime();
  const args = ['run', '-d', '--name', name];

  if (opts.user) {
    args.push('--user', opts.user);
  }

  if (opts.cpus) {
    args.push('--cpus', String(opts.cpus));
  }

  if (opts.memory) {
    args.push('--memory', opts.memory);
  }

  if (opts.network) {
    args.push('--network', opts.network);
  }

  if (opts.mounts) {
    for (const m of opts.mounts) {
      let mountArg = `type=bind,src=${m.host},dst=${m.container}`;
      if (m.readOnly) {
        mountArg += ',ro';
      }
      args.push('--mount', mountArg);
    }
  }

  if (opts.env) {
    for (const [key, val] of Object.entries(opts.env)) {
      args.push('-e', `${key}=${val}`);
    }
  }

  args.push(opts.image, 'sleep', 'infinity');

  const result = await runCommand(runtime, args);
  if (result.exitCode !== 0) {
    const hint = formatCreateContainerError(runtime, opts.network, result.stderr);
    throw new Error(`Failed to create container ${name}: ${hint}`);
  }
}

export async function execInContainer(
  name: string,
  args: string[],
  opts?: ExecOpts,
): Promise<ExecResult> {
  // Callers (bridge.ts) handle their own escaping — just join args
  const escaped = args.join(' ');

  const execArgs = ['exec'];

  if (opts?.stdin) {
    execArgs.push('-i');
  }

  if (opts?.env) {
    for (const [key, val] of Object.entries(opts.env)) {
      execArgs.push('-e', `${key}=${val}`);
    }
  }

  execArgs.push(name, 'sh', '-c', escaped);

  return runCommand(getRuntime(), execArgs, {
    stdin: opts?.stdin,
    timeout: opts?.timeout ?? DEFAULT_TIMEOUT,
  });
}

export async function removeContainer(name: string): Promise<void> {
  const runtime = getRuntime();
  // Best-effort stop then force rm to clear stopped/dead containers
  await runCommand(runtime, ['stop', name]).catch(() => {});
  await runCommand(runtime, ['rm', '-f', name]).catch(() => {});
}

export async function isContainerRunning(name: string): Promise<boolean> {
  const runtime = getRuntime();

  // Docker: use --format to check the running state directly
  if (runtime === 'docker') {
    const result = await runCommand(runtime, ['inspect', '--format', '{{.State.Running}}', name]);
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  // Apple Containers: inspect succeeds for any state; check ps output
  const result = await runCommand(runtime, ['inspect', name]);
  if (result.exitCode !== 0) return false;
  // If stdout contains "running" state indicator, it's running
  const output = result.stdout.toLowerCase();
  return output.includes('"running"') || output.includes('status: running') || output.includes('state: running');
}

export async function cleanupOrphans(): Promise<number> {
  const rt = getRuntime();

  // Try Docker-style --format first, fall back to plain ps for Apple Containers
  let result = await runCommand(rt, ['ps', '-a', '--format', '{{.Names}}']);
  if (result.exitCode !== 0) {
    // Fallback: plain ps output, grep for our prefix
    result = await runCommand(rt, ['ps', '-a']);
    if (result.exitCode !== 0) return 0;
  }

  const names = result.stdout
    .split('\n')
    .map((n) => n.trim())
    .filter((n) => n.startsWith(CONTAINER_PREFIX) || n.includes(CONTAINER_PREFIX))
    // Extract container name if it's in a table row
    .map((n) => {
      const match = n.match(new RegExp(`(${CONTAINER_PREFIX}[\\w-]+)`));
      return match ? match[1] : n;
    })
    .filter((n) => n.startsWith(CONTAINER_PREFIX));

  for (const name of names) {
    await removeContainer(name);
  }

  return names.length;
}
