import { execInContainer } from './runtime.js';

const MAX_BASH_OUTPUT = 50 * 1024; // 50KB
const MAX_READ_OUTPUT = 100 * 1024; // 100KB

function truncate(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s) <= maxBytes) return s;
  const truncated = Buffer.from(s).subarray(0, maxBytes).toString('utf-8');
  return truncated + '\n... (output truncated)';
}

/**
 * Shell-escape a string for use inside sh -c '...'
 * NOTE: execInContainer already wraps in sh -c, so callers pass
 * args as individual tokens. The runtime joins them with spaces
 * and does basic single-quote escaping. For bash commands we pass
 * the whole command as a single arg string.
 */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export async function sandboxBash(
  containerName: string,
  command: string,
  cwd?: string,
  timeout?: number,
): Promise<string> {
  // Pass the full command as a single string so sh -c runs it verbatim
  const shellCmd = cwd
    ? `cd ${shellEscape(cwd)} && ${command}`
    : command;

  const result = await execInContainer(
    containerName,
    [shellCmd],
    { timeout: timeout ?? 30_000 },
  );

  let output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  output = truncate(output, MAX_BASH_OUTPUT);

  if (result.exitCode !== 0) {
    output += `\n[exit code: ${result.exitCode}]`;
  }

  return output || '(no output)';
}

export async function sandboxReadFile(
  containerName: string,
  path: string,
): Promise<string> {
  // Pass as a single command string to avoid double-escaping
  const result = await execInContainer(
    containerName,
    [`cat -- ${shellEscape(path)}`],
  );

  if (result.exitCode !== 0) {
    throw new Error(`Failed to read ${path}: ${result.stderr}`);
  }

  return truncate(result.stdout, MAX_READ_OUTPUT);
}

export async function sandboxWriteFile(
  containerName: string,
  path: string,
  content: string,
): Promise<string> {
  // mkdir -p for parent dir, then write via stdin
  const result = await execInContainer(
    containerName,
    [`mkdir -p $(dirname ${shellEscape(path)}) && cat > ${shellEscape(path)}`],
    { stdin: content },
  );

  if (result.exitCode !== 0) {
    throw new Error(`Failed to write ${path}: ${result.stderr}`);
  }

  const bytes = Buffer.byteLength(content);
  return `Written: ${path} (${bytes} bytes)`;
}

export async function sandboxListDir(
  containerName: string,
  path: string,
): Promise<string> {
  const result = await execInContainer(
    containerName,
    [`ls -la ${shellEscape(path)}`],
  );

  if (result.exitCode !== 0) {
    throw new Error(`Failed to list ${path}: ${result.stderr}`);
  }

  return result.stdout;
}

export async function sandboxGlob(
  containerName: string,
  base: string,
  pattern: string,
): Promise<string> {
  const result = await execInContainer(
    containerName,
    [`find ${shellEscape(base)} -name ${shellEscape(pattern)} -maxdepth 10 -type f`],
  );

  if (result.exitCode !== 0) {
    throw new Error(`Failed to glob ${base}/${pattern}: ${result.stderr}`);
  }

  return result.stdout;
}
