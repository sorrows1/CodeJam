import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import { DESIGN_CONTRACT_MAX_BYTES } from './design-contract.js';
import { DESIGN_PACKAGE_MAX_BYTES, parseDesignPackage } from './design-package.js';
import { buildImplementationPrompt, buildMissionPrompt, buildRepairPrompt } from './mission-prompt.js';
import { acceptImplementationCompletion, acceptRepairCompletion, guardAgentStageAdmission, type ImplementationAdmissionRejection } from './intent-workflow-state.js';
import { acceptMissionResult, startMissionAttempt, type MissionAdmission } from './mission-state.js';
import { summarizeMissionUsage } from './mission-budget.js';
import { addEvent, safeMissionText } from './mission-evidence.js';
import { resolveDesignReferenceMaterialization, type DesignReferenceStore } from './design-reference-store.js';
import { buildImplementationAdmissionFacts, decideImplementationAdmission, implementationAdmissionMessage } from './mission-implementation-admission.js';
import { JsonStore } from './store.js';
import type { MissionWorkspacePort } from './workspace.js';
import type { RunExecutionPort } from './run-execution.js';
import type { Agent, AgentRun, Mission, MissionArtifact, MissionTask, RunnerResult, TaskAttempt } from './types.js';
import { DesignGovernanceService } from './design-governance-service.js';
import { MissionRuntimeObservability } from './mission-runtime-observability.js';
import { isFrontendPath } from './playground-impact.js';
import { rejectUnexpectedImplementationScope } from './mission-scope-governance.js';

const now = () => new Date().toISOString();
const MAX_OUTPUT_BYTES = 64 * 1024;
const unavailable = (stage: MissionTask['stage']) => new HttpError(409, `${stage === 'design' ? 'Design' : stage === 'implement' ? 'Implementation' : 'Repair'} execution is not available`, 'MISSION_STAGE_UNAVAILABLE', { stage });

type ImplementationAdmissionResult = Extract<MissionAdmission, { kind: 'admitted' | 'existing' }> | { kind: 'denied'; reason: ImplementationAdmissionRejection };

export class MissionExecutionService {
  constructor(
    private readonly store: JsonStore,
    private readonly workspaces: MissionWorkspacePort,
    private readonly execution: RunExecutionPort,
    private readonly design: DesignGovernanceService,
    private readonly references: DesignReferenceStore,
    private readonly redactionSecrets: readonly string[] = [],
    private readonly runtimeActivity = new MissionRuntimeObservability(),
    private readonly onImplementationReady?: (missionId: string) => Promise<unknown>,
  ) {}

  async startMission(missionId: string): Promise<void> { await this.startCurrentTask(missionId); }

  async startCurrentTask(missionId: string, recovery: { startedByRecoveryCommandId?: string | null } = {}): Promise<{ mission: Mission; task: MissionTask; attempt: TaskAttempt }> {
    const snapshot = this.store.snapshot();
    const mission = snapshot.missions.find((item) => item.id === missionId);
    if (!mission) throw new HttpError(404, 'Mission not found');
    const recoveryCommandId = recovery.startedByRecoveryCommandId ?? null;
    if (mission.activeRecoveryCommandId && mission.activeRecoveryCommandId !== recoveryCommandId) throw new HttpError(409, 'Mission recovery is already applying', 'MISSION_STAGE_UNAVAILABLE');
    if (recoveryCommandId && mission.activeRecoveryCommandId !== recoveryCommandId) throw new HttpError(409, 'Recovery command is no longer authoritative', 'MISSION_STAGE_UNAVAILABLE');
    const task = snapshot.missionTasks.find((item) => item.id === mission.currentTaskId && item.missionId === missionId);
    if (!task) throw new HttpError(409, 'Mission has no current task');
    if (task.stage === 'design') return this.startDesignTask(snapshot, mission, task, recovery);
    if (task.stage === 'implement') return this.startImplementationTask(snapshot, mission, task);
    if (task.stage === 'repair') return this.startRepairTask(snapshot, mission, task);
    throw unavailable(task.stage);
  }

  private async startDesignTask(snapshot: ReturnType<JsonStore['snapshot']>, mission: Mission, task: MissionTask, recovery: { startedByRecoveryCommandId?: string | null }): Promise<{ mission: Mission; task: MissionTask; attempt: TaskAttempt }> {
    const admissionGuard = guardAgentStageAdmission({ mission, task, stage: 'design', workspaceRevisionId: task.inputWorkspaceRevisionId });
    if (!admissionGuard.accepted) throw new HttpError(409, 'Design task is not admissible', 'MISSION_STAGE_UNAVAILABLE', { stage: 'design', reason: admissionGuard.reason });
    if (!task.inputWorkspaceRevisionId || mission.workspace.currentRevisionId !== task.inputWorkspaceRevisionId) throw new HttpError(409, 'Design input workspace revision is stale', 'MISSION_WORKSPACE_STALE');
    const baseline = snapshot.missionWorkspaceRevisions.find((revision) => revision.id === task.inputWorkspaceRevisionId);
    if (!baseline) throw new HttpError(409, 'Design input checkpoint is unavailable', 'MISSION_WORKSPACE_STALE');
    const existing = this.findExistingAttempt(snapshot, task);
    if (existing) return existing;
    if (task.status !== 'pending') throw new HttpError(409, 'Design task is not pending; use its explicit recovery action', 'MISSION_STAGE_UNAVAILABLE', { stage: 'design' });
    const inspection = await this.workspaces.inspectMissionWorkspace(mission.id, baseline.contentHash, false);
    if (inspection.state !== 'clean') throw new HttpError(409, 'Mission workspace is not at the design input checkpoint', 'MISSION_WORKSPACE_STALE');
    await this.ensureRuntimeReady(mission.id);
    const current = this.store.snapshot();
    const currentMission = current.missions.find((item) => item.id === mission.id)!;
    const parent = currentMission.workflow.latestDesignRevisionId ? await this.design.seedForRevision(currentMission.workflow.latestDesignRevisionId) : undefined;
    await this.workspaces.prepareDesignDraft(mission.id, parent);
    const currentTask = current.missionTasks.find((item) => item.id === task.id)!;
    const agent = current.agents.find((item) => item.id === currentTask.assignedAgentId);
    if (!agent) throw new HttpError(404, 'Designer Agent not found');
    const run: AgentRun = { id: randomUUID(), agentId: agent.id, status: 'queued', prompt: buildMissionPrompt({ mission: currentMission, tasks: current.missionTasks, artifacts: current.missionArtifacts }, currentTask), output: null, error: null, usage: null, startedAt: null, completedAt: null, createdAt: now(), context: { kind: 'mission', missionId: mission.id, taskId: currentTask.id, attemptId: 'pending' } };
    const result = await this.store.mutate((database) => {
      const storedMission = database.missions.find((item) => item.id === mission.id)!;
      const storedTask = database.missionTasks.find((item) => item.id === currentTask.id)!;
      const storedAgent = database.agents.find((item) => item.id === agent.id)!;
      const attemptId = randomUUID();
      run.context = { kind: 'mission', missionId: mission.id, taskId: storedTask.id, attemptId };
      const admission = startMissionAttempt({ missions: database.missions, mission: storedMission, task: storedTask, agent: storedAgent, inputArtifactIds: storedTask.inputArtifactIds, missionArtifactIds: database.missionArtifacts.filter((item) => item.missionId === mission.id).map((item) => item.id), attempts: database.taskAttempts.filter((item) => item.missionId === mission.id), authoritativeAttempt: storedTask.authoritativeAttemptId ? database.taskAttempts.find((item) => item.id === storedTask.authoritativeAttemptId) ?? null : null, authoritativeRun: storedTask.authoritativeAttemptId ? database.runs.find((item) => item.context.kind === 'mission' && item.context.attemptId === storedTask.authoritativeAttemptId) ?? null : null, run, attemptId, timestamp: now(), ...(recovery.startedByRecoveryCommandId !== undefined ? { startedByRecoveryCommandId: recovery.startedByRecoveryCommandId } : {}), tokenBudget: storedMission.tokenBudget, measuredUsage: summarizeMissionUsage(mission.id, database.runs) });
      if (admission.kind === 'rejected') throw new HttpError(409, 'Mission Design task is not admissible', 'MISSION_STAGE_UNAVAILABLE', { stage: 'design', reason: admission.reason });
      if (admission.kind === 'existing') return admission;
      Object.assign(storedMission, admission.mission);
      Object.assign(storedTask, admission.task);
      Object.assign(storedAgent, admission.agent);
      database.runs.push(admission.run);
      database.taskAttempts.push(admission.attempt);
      addEvent(database, storedMission, 'attempt_started', { taskId: storedTask.id, attemptId: admission.attempt.id, agentId: storedAgent.id }, { stage: 'design' });
      return admission;
    });
    if (result.kind === 'existing') return { mission: result.mission, task: result.task, attempt: result.attempt };
    void this.runDesign(result, agent).catch((error) => { void this.recordDesignExecutionFailure(result, error); });
    return { mission: result.mission, task: result.task, attempt: result.attempt };
  }

  private findExistingAttempt(snapshot: ReturnType<JsonStore['snapshot']>, task: MissionTask): { mission: Mission; task: MissionTask; attempt: TaskAttempt } | null {
    if (!task.authoritativeAttemptId) return null;
    const attempt = snapshot.taskAttempts.find((item) => item.id === task.authoritativeAttemptId);
    const run = attempt?.runId ? snapshot.runs.find((item) => item.id === attempt.runId) : undefined;
    if (!attempt || !run || attempt.status !== 'running') return null;
    const mission = snapshot.missions.find((item) => item.id === task.missionId);
    return mission ? { mission: structuredClone(mission), task: structuredClone(task), attempt: structuredClone(attempt) } : null;
  }

  private async startImplementationTask(snapshot: ReturnType<JsonStore['snapshot']>, mission: Mission, task: MissionTask): Promise<{ mission: Mission; task: MissionTask; attempt: TaskAttempt }> {
    const existing = this.findExistingAttempt(snapshot, task);
    if (existing) return existing;
    const revision = mission.workflow.approvedDesignRevisionId ? snapshot.designRevisions.find((item) => item.id === mission.workflow.approvedDesignRevisionId) ?? null : null;
    const baseline = task.inputWorkspaceRevisionId ? snapshot.missionWorkspaceRevisions.find((item) => item.id === task.inputWorkspaceRevisionId) ?? null : null;
    const workspace = baseline ? await this.workspaces.inspectMissionWorkspace(mission.id, baseline.contentHash, false) : { state: 'unavailable' as const, contentHash: null, displayPath: this.workspaces.missionWorkspacePath(mission.id) };
    const facts = buildImplementationAdmissionFacts({ database: snapshot, mission, workspaceState: workspace.state });
    const guard = decideImplementationAdmission(facts);
    if (!guard.accepted) return this.rejectImplementation(mission.id, task.id, guard.reason, mission.workflow.approvedDesignRevisionId, mission.workspace.currentRevisionId, facts.measuredTokens);
    if (!(await this.references.verify(guard.materialization))) return this.rejectImplementation(mission.id, task.id, 'reference_integrity_failed', revision!.id, baseline!.id, facts.measuredTokens);
    let contractJson: string; let packageJson: string; let previewHtml: string;
    try { [contractJson, packageJson, previewHtml] = await Promise.all([this.references.read(guard.materialization.contract, DESIGN_CONTRACT_MAX_BYTES), this.references.read(guard.materialization.package, DESIGN_PACKAGE_MAX_BYTES), this.references.read(guard.materialization.preview, DESIGN_PACKAGE_MAX_BYTES)]); }
    catch { return this.rejectImplementation(mission.id, task.id, 'reference_integrity_failed', revision!.id, baseline!.id, facts.measuredTokens); }
    await this.ensureRuntimeReady(mission.id);
    const current = this.store.snapshot();
    const currentMission = current.missions.find((item) => item.id === mission.id)!;
    const currentRevision = current.designRevisions.find((item) => item.id === revision!.id)!;
    const currentTask = current.missionTasks.find((item) => item.id === task.id)!;
    const currentAgent = current.agents.find((item) => item.id === currentTask.assignedAgentId)!;
    const run: AgentRun = { id: randomUUID(), agentId: currentAgent.id, status: 'queued', prompt: buildImplementationPrompt({ mission: currentMission, task: currentTask, participant: currentMission.participants.find((item) => item.agentId === currentAgent.id)?.snapshot ?? null, designRevisionId: currentRevision.id, designVersion: currentRevision.version, packageHash: currentRevision.packageHash, previewHash: currentRevision.previewHash, contractHash: currentRevision.contractHash, contractJson, packageExcerpt: packageJson, previewExcerpt: previewHtml, workspaceRevisionId: currentTask.inputWorkspaceRevisionId! }), output: null, error: null, usage: null, startedAt: null, completedAt: null, createdAt: now(), context: { kind: 'mission', missionId: mission.id, taskId: currentTask.id, attemptId: 'pending' } };
    const result = await this.store.mutate(async (database): Promise<ImplementationAdmissionResult> => {
      const storedMission = database.missions.find((item) => item.id === mission.id)!;
      const storedTask = database.missionTasks.find((item) => item.id === task.id)!;
      const authoritativeAttempt = storedTask.authoritativeAttemptId ? database.taskAttempts.find((item) => item.id === storedTask.authoritativeAttemptId) ?? null : null;
      const authoritativeRun = authoritativeAttempt?.runId ? database.runs.find((item) => item.id === authoritativeAttempt.runId) ?? null : null;
      if (authoritativeAttempt?.status === 'running' && authoritativeRun) return { kind: 'existing', mission: structuredClone(storedMission), task: structuredClone(storedTask), attempt: structuredClone(authoritativeAttempt), run: structuredClone(authoritativeRun), agent: structuredClone(database.agents.find((item) => item.id === storedTask.assignedAgentId)!) };
      const storedRevision = storedMission.workflow.approvedDesignRevisionId ? database.designRevisions.find((item) => item.id === storedMission.workflow.approvedDesignRevisionId) ?? null : null;
      const storedBaseline = storedTask.inputWorkspaceRevisionId ? database.missionWorkspaceRevisions.find((item) => item.id === storedTask.inputWorkspaceRevisionId) ?? null : null;
      const storedAgent = database.agents.find((item) => item.id === storedTask.assignedAgentId) ?? null;
      const storedWorkspace = storedBaseline ? await this.workspaces.inspectMissionWorkspace(storedMission.id, storedBaseline.contentHash, false) : { state: 'unavailable' as const, contentHash: null, displayPath: this.workspaces.missionWorkspacePath(storedMission.id) };
      const storedFacts = buildImplementationAdmissionFacts({ database, mission: storedMission, workspaceState: storedWorkspace.state });
      const storedGuard = decideImplementationAdmission(storedFacts);
      if (!storedGuard.accepted) { this.recordAdmissionDenied(database, storedMission, storedTask, storedGuard.reason, storedMission.workflow.approvedDesignRevisionId, storedMission.workspace.currentRevisionId); return { kind: 'denied', reason: storedGuard.reason }; }
      if (!(await this.references.verify(storedGuard.materialization))) { this.recordAdmissionDenied(database, storedMission, storedTask, 'reference_integrity_failed', storedRevision!.id, storedBaseline?.id ?? null); return { kind: 'denied', reason: 'reference_integrity_failed' }; }
      const attemptId = randomUUID();
      run.context = { kind: 'mission', missionId: storedMission.id, taskId: storedTask.id, attemptId };
      const admission = startMissionAttempt({ missions: database.missions, mission: storedMission, task: storedTask, agent: storedAgent!, inputArtifactIds: storedTask.inputArtifactIds, missionArtifactIds: database.missionArtifacts.filter((item) => item.missionId === storedMission.id).map((item) => item.id), attempts: database.taskAttempts.filter((item) => item.missionId === storedMission.id), authoritativeAttempt: null, authoritativeRun: null, run, attemptId, timestamp: now(), tokenBudget: storedMission.tokenBudget, measuredUsage: summarizeMissionUsage(storedMission.id, database.runs) });
      if (admission.kind === 'rejected') { this.recordAdmissionDenied(database, storedMission, storedTask, admission.reason as ImplementationAdmissionRejection, storedMission.workflow.approvedDesignRevisionId, storedMission.workspace.currentRevisionId); if (admission.reason === 'budget_exhausted') this.recordBudgetDenied(database, storedMission, summarizeMissionUsage(storedMission.id, database.runs).totalTokens); return { kind: 'denied', reason: admission.reason as ImplementationAdmissionRejection }; }
      Object.assign(storedMission, admission.mission);
      Object.assign(storedTask, admission.task);
      Object.assign(storedAgent!, admission.agent);
      database.runs.push(admission.run);
      database.taskAttempts.push(admission.attempt);
      addEvent(database, storedMission, 'attempt_started', { taskId: storedTask.id, attemptId: admission.attempt.id, agentId: storedAgent!.id }, { stage: 'implement', designRevisionId: storedRevision!.id, workspaceRevisionId: storedBaseline!.id });
      return admission;
    });
    if (result.kind === 'existing') return { mission: result.mission, task: result.task, attempt: result.attempt };
    if (result.kind === 'denied') throw new HttpError(409, `Implementation admission denied. ${implementationAdmissionMessage(result.reason)}`, 'IMPLEMENTATION_ADMISSION_DENIED', { reason: result.reason });
    void this.runWorkspaceTask(result, 'implement').catch((error) => { void this.recordImplementationFailure(result, error instanceof Error ? error : new Error(String(error)), 'infrastructure'); });
    return { mission: result.mission, task: result.task, attempt: result.attempt };
  }

  private async startRepairTask(snapshot: ReturnType<JsonStore['snapshot']>, mission: Mission, task: MissionTask): Promise<{ mission: Mission; task: MissionTask; attempt: TaskAttempt }> {
    const existing = this.findExistingAttempt(snapshot, task);
    if (existing) return existing;
    const guard = guardAgentStageAdmission({ mission, task, stage: 'repair', designRevisionId: task.inputDesignRevisionId, verificationRunId: task.inputVerificationRunId, workspaceRevisionId: task.inputWorkspaceRevisionId, repairCycle: task.repairCycle });
    if (!guard.accepted || task.status !== 'pending') throw new HttpError(409, 'Repair task is not admissible', 'MISSION_STAGE_UNAVAILABLE', { stage: 'repair', reason: guard.accepted ? 'task_not_pending' : guard.reason });
    const revision = mission.workflow.approvedDesignRevisionId ? snapshot.designRevisions.find((item) => item.id === mission.workflow.approvedDesignRevisionId && item.missionId === mission.id) ?? null : null;
    const verification = task.inputVerificationRunId ? snapshot.verificationRuns.find((item) => item.id === task.inputVerificationRunId && item.missionId === mission.id) ?? null : null;
    const baseline = task.inputWorkspaceRevisionId ? snapshot.missionWorkspaceRevisions.find((item) => item.id === task.inputWorkspaceRevisionId && item.missionId === mission.id) ?? null : null;
    if (!revision || revision.status !== 'approved' || !verification || !baseline || mission.workspace.currentRevisionId !== baseline.id || mission.workflow.implementedWorkspaceRevisionId !== baseline.id) throw new HttpError(409, 'Repair input binding is stale', 'MISSION_WORKSPACE_STALE');
    const workspace = await this.workspaces.inspectMissionWorkspace(mission.id, baseline.contentHash, false);
    if (workspace.state !== 'clean') throw new HttpError(409, 'Mission workspace is not at the Repair input checkpoint', 'MISSION_WORKSPACE_STALE');
    const materialization = resolveDesignReferenceMaterialization({ revision, artifacts: snapshot.missionArtifacts });
    if (!materialization.ok || !(await this.references.verify(materialization.materialization))) throw new HttpError(409, 'Protected DesignRevision is unavailable for Repair', 'MISSION_STAGE_UNAVAILABLE', { stage: 'repair' });
    const contractJson = await this.references.read(materialization.materialization.contract, DESIGN_CONTRACT_MAX_BYTES);
    await this.ensureRuntimeReady(mission.id);
    const current = this.store.snapshot();
    const currentMission = current.missions.find((item) => item.id === mission.id)!;
    const currentTask = current.missionTasks.find((item) => item.id === task.id)!;
    const currentVerification = current.verificationRuns.find((item) => item.id === verification.id)!;
    const currentRevision = current.designRevisions.find((item) => item.id === revision.id)!;
    const currentAgent = current.agents.find((item) => item.id === currentTask.assignedAgentId);
    if (!currentAgent) throw new HttpError(404, 'Builder Agent not found');
    const humanFeedback = [...currentTask.inputArtifactIds].reverse().map((id) => current.missionArtifacts.find((artifact) => artifact.id === id)).find((artifact) => artifact?.kind === 'human_intervention')?.content ?? null;
    const run: AgentRun = { id: randomUUID(), agentId: currentAgent.id, status: 'queued', prompt: buildRepairPrompt({ mission: currentMission, task: currentTask, participant: currentMission.participants.find((item) => item.agentId === currentAgent.id)?.snapshot ?? null, designRevisionId: currentRevision.id, designVersion: currentRevision.version, contractJson, workspaceRevisionId: baseline.id, verification: currentVerification, humanFeedback }), output: null, error: null, usage: null, startedAt: null, completedAt: null, createdAt: now(), context: { kind: 'mission', missionId: mission.id, taskId: currentTask.id, attemptId: 'pending' } };
    const result = await this.store.mutate(async (database) => {
      const storedMission = database.missions.find((item) => item.id === mission.id)!;
      const storedTask = database.missionTasks.find((item) => item.id === task.id)!;
      const storedAgent = database.agents.find((item) => item.id === storedTask.assignedAgentId);
      const storedVerification = storedTask.inputVerificationRunId ? database.verificationRuns.find((item) => item.id === storedTask.inputVerificationRunId) : null;
      const storedBaseline = storedTask.inputWorkspaceRevisionId ? database.missionWorkspaceRevisions.find((item) => item.id === storedTask.inputWorkspaceRevisionId) : null;
      const storedRevision = storedMission.workflow.approvedDesignRevisionId ? database.designRevisions.find((item) => item.id === storedMission.workflow.approvedDesignRevisionId) : null;
      const storedGuard = guardAgentStageAdmission({ mission: storedMission, task: storedTask, stage: 'repair', designRevisionId: storedTask.inputDesignRevisionId, verificationRunId: storedTask.inputVerificationRunId, workspaceRevisionId: storedTask.inputWorkspaceRevisionId, repairCycle: storedTask.repairCycle });
      if (!storedGuard.accepted || !storedAgent || !storedVerification || !storedBaseline || !storedRevision || storedTask.status !== 'pending') throw unavailable('repair');
      const storedWorkspace = await this.workspaces.inspectMissionWorkspace(storedMission.id, storedBaseline.contentHash, false);
      const storedMaterialization = resolveDesignReferenceMaterialization({ revision: storedRevision, artifacts: database.missionArtifacts });
      if (storedWorkspace.state !== 'clean' || !storedMaterialization.ok || !(await this.references.verify(storedMaterialization.materialization))) throw unavailable('repair');
      const attemptId = randomUUID();
      run.context = { kind: 'mission', missionId: storedMission.id, taskId: storedTask.id, attemptId };
      const admission = startMissionAttempt({ missions: database.missions, mission: storedMission, task: storedTask, agent: storedAgent, inputArtifactIds: storedTask.inputArtifactIds, missionArtifactIds: database.missionArtifacts.filter((item) => item.missionId === storedMission.id).map((item) => item.id), attempts: database.taskAttempts.filter((item) => item.missionId === storedMission.id), authoritativeAttempt: null, authoritativeRun: null, run, attemptId, timestamp: now(), tokenBudget: storedMission.tokenBudget, measuredUsage: summarizeMissionUsage(storedMission.id, database.runs) });
      if (admission.kind === 'rejected') { if (admission.reason === 'budget_exhausted') this.recordBudgetDenied(database, storedMission, summarizeMissionUsage(storedMission.id, database.runs).totalTokens); throw new HttpError(409, 'Repair admission denied', 'MISSION_STAGE_UNAVAILABLE', { stage: 'repair', reason: admission.reason }); }
      if (admission.kind === 'existing') return admission;
      Object.assign(storedMission, admission.mission);
      Object.assign(storedTask, admission.task);
      Object.assign(storedAgent, admission.agent);
      database.runs.push(admission.run);
      database.taskAttempts.push(admission.attempt);
      addEvent(database, storedMission, 'attempt_started', { taskId: storedTask.id, attemptId: admission.attempt.id, agentId: storedAgent.id }, { stage: 'repair', designRevisionId: storedTask.inputDesignRevisionId, verificationRunId: storedTask.inputVerificationRunId, workspaceRevisionId: storedTask.inputWorkspaceRevisionId, repairCycle: storedTask.repairCycle });
      return admission;
    });
    if (result.kind === 'existing') return { mission: result.mission, task: result.task, attempt: result.attempt };
    void this.runWorkspaceTask(result, 'repair').catch((error) => { void this.recordImplementationFailure(result, error instanceof Error ? error : new Error(String(error)), 'infrastructure'); });
    return { mission: result.mission, task: result.task, attempt: result.attempt };
  }

  private async rejectImplementation(missionId: string, taskId: string, reason: ImplementationAdmissionRejection, approvedRevisionId: string | null, workspaceRevisionId: string | null, measuredTokens: number): Promise<never> {
    await this.store.mutate((database) => { const mission = database.missions.find((item) => item.id === missionId); const task = database.missionTasks.find((item) => item.id === taskId); if (mission && task) { this.recordAdmissionDenied(database, mission, task, reason, approvedRevisionId, workspaceRevisionId); if (reason === 'budget_exhausted') this.recordBudgetDenied(database, mission, measuredTokens); } });
    throw new HttpError(409, `Implementation admission denied. ${implementationAdmissionMessage(reason)}`, 'IMPLEMENTATION_ADMISSION_DENIED', { reason });
  }

  private recordAdmissionDenied(database: ReturnType<JsonStore['snapshot']>, mission: Mission, task: MissionTask, reason: ImplementationAdmissionRejection, approvedRevisionId: string | null, workspaceRevisionId: string | null): void {
    const details = { reason, authorityVersion: task.authorityVersion, approvedRevisionId, workspaceRevisionId };
    if (database.missionEvents.some((event) => event.missionId === mission.id && event.type === 'implementation_admission_denied' && event.taskId === task.id && JSON.stringify(event.details) === JSON.stringify(details))) return;
    addEvent(database, mission, 'implementation_admission_denied', { taskId: task.id }, details);
  }

  private recordBudgetDenied(database: ReturnType<JsonStore['snapshot']>, mission: Mission, measuredTokens: number): void {
    if (!database.missionEvents.some((event) => event.missionId === mission.id && event.type === 'budget_admission_denied' && event.taskId === mission.currentTaskId)) addEvent(database, mission, 'budget_admission_denied', { taskId: mission.currentTaskId ?? null }, { measuredTokens, tokenLimit: mission.tokenBudget });
    mission.status = 'blocked';
    mission.updatedAt = now();
  }

  private async ensureRuntimeReady(missionId: string): Promise<void> {
    const readiness = await this.execution.preflight({ workspacePath: this.workspaces.missionWorkspacePath(missionId) });
    if (!readiness.ok) throw new HttpError(503, readiness.message, 'MISSION_RUNTIME_UNAVAILABLE', { category: readiness.category });
  }

  private async runDesign(admission: Extract<MissionAdmission, { kind: 'admitted' }>, agent: Agent): Promise<void> {
    this.runtimeActivity.begin({ missionId: admission.mission.id, stage: 'design', attemptId: admission.attempt.id, attemptNumber: admission.attempt.attemptNumber, startedAt: admission.attempt.startedAt });
    const result = await this.execution.start(agent, admission.run, { agentId: agent.id, workspacePath: this.workspaces.missionWorkspacePath(admission.mission.id), prompt: admission.run.prompt, threadId: null, onObservation: (observation) => this.runtimeActivity.observe(admission.attempt.id, observation), missionAttempt: { missionId: admission.mission.id, taskId: admission.task.id, attemptId: admission.attempt.id, stage: 'design', inputDesignRevisionId: null, inputVerificationRunId: null, inputWorkspaceRevisionId: admission.attempt.inputWorkspaceRevisionId, repairCycle: null, attemptNumber: admission.attempt.attemptNumber } });
    this.runtimeActivity.finish(admission.attempt.id, result.result?.usage ?? null);
    await this.design.finalizeDesign({ missionId: admission.mission.id, taskId: admission.task.id, attemptId: admission.attempt.id, result: result.result, error: result.error });
  }

  private async recordDesignExecutionFailure(admission: Extract<MissionAdmission, { kind: 'admitted' }>, error: unknown): Promise<void> {
    await this.design.finalizeDesign({ missionId: admission.mission.id, taskId: admission.task.id, attemptId: admission.attempt.id, result: null, error: error instanceof Error ? error : new Error(String(error)) });
  }

  private async runWorkspaceTask(admission: Extract<MissionAdmission, { kind: 'admitted' }>, stage: 'implement' | 'repair'): Promise<void> {
    const agent = admission.agent;
    this.runtimeActivity.begin({ missionId: admission.mission.id, stage, attemptId: admission.attempt.id, attemptNumber: admission.attempt.attemptNumber, startedAt: admission.attempt.startedAt });
    const execution = await this.execution.start(agent, admission.run, { agentId: agent.id, workspacePath: this.workspaces.missionWorkspacePath(admission.mission.id), prompt: admission.run.prompt, threadId: null, onObservation: (observation) => this.runtimeActivity.observe(admission.attempt.id, observation), missionAttempt: { missionId: admission.mission.id, taskId: admission.task.id, attemptId: admission.attempt.id, stage, inputDesignRevisionId: admission.attempt.inputDesignRevisionId, inputVerificationRunId: admission.attempt.inputVerificationRunId, inputWorkspaceRevisionId: admission.attempt.inputWorkspaceRevisionId, repairCycle: admission.attempt.repairCycle, attemptNumber: admission.attempt.attemptNumber } });
    this.runtimeActivity.finish(admission.attempt.id, execution.result?.usage ?? null);
    const snapshot = this.store.snapshot();
    const mission = snapshot.missions.find((item) => item.id === admission.mission.id);
    const task = snapshot.missionTasks.find((item) => item.id === admission.task.id);
    const attempt = snapshot.taskAttempts.find((item) => item.id === admission.attempt.id);
    const run = snapshot.runs.find((item) => item.id === admission.run.id);
    if (!mission || !task || !attempt || !run || !acceptMissionResult(task, attempt, run, { mission, currentArtifactIds: task.inputArtifactIds }).accepted) { await this.discardStaleResult(admission); return; }
    const revision = mission.workflow.approvedDesignRevisionId ? snapshot.designRevisions.find((item) => item.id === mission.workflow.approvedDesignRevisionId) : undefined;
    const materialization = revision ? resolveDesignReferenceMaterialization({ revision, artifacts: snapshot.missionArtifacts }) : { ok: false as const, reason: 'reference_artifacts_missing' as const };
    const referenceIntact = materialization.ok && await this.references.verify(materialization.materialization);
    if (!referenceIntact) { await this.restoreAfterReferenceFailure(admission, 'protected_reference_integrity_failed', execution.result); return; }
    if (execution.error || !execution.result) { await this.recordImplementationFailure(admission, execution.error ?? new Error(`${stage === 'repair' ? 'Repair' : 'Builder'} returned no result`), execution.error?.name === 'RunCancelledError' ? 'cancelled' : 'infrastructure', false, execution.result); return; }
    const baseline = snapshot.missionWorkspaceRevisions.find((item) => item.id === attempt.inputWorkspaceRevisionId);
    if (!baseline) { await this.recordImplementationFailure(admission, new Error(`${stage === 'repair' ? 'Repair' : 'Implementation'} input checkpoint is unavailable`), 'infrastructure', true, execution.result); return; }
    const authority = acceptMissionResult(task, attempt, run, { mission, currentArtifactIds: task.inputArtifactIds });
    if (!authority.accepted) { await this.discardStaleResult(admission); return; }
    let captured;
    try {
      captured = await this.workspaces.captureMissionRevision({ missionId: mission.id, revision: { id: randomUUID(), missionId: mission.id, sequence: mission.workspace.nextRevisionSequence, parentRevisionId: baseline.id, restoredFromRevisionId: null, origin: 'task_success', boundaries: [{ kind: 'after_task', taskId: task.id }], taskId: task.id, attemptId: attempt.id, interventionArtifactId: null, createdBy: 'agent', createdAt: now() } });
    } catch (error) { await this.recordImplementationFailure(admission, error instanceof Error ? error : new Error(String(error)), 'infrastructure', true, execution.result); return; }
    try {
      const packageValue = parseDesignPackage(await this.references.read(materialization.materialization.package, DESIGN_PACKAGE_MAX_BYTES));
      const manifest = await this.workspaces.compareRevisions(mission.id, baseline, captured, this.redactionSecrets);
      const allowed = new Set(packageValue.surfaces.flatMap((surface) => [surface.entrypoint, ...surface.sourcePaths, ...surface.sharedDependencies]));
      const unexpected = manifest.files.filter((file) => isFrontendPath(file.path) && !allowed.has(file.path)).map((file) => file.path);
      if (manifest.truncated) unexpected.push('[changed-file manifest exceeded its bound]');
      if (unexpected.length) { await this.rejectUnexpectedUiScope(admission, baseline, captured, unexpected, execution.result); return; }
    } catch (error) {
      await this.workspaces.discardMissionRevision(mission.id, captured).catch(() => undefined);
      await this.restoreAfterReferenceFailure(admission, `implementation_scope_validation_failed: ${error instanceof Error ? error.message : String(error)}`, execution.result);
      return;
    }
    const published = await this.store.mutate((database): boolean => {
      const currentMission = database.missions.find((item) => item.id === mission.id);
      const currentTask = database.missionTasks.find((item) => item.id === task.id);
      const currentAttempt = database.taskAttempts.find((item) => item.id === attempt.id);
      const currentRun = database.runs.find((item) => item.id === run.id);
      if (!currentMission || !currentTask || !currentAttempt || !currentRun || !acceptMissionResult(currentTask, currentAttempt, currentRun, { mission: currentMission, currentArtifactIds: currentTask.inputArtifactIds }).accepted || currentMission.workflow.approvedDesignRevisionId !== attempt.inputDesignRevisionId || currentMission.workspace.currentRevisionId !== attempt.inputWorkspaceRevisionId || currentMission.workspace.revisionStatus !== 'clean') return false;
      const decision = stage === 'implement'
        ? acceptImplementationCompletion({ mission: currentMission, task: currentTask, attempt: currentAttempt, outputWorkspaceRevisionId: captured!.id })
        : acceptRepairCompletion({ mission: currentMission, task: currentTask, attempt: currentAttempt, outputWorkspaceRevisionId: captured!.id });
      if (!decision.accepted) return false;
      let output: MissionArtifact | null = null;
      if (execution.result!.output !== null) {
        const boundedOutput = safeMissionText(execution.result!.output, MAX_OUTPUT_BYTES, this.redactionSecrets);
        output = { id: randomUUID(), missionId: mission.id, taskId: task.id, attemptId: attempt.id, kind: 'agent_output', mediaType: 'text/plain', content: boundedOutput.content, storage: { kind: 'inline' }, sha256: createHash('sha256').update(boundedOutput.content, 'utf8').digest('hex'), workspaceRevisionId: captured!.id, createdBy: { kind: 'agent', agentId: attempt.agentId }, originalByteLength: boundedOutput.originalByteLength, truncated: boundedOutput.truncated, createdAt: now() };
      }
      database.missionWorkspaceRevisions.push(captured!);
      if (output) database.missionArtifacts.push(output);
      Object.assign(currentMission, decision.value.mission);
      Object.assign(currentTask, decision.value.task);
      currentMission.workspace.currentRevisionId = captured!.id;
      currentMission.workspace.revisionStatus = 'clean';
      currentMission.workspace.nextRevisionSequence = captured!.sequence + 1;
      currentMission.updatedAt = now();
      currentTask.outputArtifactIds = output ? [output.id] : [];
      currentTask.completedAt = currentMission.updatedAt;
      currentTask.updatedAt = currentMission.updatedAt;
      currentAttempt.status = 'completed';
      currentAttempt.runtimeThreadId = execution.result!.threadId;
      currentAttempt.usage = execution.result!.usage;
      currentAttempt.outputArtifactId = output?.id ?? null;
      currentAttempt.outputWorkspaceRevisionId = captured!.id;
      currentAttempt.completedAt = currentMission.updatedAt;
      currentAttempt.updatedAt = currentMission.updatedAt;
      addEvent(database, currentMission, 'attempt_completed', { taskId: task.id, attemptId: attempt.id, agentId: attempt.agentId }, { stage, workspaceRevisionId: captured!.id, repairCycle: attempt.repairCycle });
      addEvent(database, currentMission, 'mission_status_changed', { taskId: task.id }, { status: currentMission.status, workflowPhase: currentMission.workflow.phase });
      return true;
    });
    if (!published) { await this.discardStaleResult(admission); return; }
    if (this.onImplementationReady) void this.onImplementationReady(mission.id).catch(() => undefined);
  }

  private async rejectUnexpectedUiScope(admission: Extract<MissionAdmission, { kind: 'admitted' }>, baseline: NonNullable<ReturnType<JsonStore['snapshot']>['missionWorkspaceRevisions'][number]>, captured: NonNullable<ReturnType<JsonStore['snapshot']>['missionWorkspaceRevisions'][number]>, unexpectedPaths: string[], result: RunnerResult): Promise<void> {
    await rejectUnexpectedImplementationScope({ store: this.store, workspaces: this.workspaces, missionId: admission.mission.id, taskId: admission.task.id, attemptId: admission.attempt.id, runId: admission.run.id, baseline, captured, unexpectedPaths, result, redactionSecrets: this.redactionSecrets });
  }

  private async discardStaleResult(admission: Extract<MissionAdmission, { kind: 'admitted' }>): Promise<void> {
    await this.store.mutate(async (database) => {
      const mission = database.missions.find((item) => item.id === admission.mission.id);
      const task = database.missionTasks.find((item) => item.id === admission.task.id && item.missionId === admission.mission.id);
      const attempt = database.taskAttempts.find((item) => item.id === admission.attempt.id && item.missionId === admission.mission.id);
      if (!mission) return;
      let workspaceRestored = false;
      let workspaceQuarantined = false;
      const baseline = attempt?.inputWorkspaceRevisionId ? database.missionWorkspaceRevisions.find((revision) => revision.id === attempt.inputWorkspaceRevisionId && revision.missionId === mission.id) : undefined;
      const replacement = task?.authoritativeAttemptId ? database.taskAttempts.find((candidate) => candidate.id === task.authoritativeAttemptId) : undefined;
      const canRestore = Boolean(task && baseline && (!replacement || replacement.id === admission.attempt.id) && (task.authoritativeAttemptId === null || (task.authoritativeAttemptId === admission.attempt.id && attempt?.status !== 'running')) && mission.currentTaskId === task.id && mission.workflow.approvedDesignRevisionId === admission.attempt.inputDesignRevisionId && mission.workspace.currentRevisionId === baseline!.id && (mission.workspace.revisionStatus === 'clean' || mission.workspace.revisionStatus === 'uncheckpointed'));
      if (canRestore) {
        try {
          await this.workspaces.restoreMissionRevision(mission.id, baseline!);
          const restored = await this.workspaces.inspectMissionWorkspace(mission.id, baseline!.contentHash, false);
          if (restored.state !== 'clean' || restored.contentHash !== baseline!.contentHash) throw new Error('Restored stale workspace hash does not match input checkpoint');
          workspaceRestored = true;
        } catch {
          mission.workspace.revisionStatus = 'uncheckpointed';
          mission.status = 'recovered_paused';
          workspaceQuarantined = true;
        }
      } else if (task?.authoritativeAttemptId !== admission.attempt.id || mission.workspace.revisionStatus !== 'clean') {
        mission.workspace.revisionStatus = 'uncheckpointed';
        if (mission.status !== 'completed' && mission.status !== 'failed' && mission.status !== 'cancelled') mission.status = 'recovered_paused';
        workspaceQuarantined = true;
      }
      if (!database.missionEvents.some((event) => event.type === 'attempt_result_discarded' && event.attemptId === admission.attempt.id)) addEvent(database, mission, 'attempt_result_discarded', { taskId: admission.task.id, attemptId: admission.attempt.id, agentId: admission.attempt.agentId }, { reason: 'workspace task authority changed', workspaceRestored, workspaceQuarantined });
    });
  }

  private async restoreAfterReferenceFailure(admission: Extract<MissionAdmission, { kind: 'admitted' }>, reason: string, result: RunnerResult | null): Promise<void> {
    const snapshot = this.store.snapshot();
    const mission = snapshot.missions.find((item) => item.id === admission.mission.id);
    const baseline = admission.attempt.inputWorkspaceRevisionId ? snapshot.missionWorkspaceRevisions.find((item) => item.id === admission.attempt.inputWorkspaceRevisionId) : undefined;
    const task = snapshot.missionTasks.find((item) => item.id === admission.task.id);
    const attempt = snapshot.taskAttempts.find((item) => item.id === admission.attempt.id);
    const run = snapshot.runs.find((item) => item.id === admission.run.id);
    if (!mission || !baseline || !task || !attempt || !run || !acceptMissionResult(task, attempt, run, { mission, currentArtifactIds: task.inputArtifactIds }).accepted) { await this.discardStaleResult(admission); return; }
    const restoration = await this.store.mutate(async (database) => {
      const currentMission = database.missions.find((item) => item.id === admission.mission.id);
      const currentTask = database.missionTasks.find((item) => item.id === admission.task.id);
      const currentAttempt = database.taskAttempts.find((item) => item.id === admission.attempt.id);
      const currentRun = database.runs.find((item) => item.id === admission.run.id);
      if (!currentMission || !currentTask || !currentAttempt || !currentRun || !acceptMissionResult(currentTask, currentAttempt, currentRun, { mission: currentMission, currentArtifactIds: currentTask.inputArtifactIds }).accepted) return { authoritative: false, restored: false };
      try {
        await this.workspaces.restoreMissionRevision(currentMission.id, baseline);
        const restored = await this.workspaces.inspectMissionWorkspace(currentMission.id, baseline.contentHash, false);
        if (restored.state !== 'clean' || restored.contentHash !== baseline.contentHash) throw new Error('Restored workspace hash does not match input checkpoint');
        return { authoritative: true, restored: true };
      } catch { return { authoritative: true, restored: false }; }
    });
    if (!restoration.authoritative) { await this.discardStaleResult(admission); return; }
    if (restoration.restored) await this.recordImplementationFailure(admission, new Error(reason), 'infrastructure', false, result);
    else await this.recordImplementationFailure(admission, new Error('Restored workspace hash does not match input checkpoint'), 'infrastructure', true, result);
  }

  private async recordImplementationFailure(admission: Extract<MissionAdmission, { kind: 'admitted' }>, error: Error, category: 'infrastructure' | 'cancelled', recovered = false, result: RunnerResult | null = null): Promise<void> {
    await this.store.mutate((database) => {
      const mission = database.missions.find((item) => item.id === admission.mission.id);
      const task = database.missionTasks.find((item) => item.id === admission.task.id);
      const attempt = database.taskAttempts.find((item) => item.id === admission.attempt.id);
      if (!mission || !task || !attempt || attempt.status !== 'running' || task.authoritativeAttemptId !== attempt.id) return;
      const timestamp = now();
      const safeMessage = safeMissionText(error.message, 4096, this.redactionSecrets).content;
      attempt.status = category === 'cancelled' ? 'cancelled' : 'failed';
      attempt.runtimeThreadId = result?.threadId ?? null;
      attempt.usage = result?.usage ?? null;
      attempt.error = { category, message: safeMessage };
      attempt.completedAt = timestamp;
      attempt.updatedAt = timestamp;
      task.status = 'failed';
      task.updatedAt = timestamp;
      mission.status = recovered ? 'recovered_paused' : 'paused';
      if (recovered) mission.workspace.revisionStatus = 'uncheckpointed';
      mission.updatedAt = timestamp;
      addEvent(database, mission, 'attempt_failed', { taskId: task.id, attemptId: attempt.id, agentId: attempt.agentId }, { category, reason: safeMessage, stage: task.stage });
    });
  }

  async continueMission(_missionId: string): Promise<void> { return; }
}
