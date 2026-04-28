import type { Config } from '../types.js';
import type { ExecuteToolContext } from './execute-context.js';

export interface DelegateToAgentInput {
  alias?: string;
  task?: string;
  mode?: string;
  wait?: boolean;
  allowSelf?: boolean;
}

export interface NormalizedDelegateToAgentInput {
  alias: string;
  task: string;
  mode: 'new_thread';
  wait: boolean;
  allowSelf: boolean;
}

export type DelegateToAgentHandler = (
  input: NormalizedDelegateToAgentInput,
  config: Config,
  context?: ExecuteToolContext,
) => Promise<string>;

const MAX_DELEGATION_DEPTH = 2;
const ALIAS_RE = /^[a-z][a-z0-9_-]{0,63}$/;
let handler: DelegateToAgentHandler | null = null;

function normalizeAlias(value: unknown): string | null {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/^@/, '').toLowerCase()
    : '';
  return ALIAS_RE.test(normalized) ? normalized : null;
}

export function registerDelegateToAgentHandler(nextHandler: DelegateToAgentHandler | null): void {
  handler = nextHandler;
}

export async function executeDelegateToAgent(
  input: DelegateToAgentInput,
  config: Config,
  context?: ExecuteToolContext,
): Promise<string> {
  const alias = normalizeAlias(input.alias);
  if (!alias) {
    return 'Error: alias must start with a letter and use only letters, numbers, underscore, or dash.';
  }

  const task = typeof input.task === 'string' ? input.task.trim() : '';
  if (!task) {
    return 'Error: task is required.';
  }

  const mode = input.mode?.trim() || 'new_thread';
  if (mode !== 'new_thread') {
    return 'Error: delegate_to_agent currently supports mode "new_thread" only.';
  }

  if (context?.channel !== 'discord') {
    return 'Error: delegate_to_agent is currently Discord-only.';
  }

  if (context?.isDm) {
    return 'Error: delegate_to_agent requires a Discord server channel. Direct messages do not support task threads.';
  }

  const depth = context?.delegationDepth ?? 0;
  if (depth >= MAX_DELEGATION_DEPTH) {
    return `Error: maximum agent delegation depth reached (${MAX_DELEGATION_DEPTH}).`;
  }

  if (!input.allowSelf && context?.threadAgentAlias === alias) {
    return `Error: @${alias} cannot delegate to itself. Choose another agent profile.`;
  }

  if (!handler) {
    return 'Error: Discord agent delegation is not available.';
  }

  return handler({
    alias,
    task,
    mode,
    wait: input.wait === true,
    allowSelf: input.allowSelf === true,
  }, config, context);
}
