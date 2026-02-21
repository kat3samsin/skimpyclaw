// Typed API client for SkimpyClaw dashboard
// All requests go to /api/dashboard/* with Bearer token auth

import type {
  AuditResponse,
  Approval,
  CodeAgentsResponse,
  ConversationMessage,
  ConversationSummary,
  ConfigResponse,
  DigestsResponse,
  DigestResponse,
  DoctorResponse,
  HealthResponse,
  LogListResponse,
  MemoryResponse,
  MemoryFileResponse,
  ModelResponse,
  SkillsResponse,
  SkillResponse,
  StatusResponse,
  TemplateListResponse,
  Template,
} from '../types.js';

const TOKEN_KEY = 'dashboard_token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api/dashboard/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, text);
  }

  return res.json() as Promise<T>;
}

// ── Status / Health ──────────────────────────────────────────────────

export const getStatus = () => request<StatusResponse>('status');
export const getHealth = () => request<HealthResponse>('health');
export const getDoctor = () => request<DoctorResponse>('doctor');

// ── Audit ────────────────────────────────────────────────────────────

export interface AuditQueryParams {
  limit?: number;
  offset?: number;
  trigger?: string;
}

export function getAudit(params: AuditQueryParams = {}): Promise<AuditResponse> {
  const q = new URLSearchParams();
  if (params.limit !== undefined) q.set('limit', String(params.limit));
  if (params.offset !== undefined) q.set('offset', String(params.offset));
  if (params.trigger) q.set('trigger', params.trigger);
  const qs = q.toString();
  return request<AuditResponse>(`audit${qs ? `?${qs}` : ''}`);
}

// ── Approvals ────────────────────────────────────────────────────────

export const getApprovals = () => request<{ approvals: Approval[] }>('approvals');
export const approveCommand = (id: string) =>
  request<{ approved: boolean }>(`approvals/${encodeURIComponent(id)}/approve`, { method: 'POST' });
export const denyCommand = (id: string) =>
  request<{ denied: boolean }>(`approvals/${encodeURIComponent(id)}/deny`, { method: 'POST' });

// ── Cron ─────────────────────────────────────────────────────────────

export const getCronJobs = () => request<{ jobs: import('../types.js').CronJob[] }>('cron');
export const triggerCronJob = (id: string) =>
  request<{ status: string; id: string }>(`cron/${encodeURIComponent(id)}/run`, { method: 'POST' });

// ── Model ────────────────────────────────────────────────────────────

export const getModel = () => request<ModelResponse>('model');
export const setModel = (model: string) =>
  request<ModelResponse>('model', {
    method: 'POST',
    body: JSON.stringify({ model }),
  });

// ── Memory ───────────────────────────────────────────────────────────

export const getMemory = (agentId: string) =>
  request<MemoryResponse>(`memory/${encodeURIComponent(agentId)}`);
export const getMemoryFile = (agentId: string, filename: string) =>
  request<MemoryFileResponse>(
    `memory/${encodeURIComponent(agentId)}/${encodeURIComponent(filename)}`,
  );

// ── Templates ────────────────────────────────────────────────────────

export const getTemplates = (agentId: string) =>
  request<TemplateListResponse>(`templates/${encodeURIComponent(agentId)}`);
export const getTemplate = (agentId: string, name: string) =>
  request<Template>(`templates/${encodeURIComponent(agentId)}/${encodeURIComponent(name)}`);
export const saveTemplate = (agentId: string, name: string, content: string) =>
  request<{ saved: boolean }>(
    `templates/${encodeURIComponent(agentId)}/${encodeURIComponent(name)}`,
    { method: 'PUT', body: JSON.stringify({ content }) },
  );

// ── Logs ─────────────────────────────────────────────────────────────

export const getLogFiles = () => request<LogListResponse>('logs');
export const getLogContent = (path: string) => request<{ content: string }>(path);

// ── Code Agents ──────────────────────────────────────────────────────

export const getCodeAgents = () => request<CodeAgentsResponse>('code-agents');

// ── Messages ────────────────────────────────────────────────────────

export const sendDashboardMessage = (message: string) =>
  request<{ sent: boolean; channel?: string; timestamp?: string }>('messages/send', {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
export const sendMessageToAgent = (message: string, model?: string) =>
  request<{ ok: boolean; response: string; timestamp?: string }>('messages/agent', {
    method: 'POST',
    body: JSON.stringify({ message, model }),
  });
export const getConversations = (channel?: 'telegram' | 'discord') => {
  const q = channel ? `?channel=${encodeURIComponent(channel)}` : '';
  return request<{ conversations: ConversationSummary[] }>(`conversations${q}`);
};
export const getConversation = (id: string) =>
  request<{ id: string; messages: ConversationMessage[] }>(`conversations/${encodeURIComponent(id)}`);

// ── Config ───────────────────────────────────────────────────────────

export const getConfig = () => request<ConfigResponse>('config');
export const saveConfig = (config: Record<string, unknown>) =>
  request<{ saved: boolean }>('config', {
    method: 'PUT',
    body: JSON.stringify({ config }),
  });

// ── Digests ──────────────────────────────────────────────────────────

export const getDigests = () => request<DigestsResponse>('digests');
export const getDigest = (id: string) =>
  request<DigestResponse>(`digests/${encodeURIComponent(id)}`);

// ── Skills ───────────────────────────────────────────────────────────

export const getSkills = () => request<SkillsResponse>('skills');
export const getSkill = (name: string) =>
  request<SkillResponse>(`skills/${encodeURIComponent(name)}`);
export const createSkill = (name: string, content: string) =>
  request<{ created: boolean }>('skills', {
    method: 'POST',
    body: JSON.stringify({ name, content }),
  });
export const setSkillEnabled = (name: string, enabled: boolean) =>
  request<{ updated: boolean }>(`skills/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });
export const updateSkillContent = (name: string, content: string) =>
  request<{ updated: boolean; contentUpdated?: boolean }>(`skills/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
export const deleteSkill = (name: string) =>
  request<{ deleted: boolean }>(`skills/${encodeURIComponent(name)}`, { method: 'DELETE' });

export { ApiError };
