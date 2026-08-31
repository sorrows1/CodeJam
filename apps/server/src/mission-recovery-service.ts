import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import { addEvent, safeMissionText } from './mission-evidence.js';
import { summarizeMissionUsage } from './mission-budget.js';
import { MissionExecutionService } from './mission-execution.js';
import { finalizeCompletedImplementation } from './mission-implementation-finalization.js';
import { deriveMissionRecoveryCapabilities } from './mission-recovery-policy.js';
import { interruptMissionAttempt, prepareMissionTaskRetry, stopMission } from './mission-state.js';
import type { DesignReferenceStore } from './design-reference-store.js';
import { JsonStore } from './store.js';
import type { Mission, MissionRecoveryCommand, MissionWorkspaceRevision } from './types.js';
import type { MissionWorkspacePort } from './workspace.js';

const now = () => new Date().toISOString();
export type RecoveryRequest = { requestId: string; action: 'resume' | 'retry_current' | 'rollback_and_retry' | 'intervene_and_retry' | 'stop_preserve' | 'stop_restore'; taskId?: string; revisionId?: string; note?: string };
type Disposition = 'accepted' | 'replayed' | 'coalesced';
const unavailable = () => new HttpError(409, 'Recovery action is not available for this Mission', 'MISSION_STAGE_UNAVAILABLE');

export class MissionRecoveryService {
  constructor(
    private readonly store: JsonStore,
    private readonly workspaces: MissionWorkspacePort,
    private readonly execution: MissionExecutionService,
    private readonly references: DesignReferenceStore,
    private readonly redactionSecrets: readonly string[] = [],
  ) {}

  async apply(missionId: string, request: RecoveryRequest): Promise<{ command: MissionRecoveryCommand; disposition: Disposition }> {
    const payloadHash = createHash('sha256').update(JSON.stringify({ action: request.action, taskId: request.taskId ?? null, revisionId: request.revisionId ?? null, note: request.note ?? null })).digest('hex');
    const journal = await this.store.mutate((database) => {
      const mission = database.missions.find((item) => item.id === missionId); if (!mission) throw new HttpError(404, 'Mission not found');
      const previous = database.missionRecoveryCommands.find((item) => item.id === request.requestId); if (previous) { if (previous.missionId !== missionId || previous.payloadHash !== payloadHash) throw new HttpError(409, 'Recovery request ID was reused with different input'); return { command: structuredClone(previous), disposition: previous.status === 'applying' ? 'coalesced' as const : 'replayed' as const }; }
      const active = database.missionRecoveryCommands.find((item) => item.missionId === missionId && item.status === 'applying'); if (active) { if (active.kind === request.action && active.taskId === (request.taskId ?? null) && active.revisionId === (request.revisionId ?? null) && active.payloadHash === payloadHash) return { command: structuredClone(active), disposition: 'coalesced' as const }; throw new HttpError(409, 'Another recovery command is already applying'); }
      const timestamp = now(); const command: MissionRecoveryCommand = { id: request.requestId, missionId, kind: request.action, taskId: request.taskId ?? null, revisionId: request.revisionId ?? null, payloadHash, status: 'applying', resultAttemptId: null, resultRevisionId: null, error: null, createdAt: timestamp, updatedAt: timestamp, completedAt: null }; database.missionRecoveryCommands.push(command); mission.activeRecoveryCommandId = command.id; mission.updatedAt = timestamp; addEvent(database, mission, 'recovery_command', { taskId: command.taskId }, { action: command.kind, commandId: command.id }); return { command: structuredClone(command), disposition: 'accepted' as const };
    });
    if (journal.disposition !== 'accepted') return journal;
    try {
      const result = await this.perform(missionId, request);
      const completed = await this.store.mutate((database) => { const command = database.missionRecoveryCommands.find((item) => item.id === journal.command.id)!; const mission = database.missions.find((item) => item.id === missionId)!; Object.assign(command, result); command.status = 'completed'; command.updatedAt = now(); command.completedAt = command.updatedAt; mission.activeRecoveryCommandId = null; addEvent(database, mission, 'recovery_completed', { taskId: command.taskId }, { commandId: command.id, action: command.kind }); return structuredClone(command); });
      return { command: completed, disposition: 'accepted' };
    } catch (error) {
      await this.store.mutate((database) => { const command = database.missionRecoveryCommands.find((item) => item.id === journal.command.id); const mission = database.missions.find((item) => item.id === missionId); if (command) { command.status = 'failed'; command.error = safeMissionText(error instanceof Error ? error.message : String(error), 4096).content; command.updatedAt = now(); command.completedAt = command.updatedAt; } if (mission?.activeRecoveryCommandId === journal.command.id) mission.activeRecoveryCommandId = null; });
      throw error;
    }
  }

  private async perform(missionId: string, request: RecoveryRequest): Promise<Pick<MissionRecoveryCommand, 'resultAttemptId' | 'resultRevisionId'>> {
    if (request.action === 'resume') {
      if (!request.taskId) throw unavailable();
      return finalizeCompletedImplementation({ store: this.store, workspaces: this.workspaces, references: this.references, missionId, taskId: request.taskId, recoveryCommandId: request.requestId, redactionSecrets: this.redactionSecrets });
    }
    if (request.action === 'retry_current') return this.retryCurrentDesign(missionId, request);
    if (request.action !== 'stop_preserve' && request.action !== 'stop_restore') throw unavailable();
    const snapshot = this.store.snapshot(); const mission = snapshot.missions.find((item) => item.id === missionId)!;
    if (['completed', 'failed', 'cancelled'].includes(mission.status)) throw new HttpError(409, 'Mission is already terminal');
    if (snapshot.taskAttempts.some((attempt) => attempt.missionId === missionId && attempt.status === 'running' && snapshot.missionTasks.find((task) => task.id === attempt.taskId)?.authoritativeAttemptId === attempt.id)) throw new HttpError(409, 'Mission cannot stop while an authoritative attempt is running');
    if (snapshot.verificationRuns.some((run) => run.missionId === missionId && run.id === mission.workflow.currentVerificationRunId && ['queued', 'running'].includes(run.status))) throw new HttpError(409, 'Mission cannot stop while authoritative verification is running');
    let restoredRevisionId: string | null = null;
    if (request.action === 'stop_restore') {
      const revision = snapshot.missionWorkspaceRevisions.find((item) => item.id === request.revisionId && item.missionId === missionId); if (!revision) throw new HttpError(409, 'Restore target is not an exact Mission checkpoint');
      await this.workspaces.restoreMissionRevision(missionId, revision);
      const created = await this.captureRestoreRevision(mission, revision); await this.store.mutate((database) => { const stored = database.missions.find((item) => item.id === missionId)!; database.missionWorkspaceRevisions.push(created); stored.workspace.currentRevisionId = created.id; stored.workspace.revisionStatus = 'clean'; stored.workspace.nextRevisionSequence = created.sequence + 1; stored.updatedAt = now(); addEvent(database, stored, 'revision_restored', {}, { revisionId: created.id, restoredFromRevisionId: revision.id }); }); restoredRevisionId = created.id;
    }
    await this.store.mutate((database) => { const stored = database.missions.find((item) => item.id === missionId)!; const tasks = database.missionTasks.filter((item) => item.missionId === missionId); const result = stopMission({ mission: stored, tasks, timestamp: now() }); Object.assign(stored, result.mission); for (const task of result.tasks) Object.assign(database.missionTasks.find((item) => item.id === task.id)!, task); addEvent(database, stored, 'participants_released', {}); });
    return { resultAttemptId: null, resultRevisionId: restoredRevisionId };
  }

  private async retryCurrentDesign(missionId: string, request: RecoveryRequest): Promise<Pick<MissionRecoveryCommand, 'resultAttemptId' | 'resultRevisionId'>> {
    const snapshot = this.store.snapshot();
    const mission = snapshot.missions.find((item) => item.id === missionId);
    if (!mission) throw new HttpError(404, 'Mission not found');
    const task = snapshot.missionTasks.find((item) => item.id === mission.currentTaskId && item.missionId === missionId) ?? null;
    if (!task || request.taskId !== task.id) throw new HttpError(409, 'Recovery request does not identify the current Design task', 'MISSION_STAGE_UNAVAILABLE');
    const baseline = task.inputWorkspaceRevisionId ? snapshot.missionWorkspaceRevisions.find((item) => item.id === task.inputWorkspaceRevisionId && item.missionId === missionId) ?? null : null;
    const inspection = baseline ? await this.workspaces.inspectMissionWorkspace(missionId, baseline.contentHash, false) : { state: 'unavailable' as const };
    const activeCommand = snapshot.missionRecoveryCommands.find((item) => item.id === mission.activeRecoveryCommandId) ?? null;
    const currentVerification = mission.workflow.currentVerificationRunId ? snapshot.verificationRuns.find((item) => item.id === mission.workflow.currentVerificationRunId) ?? null : null;
    const capabilities = deriveMissionRecoveryCapabilities({ missions: snapshot.missions, mission, currentTask: task, attempts: snapshot.taskAttempts.filter((item) => item.missionId === missionId), runs: snapshot.runs.filter((item) => item.context.kind === 'mission' && item.context.missionId === missionId), currentVerification, workspaceRevision: baseline, workspaceState: inspection.state, assignedAgent: snapshot.agents.find((item) => item.id === task.assignedAgentId) ?? null, measuredTokens: summarizeMissionUsage(missionId, snapshot.runs).totalTokens, activeCommand: activeCommand?.id === request.requestId ? null : activeCommand });
    const retry = capabilities.retryCurrentDesign;
    if (!retry.allowed) throw new HttpError(409, retry.reason, 'MISSION_STAGE_UNAVAILABLE', { stage: 'design' });
    await this.workspaces.restoreMissionRevision(missionId, baseline!);
    const restored = await this.workspaces.inspectMissionWorkspace(missionId, baseline!.contentHash, false);
    if (restored.state !== 'clean' || restored.contentHash !== baseline!.contentHash) throw new HttpError(409, 'Design checkpoint restore did not reproduce the exact input hash', 'MISSION_WORKSPACE_STALE');
    const oldAttemptId = retry.attemptId;
    await this.store.mutate((database) => {
      const storedMission = database.missions.find((item) => item.id === missionId)!;
      const storedTask = database.missionTasks.find((item) => item.id === task.id)!;
      const storedAttempt = database.taskAttempts.find((item) => item.id === oldAttemptId)!;
      const decision = prepareMissionTaskRetry({ mission: storedMission, task: storedTask, attempt: storedAttempt, timestamp: now() });
      if (!decision.accepted) throw new HttpError(409, 'Design retry authority changed', 'MISSION_STAGE_UNAVAILABLE', { reason: decision.reason });
      Object.assign(storedMission, decision.mission); Object.assign(storedTask, decision.task); Object.assign(storedAttempt, decision.attempt);
    });
    const started = await this.execution.startCurrentTask(missionId, { startedByRecoveryCommandId: request.requestId });
    await this.store.mutate((database) => { const previous = database.taskAttempts.find((item) => item.id === oldAttemptId); if (previous) { previous.supersededByAttemptId = started.attempt.id; previous.updatedAt = now(); } });
    return { resultAttemptId: started.attempt.id, resultRevisionId: null };
  }

  private async captureRestoreRevision(mission: Mission, restored: MissionWorkspaceRevision): Promise<MissionWorkspaceRevision> {
    const task = this.store.snapshot().missionTasks.find((item) => item.missionId === mission.id && item.id === mission.currentTaskId) ?? this.store.snapshot().missionTasks.find((item) => item.missionId === mission.id);
    if (!task) throw new HttpError(409, 'Mission has no task for restore evidence');
    return this.workspaces.captureMissionRevision({ missionId: mission.id, revision: { id: randomUUID(), missionId: mission.id, sequence: mission.workspace.nextRevisionSequence, parentRevisionId: mission.workspace.currentRevisionId, restoredFromRevisionId: restored.id, origin: 'rollback', boundaries: [{ kind: 'rollback', taskId: task.id, restoredFromRevisionId: restored.id }], taskId: task.id, attemptId: null, interventionArtifactId: null, createdBy: 'system', createdAt: now() } });
  }

  async reconcileStartup(): Promise<void> {
    await this.reconcileTerminalApplyingCommands();
    for (const mission of this.store.snapshot().missions.filter((item) => !['completed', 'failed', 'cancelled'].includes(item.status))) {
      if (mission.workspace.state === 'provisioning') { if (!(await this.reconcileProvisioningMission(mission.id))) continue; }
      try { await this.workspaces.recoverInterruptedRestore(mission.id); } catch { await this.blockMission(mission.id); continue; }
      if (!(await this.restoreInterruptedDesignAttempts(mission.id))) continue;
      await this.interruptMissionRecords(mission.id);
      await this.store.mutate((database) => { const stored = database.missions.find((item) => item.id === mission.id); if (!stored) return; const applying = database.missionRecoveryCommands.find((item) => item.missionId === mission.id && item.status === 'applying'); if (applying) { applying.status = 'interrupted'; applying.updatedAt = now(); stored.activeRecoveryCommandId = null; } if (stored.status === 'running') { stored.status = 'recovered_paused'; stored.updatedAt = now(); } });
    }
  }

  private async restoreInterruptedDesignAttempts(missionId: string): Promise<boolean> {
    const snapshot = this.store.snapshot();
    const mission = snapshot.missions.find((item) => item.id === missionId);
    if (!mission) return false;
    for (const attempt of snapshot.taskAttempts.filter((item) => (item.status === 'queued' || item.status === 'running') && item.stage === 'design' && item.missionId === missionId)) {
      const baseline = snapshot.missionWorkspaceRevisions.find((item) => item.id === attempt.inputWorkspaceRevisionId && item.missionId === missionId);
      if (!baseline) { await this.blockMission(missionId); return false; }
      try {
        await this.workspaces.restoreMissionRevision(missionId, baseline);
        const inspection = await this.workspaces.inspectMissionWorkspace(missionId, baseline.contentHash, false);
        if (inspection.state !== 'clean' || inspection.contentHash !== baseline.contentHash) throw new Error('checkpoint hash mismatch');
      } catch {
        await this.blockMission(missionId);
        return false;
      }
    }
    return true;
  }

  private async reconcileTerminalApplyingCommands(): Promise<void> {
    await this.store.mutate((database) => {
      for (const command of database.missionRecoveryCommands.filter((item) => item.status === 'applying')) {
        const mission = database.missions.find((item) => item.id === command.missionId);
        if (!mission || !['completed', 'failed', 'cancelled'].includes(mission.status)) continue;
        command.status = 'completed';
        command.updatedAt = now();
        command.completedAt = command.updatedAt;
        if (mission.activeRecoveryCommandId === command.id) mission.activeRecoveryCommandId = null;
        if (!database.missionEvents.some((event) => event.type === 'recovery_completed' && event.details.commandId === command.id)) addEvent(database, mission, 'recovery_completed', { taskId: command.taskId }, { commandId: command.id, action: command.kind, reconciled: true });
      }
    });
  }

  private async reconcileProvisioningMission(missionId: string): Promise<boolean> {
    if (!(await this.workspaces.missionWorkspaceExists(missionId))) { await this.failProvisioningMission(missionId); return false; }
    const snapshot = this.store.snapshot(); const mission = snapshot.missions.find((item) => item.id === missionId); const task = snapshot.missionTasks.find((item) => item.missionId === missionId && item.stage === 'design'); if (!mission || !task) { await this.failProvisioningMission(missionId); return false; }
    let revision = mission.workspace.currentRevisionId ? snapshot.missionWorkspaceRevisions.find((item) => item.id === mission.workspace.currentRevisionId) : undefined;
    if (!revision) { try { revision = await this.workspaces.captureMissionRevision({ missionId, revision: { id: randomUUID(), missionId, sequence: mission.workspace.nextRevisionSequence, parentRevisionId: null, restoredFromRevisionId: null, origin: 'mission_start', boundaries: [{ kind: 'before_task', taskId: task.id }], taskId: task.id, attemptId: null, interventionArtifactId: null, createdBy: 'system', createdAt: now() } }); } catch { await this.failProvisioningMission(missionId); return false; } }
    await this.store.mutate((database) => { const stored = database.missions.find((item) => item.id === missionId)!; const storedTask = database.missionTasks.find((item) => item.id === task.id)!; if (!database.missionWorkspaceRevisions.some((item) => item.id === revision!.id)) database.missionWorkspaceRevisions.push(revision!); stored.workspace.state = 'ready'; stored.workspace.currentRevisionId = revision!.id; stored.workspace.revisionStatus = 'clean'; stored.workspace.nextRevisionSequence = revision!.sequence + 1; storedTask.inputWorkspaceRevisionId = revision!.id; stored.updatedAt = now(); addEvent(database, stored, 'workspace_ready', {}); });
    return true;
  }

  private async interruptMissionRecords(missionId: string): Promise<void> {
    await this.store.mutate((database) => { const mission = database.missions.find((item) => item.id === missionId); if (!mission) return; for (const attempt of database.taskAttempts.filter((item) => item.missionId === missionId && (item.status === 'queued' || item.status === 'running'))) { const task = database.missionTasks.find((item) => item.id === attempt.taskId) ?? null; const run = attempt.runId ? database.runs.find((item) => item.id === attempt.runId) : null; if (!run) continue; const transition = interruptMissionAttempt({ mission, task, attempt, run, timestamp: now() }); Object.assign(mission, transition.mission); Object.assign(attempt, transition.attempt); Object.assign(run, transition.run); if (task && transition.task) Object.assign(task, transition.task); if (attempt.stage === 'implement') mission.workspace.revisionStatus = 'uncheckpointed'; const agent = database.agents.find((item) => item.id === attempt.agentId); if (agent && !database.runs.some((candidate) => candidate.id !== run.id && candidate.agentId === agent.id && (candidate.status === 'queued' || candidate.status === 'running'))) { agent.status = 'ready'; agent.updatedAt = now(); } if (!database.missionEvents.some((event) => event.type === 'startup_interrupted' && event.attemptId === attempt.id)) addEvent(database, mission, 'startup_interrupted', { ...(task ? { taskId: task.id } : {}), attemptId: attempt.id, agentId: attempt.agentId }, { reason: 'startup reconciliation' }); } });
  }
  private async failProvisioningMission(missionId: string): Promise<void> { await this.store.mutate((database) => { const mission = database.missions.find((item) => item.id === missionId); if (!mission || ['completed', 'failed', 'cancelled'].includes(mission.status)) return; mission.status = 'failed'; mission.workspace.state = 'unavailable'; mission.updatedAt = now(); addEvent(database, mission, 'mission_status_changed', {}, { status: 'failed', reason: 'provisioned Mission workspace is unavailable' }); addEvent(database, mission, 'participants_released', {}); }); }
  private async blockMission(missionId: string): Promise<void> { await this.store.mutate((database) => { const mission = database.missions.find((item) => item.id === missionId); if (mission) { mission.status = 'blocked'; mission.workflow.phase = 'awaiting_intervention'; mission.workspace.revisionStatus = 'uncheckpointed'; mission.updatedAt = now(); const applying = database.missionRecoveryCommands.find((item) => item.missionId === missionId && item.status === 'applying'); if (applying) { applying.status = 'interrupted'; applying.error = safeMissionText('Startup restore recovery requires human intervention', 4096).content; applying.updatedAt = mission.updatedAt; mission.activeRecoveryCommandId = null; } addEvent(database, mission, 'mission_status_changed', {}, { status: 'blocked', workflowPhase: 'awaiting_intervention', reason: 'startup restore recovery failed' }); } }); }
}
