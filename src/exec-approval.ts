// Exec Approval Gate — risk classification and pending approval registry for Bash commands

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

// --- Risk Classification ---

export type RiskTier = 0 | 1 | 2 | 3;

export interface RiskClassification {
  tier: RiskTier;
  reason: string;
}

interface DangerousPattern {
  pattern: RegExp;
  tier: RiskTier;
  reason: string;
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // Tier 3: catastrophic / irreversible
  { pattern: /rm\s+-rf/i, tier: 3, reason: 'Recursive force delete' },
  { pattern: /mkfs/i, tier: 3, reason: 'Filesystem format' },
  { pattern: /dd\s+if=/i, tier: 3, reason: 'Raw disk write' },
  { pattern: /drop\s+(database|table|schema)/i, tier: 3, reason: 'SQL destructive operation' },

  // Tier 2: dangerous / needs review
  { pattern: /sudo/i, tier: 2, reason: 'Elevated privileges' },
  { pattern: /chmod\s+777/i, tier: 2, reason: 'World-writable permissions' },
  { pattern: /curl.*\|.*sh/i, tier: 2, reason: 'Remote code execution via curl pipe' },
  { pattern: /wget.*\|.*sh/i, tier: 2, reason: 'Remote code execution via wget pipe' },
  { pattern: /kubectl\s+delete/i, tier: 2, reason: 'Kubernetes resource deletion' },
  { pattern: /docker\s+system\s+prune/i, tier: 2, reason: 'Docker system prune' },
  { pattern: /docker\s+volume\s+prune/i, tier: 2, reason: 'Docker volume prune' },
  { pattern: /git\s+push\s+--force/i, tier: 2, reason: 'Force push to remote' },
  { pattern: /git\s+push\s+-f\b/i, tier: 2, reason: 'Force push to remote' },

  // Tier 1: mildly risky (informational only, no approval needed by default)
  { pattern: /git\s+reset/i, tier: 1, reason: 'Git reset' },
  { pattern: /npm\s+publish/i, tier: 1, reason: 'Package publish' },
  { pattern: /docker\s+rm/i, tier: 1, reason: 'Docker container removal' },
];

/**
 * Classify the risk tier of a shell command.
 * Returns the highest-tier match found.
 */
export function classifyCommandRisk(command: string): RiskClassification {
  let highest: RiskClassification = { tier: 0, reason: 'No dangerous patterns detected' };

  for (const entry of DANGEROUS_PATTERNS) {
    if (entry.pattern.test(command) && entry.tier > highest.tier) {
      highest = { tier: entry.tier as RiskTier, reason: entry.reason };
    }
  }

  return highest;
}

// --- Exec Approval Config ---

export interface ExecApprovalConfig {
  enabled?: boolean;       // default true
  ttlMs?: number;          // default 5 minutes
  requireForTiers?: number[]; // default [2, 3]
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_REQUIRE_FOR_TIERS = [2, 3];

// --- Pending Approval Registry (in-memory MVP) ---

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PendingApproval {
  id: string;
  command: string;
  cwd?: string;
  tier: RiskTier;
  reason: string;
  createdAt: Date;
  expiresAt: Date;
  status: ApprovalStatus;
  approvedBy?: string;
  deniedBy?: string;
  resolvedAt?: Date;
  /** Channel context metadata — where the request originated */
  channelMeta?: ApprovalChannelMeta;
}

/** Metadata about the channel/chat where an approval request originated */
export interface ApprovalChannelMeta {
  channel: 'telegram' | 'discord' | 'dashboard' | string;
  chatId?: number | string;
  userId?: string;
  username?: string;
}

// --- Approval Lifecycle Events ---

export type ApprovalEventType = 'created' | 'approved' | 'denied' | 'expired';

export interface ApprovalEvent {
  type: ApprovalEventType;
  approval: PendingApproval;
}

const approvalEmitter = new EventEmitter();

/** Subscribe to approval lifecycle events. Returns unsubscribe function. */
export function onApprovalEvent(
  type: ApprovalEventType,
  listener: (event: ApprovalEvent) => void
): () => void {
  approvalEmitter.on(type, listener);
  return () => approvalEmitter.off(type, listener);
}

/** Subscribe to all approval events. Returns unsubscribe function. */
export function onAnyApprovalEvent(
  listener: (event: ApprovalEvent) => void
): () => void {
  const handler = (event: ApprovalEvent) => listener(event);
  approvalEmitter.on('created', handler);
  approvalEmitter.on('approved', handler);
  approvalEmitter.on('denied', handler);
  approvalEmitter.on('expired', handler);
  return () => {
    approvalEmitter.off('created', handler);
    approvalEmitter.off('approved', handler);
    approvalEmitter.off('denied', handler);
    approvalEmitter.off('expired', handler);
  };
}

function emitEvent(type: ApprovalEventType, approval: PendingApproval): void {
  approvalEmitter.emit(type, { type, approval });
}

// In-memory store
const approvals = new Map<string, PendingApproval>();

/**
 * Check if a command requires approval based on its risk tier and config.
 */
export function requiresApproval(
  classification: RiskClassification,
  config?: ExecApprovalConfig,
): boolean {
  if (config?.enabled === false) return false;
  const tiers = config?.requireForTiers ?? DEFAULT_REQUIRE_FOR_TIERS;
  return tiers.includes(classification.tier);
}

/**
 * Create a pending approval request. Returns the PendingApproval object.
 */
export function createApprovalRequest(
  command: string,
  cwd: string | undefined,
  classification: RiskClassification,
  config?: ExecApprovalConfig,
  channelMeta?: ApprovalChannelMeta,
): PendingApproval {
  cleanupExpired();

  const ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
  const now = new Date();

  const approval: PendingApproval = {
    id: randomUUID().slice(0, 8), // short ID for usability
    command,
    cwd,
    tier: classification.tier,
    reason: classification.reason,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
    status: 'pending',
    channelMeta,
  };

  approvals.set(approval.id, approval);
  emitEvent('created', approval);
  return approval;
}

/**
 * List pending approvals, optionally including recently resolved ones.
 */
export function listApprovals(options?: { includeResolved?: boolean; limit?: number }): PendingApproval[] {
  cleanupExpired();

  const all = Array.from(approvals.values());

  let filtered: PendingApproval[];
  if (options?.includeResolved) {
    filtered = all;
  } else {
    filtered = all.filter(a => a.status === 'pending');
  }

  // Sort newest first
  filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  if (options?.limit) {
    return filtered.slice(0, options.limit);
  }
  return filtered;
}

/**
 * Get a single approval by ID.
 */
export function getApproval(id: string): PendingApproval | undefined {
  cleanupExpired();
  return approvals.get(id);
}

/**
 * Approve a pending request. Returns true if successful.
 */
export function approveRequest(id: string, approvedBy?: string): boolean {
  cleanupExpired();
  const approval = approvals.get(id);
  if (!approval || approval.status !== 'pending') return false;

  approval.status = 'approved';
  approval.approvedBy = approvedBy;
  approval.resolvedAt = new Date();
  emitEvent('approved', approval);
  return true;
}

/**
 * Deny a pending request. Returns true if successful.
 */
export function denyRequest(id: string, deniedBy?: string): boolean {
  cleanupExpired();
  const approval = approvals.get(id);
  if (!approval || approval.status !== 'pending') return false;

  approval.status = 'denied';
  approval.deniedBy = deniedBy;
  approval.resolvedAt = new Date();
  emitEvent('denied', approval);
  return true;
}

/**
 * Find an approved request matching the exact command and cwd.
 * Returns the approval if found, undefined otherwise.
 */
export function findApprovedRequest(command: string, cwd?: string): PendingApproval | undefined {
  cleanupExpired();
  for (const approval of approvals.values()) {
    if (
      approval.status === 'approved' &&
      approval.command === command &&
      (approval.cwd ?? undefined) === (cwd ?? undefined)
    ) {
      return approval;
    }
  }
  return undefined;
}

/**
 * Mark an approved request as consumed (after successful execution).
 */
export function consumeApproval(id: string): void {
  approvals.delete(id);
}

/**
 * Expire pending approvals past their TTL.
 */
export function cleanupExpired(): void {
  const now = Date.now();
  for (const [id, approval] of approvals) {
    if (approval.status === 'pending' && approval.expiresAt.getTime() <= now) {
      approval.status = 'expired';
      approval.resolvedAt = new Date(now);
      emitEvent('expired', approval);
    }
  }
}

/**
 * Wait for a pending approval to be resolved (approved, denied, or expired).
 * Resolves with the final PendingApproval object.
 * Falls back to returning the stored approval (or an expired stub) after timeoutMs.
 */
export function waitForApproval(id: string, timeoutMs: number): Promise<PendingApproval> {
  return new Promise((resolve) => {
    // Check if already resolved before we start waiting
    const existing = approvals.get(id);
    if (existing && existing.status !== 'pending') {
      resolve(existing);
      return;
    }

    let settled = false;

    const cleanup = onAnyApprovalEvent((event) => {
      if (event.approval.id !== id) return;
      if (event.type === 'created') return; // ignore created events
      if (settled) return;
      settled = true;
      cleanup();
      resolve(event.approval);
    });

    // Fallback timeout — resolve with whatever state we have
    setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const stored = approvals.get(id);
      if (stored) {
        resolve(stored);
      } else {
        // Synthesize expired stub if it was already cleaned up
        resolve({
          id,
          command: '',
          tier: 0,
          reason: '',
          createdAt: new Date(),
          expiresAt: new Date(),
          status: 'expired',
        });
      }
    }, timeoutMs);
  });
}

/**
 * Clear all approvals (for testing).
 */
export function clearApprovals(): void {
  approvals.clear();
}

/**
 * Remove all event listeners (for testing).
 */
export function clearApprovalListeners(): void {
  approvalEmitter.removeAllListeners();
}
