import type { Agent, AgentRun, Mission, MissionTask, RunUsage, TaskAttempt } from './types.js';

export const MAX_ATTEMPTS_PER_TASK = 3;
export const isTerminalMissionStatus = (status: Mission['status']): boolean => status === 'completed' || status === 'failed' || status === 'cancelled';

export function findReservingMission(missions: readonly Mission[], agentId: string): Mission | undefined {
  return missions.find((mission) => !isTerminalMissionStatus(mission.status) && mission.participants.some((participant) => participant.agentId === agentId));
}

export function isAuthoritativeAttempt(task: MissionTask, attempt: TaskAttempt): boolean {
  return task.authoritativeAttemptId === attempt.id && task.authorityVersion === attempt.authorityVersion;
}

/**
 * Startup reconciliation clears the task's authoritative pointer and advances
 * its version so the interrupted run cannot be accepted. The interrupted
 * attempt and its input checkpoint remain the durable recovery evidence.
 */
export function isStartupInterruptedDesignAttempt(task: MissionTask, attempt: TaskAttempt): boolean {
  return task.authoritativeAttemptId === null && task.status === 'interrupted' && attempt.status === 'interrupted' && attempt.stage === 'design' && attempt.supersededAt !== null && task.authorityVersion === attempt.authorityVersion + 1;
}

export type AdmissionRejection = 'workspace_not_ready' | 'mission_not_running' | 'task_not_current' | 'agent_not_assigned' | 'inputs_stale' | 'agent_not_reserved' | 'agent_not_ready' | 'authoritative_attempt_missing' | 'authoritative_run_missing' | 'task_not_pending' | 'recovery_limit_reached' | 'budget_exhausted';
export interface MissionAdmissionInput {
  missions: readonly Mission[]; mission: Mission; task: MissionTask; agent: Agent; inputArtifactIds: readonly string[]; missionArtifactIds: readonly string[]; attempts: readonly TaskAttempt[]; authoritativeAttempt: TaskAttempt | null; authoritativeRun: AgentRun | null; run: AgentRun; attemptId: string; timestamp: string; startedByRecoveryCommandId?: string | null; tokenBudget?: number | null; measuredUsage?: { totalTokens: number };
}
export type MissionAdmission = { kind: 'rejected'; reason: AdmissionRejection } | { kind: 'existing'; mission: Mission; task: MissionTask; attempt: TaskAttempt; run: AgentRun; agent: Agent } | { kind: 'admitted'; mission: Mission; task: MissionTask; agent: Agent; attempt: TaskAttempt; run: AgentRun };

export function startMissionAttempt(input: MissionAdmissionInput): MissionAdmission {
  const { mission, task, agent } = input;
  if (mission.workspace.state !== 'ready') return { kind: 'rejected', reason: 'workspace_not_ready' };
  const recoveryStart = input.startedByRecoveryCommandId !== undefined && input.startedByRecoveryCommandId !== null;
  const explicitDesignResume = task.stage === 'design' && mission.workflow.phase === 'designing' && ['paused', 'recovered_paused'].includes(mission.status);
  const explicitImplementationStart = task.stage === 'implement' && mission.workflow.phase === 'implementing' && ['paused', 'recovered_paused'].includes(mission.status);
  const explicitRepairStart = task.stage === 'repair' && mission.workflow.phase === 'repairing' && ['paused', 'recovered_paused'].includes(mission.status);
  if (mission.status !== 'pending' && mission.status !== 'running' && !explicitDesignResume && !explicitImplementationStart && !explicitRepairStart && !(recoveryStart && ['paused', 'recovered_paused'].includes(mission.status))) return { kind: 'rejected', reason: 'mission_not_running' };
  if (mission.currentTaskId !== task.id) return { kind: 'rejected', reason: 'task_not_current' };
  if (task.assignedAgentId !== agent.id) return { kind: 'rejected', reason: 'agent_not_assigned' };
  const sameInputs = input.inputArtifactIds.length === task.inputArtifactIds.length && input.inputArtifactIds.every((id, index) => id === task.inputArtifactIds[index]);
  const artifactIds = new Set(input.missionArtifactIds);
  if (!sameInputs || input.inputArtifactIds.some((id) => !artifactIds.has(id))) return { kind: 'rejected', reason: 'inputs_stale' };
  const reservingMission = findReservingMission(input.missions, agent.id);
  if (!reservingMission || reservingMission.id !== mission.id) return { kind: 'rejected', reason: 'agent_not_reserved' };
  if (task.authoritativeAttemptId) {
    const attempt = input.authoritativeAttempt;
    if (!attempt || attempt.missionId !== mission.id || attempt.taskId !== task.id || attempt.agentId !== agent.id || attempt.authorityVersion !== task.authorityVersion) return { kind: 'rejected', reason: 'authoritative_attempt_missing' };
    const run = input.authoritativeRun;
    if (!run || run.agentId !== attempt.agentId || run.context.kind !== 'mission' || run.context.missionId !== mission.id || run.context.taskId !== task.id || run.context.attemptId !== attempt.id) return { kind: 'rejected', reason: 'authoritative_run_missing' };
    return { kind: 'existing', mission: structuredClone(mission), task: structuredClone(task), attempt: structuredClone(attempt), run: structuredClone(run), agent: structuredClone(agent) };
  }
  if (input.attempts.filter((candidate) => candidate.taskId === task.id).length >= MAX_ATTEMPTS_PER_TASK) return { kind: 'rejected', reason: 'recovery_limit_reached' };
  if (input.tokenBudget !== null && input.tokenBudget !== undefined && (input.measuredUsage?.totalTokens ?? 0) >= input.tokenBudget) return { kind: 'rejected', reason: 'budget_exhausted' };
  if (agent.status !== 'ready') return { kind: 'rejected', reason: 'agent_not_ready' };
  if (task.status !== 'pending') return { kind: 'rejected', reason: 'task_not_pending' };
  const nextMission = structuredClone(mission); const nextTask = structuredClone(task); const nextAgent = structuredClone(agent); const nextRun = structuredClone(input.run);
  const attempt: TaskAttempt = { id: input.attemptId, missionId: mission.id, taskId: task.id, agentId: agent.id, attemptNumber: input.attempts.filter((candidate) => candidate.taskId === task.id).length + 1, authorityVersion: task.authorityVersion + 1, stage: task.stage, inputDesignRevisionId: task.inputDesignRevisionId, inputVerificationRunId: task.inputVerificationRunId, inputWorkspaceRevisionId: task.inputWorkspaceRevisionId, repairCycle: task.repairCycle, status: 'running', runId: input.run.id, runtimeThreadId: null, inputArtifactIds: [...input.inputArtifactIds], outputArtifactId: null, outputWorkspaceRevisionId: null, usage: null, error: null, supersededAt: null, supersededByAttemptId: null, startedByRecoveryCommandId: input.startedByRecoveryCommandId ?? null, createdAt: input.timestamp, startedAt: input.timestamp, completedAt: null, updatedAt: input.timestamp };
  nextRun.context = { kind: 'mission', missionId: mission.id, taskId: task.id, attemptId: attempt.id };
  nextRun.startedAt = input.timestamp; nextTask.authoritativeAttemptId = attempt.id; nextTask.authorityVersion = attempt.authorityVersion; nextTask.status = 'running'; nextTask.startedAt ??= input.timestamp; nextTask.updatedAt = input.timestamp; nextMission.status = 'running'; nextMission.startedAt ??= input.timestamp; nextMission.updatedAt = input.timestamp; nextAgent.status = 'busy'; nextAgent.lastError = null; nextAgent.updatedAt = input.timestamp;
  return { kind: 'admitted', mission: nextMission, task: nextTask, agent: nextAgent, attempt, run: nextRun };
}

export type ResultRejection = 'attempt_not_running' | 'attempt_not_authoritative' | 'run_mismatch' | 'run_not_terminal';
export interface MissionResultFacts { mission?: Mission; currentArtifactIds?: readonly string[]; }
export type MissionResultDecision = { accepted: true } | { accepted: false; reason: ResultRejection };
export function acceptMissionResult(task: MissionTask, attempt: TaskAttempt, run: AgentRun, facts: MissionResultFacts = {}): MissionResultDecision {
  if (attempt.missionId !== task.missionId || attempt.taskId !== task.id || attempt.agentId !== task.assignedAgentId || attempt.stage !== task.stage || attempt.inputDesignRevisionId !== task.inputDesignRevisionId || attempt.inputVerificationRunId !== task.inputVerificationRunId || attempt.inputWorkspaceRevisionId !== task.inputWorkspaceRevisionId || attempt.repairCycle !== task.repairCycle) return { accepted: false, reason: 'attempt_not_authoritative' };
  if (attempt.status !== 'running') return { accepted: false, reason: 'attempt_not_running' };
  if (!isAuthoritativeAttempt(task, attempt)) return { accepted: false, reason: 'attempt_not_authoritative' };
  if (attempt.runId !== run.id || run.agentId !== attempt.agentId || run.context.kind !== 'mission' || run.context.taskId !== task.id || run.context.attemptId !== attempt.id || run.context.missionId !== task.missionId) return { accepted: false, reason: 'run_mismatch' };
  if (!['completed', 'failed', 'cancelled'].includes(run.status)) return { accepted: false, reason: 'run_not_terminal' };
  if (facts.mission && (facts.mission.id !== task.missionId || facts.mission.workspace.currentRevisionId !== attempt.inputWorkspaceRevisionId)) return { accepted: false, reason: 'attempt_not_authoritative' };
  if (facts.mission && attempt.stage === 'implement' && facts.mission.workflow.approvedDesignRevisionId !== attempt.inputDesignRevisionId) return { accepted: false, reason: 'attempt_not_authoritative' };
  if (facts.mission && attempt.stage === 'repair' && (facts.mission.workflow.approvedDesignRevisionId !== attempt.inputDesignRevisionId || facts.mission.workflow.currentVerificationRunId !== attempt.inputVerificationRunId || facts.mission.workflow.repairCycle !== attempt.repairCycle)) return { accepted: false, reason: 'attempt_not_authoritative' };
  if (facts.currentArtifactIds && (facts.currentArtifactIds.length !== attempt.inputArtifactIds.length || facts.currentArtifactIds.some((id, index) => id !== attempt.inputArtifactIds[index]))) return { accepted: false, reason: 'attempt_not_authoritative' };
  return { accepted: true };
}

export function failMissionTask(input: { mission: Mission; task: MissionTask; attempt: TaskAttempt; threadId: string | null; usage: RunUsage | null; error: TaskAttempt['error']; timestamp: string }): { mission: Mission; task: MissionTask; attempt: TaskAttempt } {
  const mission = structuredClone(input.mission); const task = structuredClone(input.task); const attempt = structuredClone(input.attempt); const cancelled = input.error?.category === 'cancelled';
  attempt.status = cancelled ? 'cancelled' : 'failed'; attempt.runtimeThreadId = input.threadId; attempt.usage = input.usage; attempt.error = input.error; attempt.completedAt = input.timestamp; attempt.updatedAt = input.timestamp; task.status = 'failed'; task.updatedAt = input.timestamp; mission.status = 'paused'; mission.updatedAt = input.timestamp; return { mission, task, attempt };
}

export type MissionTaskRetryDecision =
  | { accepted: true; mission: Mission; task: MissionTask; attempt: TaskAttempt }
  | { accepted: false; reason: 'identity_mismatch' | 'wrong_stage' | 'attempt_not_authoritative' | 'attempt_not_recoverable' | 'attempt_running' };

export function prepareMissionTaskRetry(input: { mission: Mission; task: MissionTask; attempt: TaskAttempt; timestamp: string }): MissionTaskRetryDecision {
  const { mission, task, attempt } = input;
  if (task.missionId !== mission.id || attempt.missionId !== mission.id || attempt.taskId !== task.id || attempt.agentId !== task.assignedAgentId || mission.currentTaskId !== task.id) return { accepted: false, reason: 'identity_mismatch' };
  if (mission.workflow.phase !== 'designing' || task.stage !== 'design' || attempt.stage !== 'design') return { accepted: false, reason: 'wrong_stage' };
  if (attempt.status === 'running' || task.status === 'running') return { accepted: false, reason: 'attempt_running' };
  if (!isAuthoritativeAttempt(task, attempt) && !isStartupInterruptedDesignAttempt(task, attempt)) return { accepted: false, reason: 'attempt_not_authoritative' };
  if (!['failed', 'cancelled', 'interrupted'].includes(attempt.status) || !['failed', 'interrupted'].includes(task.status)) return { accepted: false, reason: 'attempt_not_recoverable' };
  const nextMission = structuredClone(mission);
  const nextTask = structuredClone(task);
  const previousAttempt = structuredClone(attempt);
  previousAttempt.supersededAt = input.timestamp;
  previousAttempt.updatedAt = input.timestamp;
  nextTask.authoritativeAttemptId = null;
  nextTask.status = 'pending';
  nextTask.updatedAt = input.timestamp;
  nextMission.status = mission.status === 'recovered_paused' ? 'recovered_paused' : 'paused';
  nextMission.updatedAt = input.timestamp;
  return { accepted: true, mission: nextMission, task: nextTask, attempt: previousAttempt };
}

export function interruptMissionAttempt(input: { mission: Mission; task: MissionTask | null; attempt: TaskAttempt; run: AgentRun; timestamp: string }): { mission: Mission; task: MissionTask | null; attempt: TaskAttempt; run: AgentRun } {
  const mission = structuredClone(input.mission); const task = input.task ? structuredClone(input.task) : null; const attempt = structuredClone(input.attempt); const run = structuredClone(input.run);
  if (run.status === 'queued' || run.status === 'running') { run.status = 'cancelled'; run.error = 'Server restarted while this run was active'; run.completedAt = input.timestamp; }
  attempt.status = 'interrupted'; attempt.error = { category: 'interrupted', message: 'Server restarted while this attempt was active' }; attempt.completedAt = input.timestamp; attempt.updatedAt = input.timestamp; attempt.supersededAt = input.timestamp;
  if (task) { task.status = 'interrupted'; task.authoritativeAttemptId = null; task.authorityVersion += 1; task.updatedAt = input.timestamp; }
  if (!isTerminalMissionStatus(mission.status)) { mission.status = 'recovered_paused'; mission.updatedAt = input.timestamp; }
  return { mission, task, attempt, run };
}

export function stopMission(input: { mission: Mission; tasks: readonly MissionTask[]; timestamp: string }): { mission: Mission; tasks: MissionTask[] } {
  const mission = structuredClone(input.mission); const tasks = input.tasks.map((task) => { const next = structuredClone(task); if (next.status !== 'completed') { next.status = 'cancelled'; next.authoritativeAttemptId = null; next.authorityVersion += 1; } next.updatedAt = input.timestamp; return next; });
  mission.status = 'cancelled'; mission.currentTaskId = null; mission.completedAt = input.timestamp; mission.updatedAt = input.timestamp; return { mission, tasks };
}
