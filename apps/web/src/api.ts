import type { Agent, AgentRun, Message, Mission, MissionAgentAvailability, MissionDetail, MissionSummary, SystemInfo, DesignReference, MissionRecoveryCommand, PlaygroundImpactAdmission } from "./types";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string | null = null, public readonly details: Readonly<Record<string, string | number | boolean | null>> | null = null) {
    super(message);
    this.name = "ApiError";
  }
  get reason(): string | null { return typeof this.details?.reason === "string" ? this.details.reason : null; }
}

const MAX_ERROR_MESSAGE_LENGTH = 1_024;
const MAX_ERROR_CODE_LENGTH = 96;
const MAX_ERROR_DETAIL_LENGTH = 256;
const MAX_ERROR_DETAILS = 16;

function bounded(value: string, limit: number): string { return value.length <= limit ? value : value.slice(0, limit) + "…"; }

export function parseApiError(payload: unknown, status: number): ApiError {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const message = typeof source.error === "string" ? bounded(source.error, MAX_ERROR_MESSAGE_LENGTH) : "Request failed";
  const code = typeof source.code === "string" && /^[A-Z0-9_]+$/.test(source.code) ? bounded(source.code, MAX_ERROR_CODE_LENGTH) : null;
  const details: Record<string, string | number | boolean | null> = {};
  const candidates = source.details && typeof source.details === "object" && !Array.isArray(source.details) ? { ...(source.details as Record<string, unknown>), ...source } : source;
  for (const [key, value] of Object.entries(candidates)) {
    if (key === "error" || key === "code" || key === "details" || Object.keys(details).length >= MAX_ERROR_DETAILS) continue;
    if (value === null || typeof value === "number" || typeof value === "boolean") details[key] = value;
    else if (typeof value === "string") details[key] = bounded(value, MAX_ERROR_DETAIL_LENGTH);
  }
  return new ApiError(message, status, code, Object.keys(details).length ? details : null);
}

let authToken = "";
export function setAuthToken(token: string): void { authToken = token.trim(); }

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = { ...(options?.body ? { "Content-Type": "application/json" } : {}), ...(authToken ? { Authorization: "Bearer " + authToken } : {}), ...options?.headers };
  const response = await fetch(url, { ...options, headers });
  const data = (await response.json().catch(() => ({}))) as T;
  if (!response.ok) throw parseApiError(data, response.status);
  return data;
}
async function requestBlob(url: string): Promise<Blob> { const response = await fetch(url, { headers: authToken ? { Authorization: "Bearer " + authToken } : {} }); if (!response.ok) throw new ApiError("Evidence unavailable", response.status); return response.blob(); }

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: { name: string; description: string; instructions: string }) => request<{ agent: Agent }>("/api/agents", { method: "POST", body: JSON.stringify(body) }),
  updateAgent: (id: string, body: { name: string; description: string; instructions: string }) => request<{ agent: Agent }>("/api/agents/" + id, { method: "PATCH", body: JSON.stringify(body) }),
  deleteAgent: (id: string) => request<{ archivedWorkspace: string }>("/api/agents/" + id, { method: "DELETE" }),
  startAgent: (id: string) => request<{ agent: Agent }>("/api/agents/" + id + "/start", { method: "POST" }),
  stopAgent: (id: string) => request<{ agent: Agent }>("/api/agents/" + id + "/stop", { method: "POST" }),
  messages: (id: string) => request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) => request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string, requestId: string) => request<{ admission: PlaygroundImpactAdmission; message: Message }>("/api/agents/" + id + "/messages", { method: "POST", body: JSON.stringify({ content, requestId }) }),
  impactAdmissions: (id: string) => request<{ admissions: PlaygroundImpactAdmission[] }>(`/api/agents/${id}/impact-admissions`),
  createAgentPreview: (id: string) => request<{ session: { id: string; agentId: string; workspaceHash: string; profile: string; contentPath: string; expiresAt: string; previewDataHash: string | null } }>(`/api/agents/${id}/previews`, { method: "POST", body: "{}" }),
  stopAgentPreview: (id: string, sessionId: string) => request<void>(`/api/agents/${id}/previews/${sessionId}`, { method: "DELETE" }),
  confirmImpact: (id: string, admissionId: string, choice: "governed" | "nonvisual") => request<{ admission: PlaygroundImpactAdmission }>(`/api/agents/${id}/impact-admissions/${admissionId}/confirm`, { method: "POST", body: JSON.stringify({ choice }) }),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  listMissions: () => request<{ missions: Mission[]; summaries: MissionSummary[]; agentAvailability: MissionAgentAvailability[] }>("/api/missions"),
  getMission: (id: string) => request<MissionDetail>("/api/missions/" + id),
  missionEvidence: (missionId: string, artifactId: string) => requestBlob(`/api/missions/${missionId}/evidence/${artifactId}`),
  createPreview: (missionId: string, body: { kind: "design"; revisionId: string } | { kind: "workspace"; revisionId: string; designRevisionId: string }) => request<{ session: { id: string; missionId: string; target: { kind: "design"; revisionId: string } | { kind: "workspace"; revisionId: string; designRevisionId: string }; profile: string; contentPath: string; expiresAt: string; previewDataHash: string | null } }>(`/api/missions/${missionId}/previews`, { method: "POST", body: JSON.stringify(body) }),
  stopPreview: (missionId: string, sessionId: string) => request<void>(`/api/missions/${missionId}/previews/${sessionId}`, { method: "DELETE" }),
  createMission: (body: { goal: string; sourceAgentId: string; designerAgentId: string; builderAgentId: string; tokenBudget?: number | null }) => request<{ mission: Mission }>("/api/missions", { method: "POST", body: JSON.stringify(body) }),
  startMission: (id: string) => request<MissionDetail>("/api/missions/" + id + "/start", { method: "POST", body: "{}" }),
  verifyMission: (id: string) => request<MissionDetail>("/api/missions/" + id + "/verify", { method: "POST", body: "{}" }),
  retryWorkspacePublication: (id: string) => request<MissionDetail>(`/api/missions/${id}/workspace-publication/retry`, { method: "POST", body: "{}" }),
  reviewImplementation: (id: string, body: { decision: "accept" } | { decision: "request_changes"; feedback: string }) => request<MissionDetail>("/api/missions/" + id + "/implementation-review", { method: "POST", body: JSON.stringify(body) }),
  submitDesignFeedback: (missionId: string, revisionId: string, feedback: string) => request<MissionDetail>(`/api/missions/${missionId}/design-revisions/${revisionId}/feedback`, { method: "POST", body: JSON.stringify({ feedback }) }),
  approveDesignRevision: (missionId: string, revisionId: string, reviewedSurfaceIds: string[]) => request<MissionDetail>(`/api/missions/${missionId}/design-revisions/${revisionId}/approve`, { method: "POST", body: JSON.stringify({ reviewedSurfaceIds }) }),
  designReference: (missionId: string, revisionId: string) => request<DesignReference>(`/api/missions/${missionId}/design-revisions/${revisionId}/reference`),
  recoverMission: (id: string, body: { requestId: string; action: "resume" | "retry_current"; taskId: string } | { requestId: string; action: "stop_preserve" }) => request<{ command: MissionRecoveryCommand; detail: MissionDetail }>("/api/missions/" + id + "/recovery", { method: "POST", body: JSON.stringify(body) }),
};
