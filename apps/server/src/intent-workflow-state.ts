import type { Agent, AgentRun, DesignRevision, IntentWorkflowPhase, IntentWorkflowState, Mission, MissionArtifact, MissionTask, MissionWorkspaceRevision, TaskAttempt, VerificationRun } from './types.js';
import { findReservingMission } from './mission-state.js';
import { resolveDesignReferenceMaterialization, type DesignReferenceMaterialization } from './design-reference-store.js';

export const DEFAULT_MAX_REPAIR_CYCLES = 2;

export type WorkflowRejection =
  | 'wrong_phase'
  | 'wrong_mission_status'
  | 'task_not_current'
  | 'task_stage_mismatch'
  | 'input_binding_mismatch'
  | 'attempt_not_authoritative'
  | 'revision_not_current'
  | 'revision_artifacts_invalid'
  | 'verification_not_current'
  | 'workspace_revision_mismatch'
  | 'repair_limit_reached'
  | 'verification_not_passed';

export type WorkflowDecision<T> =
  | { accepted: true; value: T }
  | { accepted: false; reason: WorkflowRejection };

const accepted = <T>(value: T): WorkflowDecision<T> => ({ accepted: true, value });
const rejected = (reason: WorkflowRejection): WorkflowDecision<never> => ({ accepted: false, reason });

export type ImplementationAdmissionRejection =
  | 'wrong_phase' | 'wrong_mission_status' | 'approval_missing' | 'approved_revision_not_current'
  | 'approved_revision_not_approved' | 'approved_revision_wrong_mission' | 'implementation_task_missing'
  | 'implementation_task_not_current' | 'implementation_task_binding_mismatch' | 'reference_artifacts_missing'
  | 'reference_binding_invalid' | 'reference_integrity_failed' | 'workspace_revision_missing'
  | 'workspace_revision_stale' | 'workspace_changed' | 'agent_not_assigned' | 'agent_not_reserved'
  | 'agent_not_ready' | 'task_not_pending' | 'authoritative_attempt_missing' | 'authoritative_run_missing'
  | 'recovery_limit_reached' | 'budget_exhausted';

export type ImplementationAdmissionDecision =
  | { accepted: true; materialization: DesignReferenceMaterialization }
  | { accepted: false; reason: ImplementationAdmissionRejection };

export type VerificationAdmissionRejection =
  | 'wrong_phase'
  | 'wrong_mission_status'
  | 'missing_binding'
  | 'workspace_revision_mismatch'
  | 'workspace_not_clean'
  | 'already_running'
  | 'already_passed'
  | 'semantic_failure_blocked';

export type VerificationAdmissionDecision =
  | { accepted: true; designRevisionId: string; workspaceRevisionId: string }
  | { accepted: false; reason: VerificationAdmissionRejection };

export function guardVerificationAdmission(input: {
  mission: Mission;
  currentVerification: VerificationRun | null;
  workspaceState: 'clean' | 'changed' | 'unavailable' | 'unchecked_running';
  implementationAccepted?: boolean;
}): VerificationAdmissionDecision {
  const { mission, currentVerification } = input;
  if (currentVerification?.status === 'failed' || mission.status === 'blocked' || mission.workflow.phase === 'awaiting_intervention') return { accepted: false, reason: 'semantic_failure_blocked' };
  if (mission.status === 'completed' || mission.workflow.phase === 'completed') return { accepted: false, reason: 'already_passed' };
  if (currentVerification?.status === 'passed' && !input.implementationAccepted) return { accepted: false, reason: 'already_passed' };
  if (mission.workflow.phase !== 'verifying') return { accepted: false, reason: 'wrong_phase' };
  if (!['paused', 'recovered_paused'].includes(mission.status)) {
    if (currentVerification && ['queued', 'running'].includes(currentVerification.status)) return { accepted: false, reason: 'already_running' };
    return { accepted: false, reason: 'wrong_mission_status' };
  }
  const designRevisionId = mission.workflow.approvedDesignRevisionId;
  const workspaceRevisionId = mission.workflow.implementedWorkspaceRevisionId;
  if (!designRevisionId || !workspaceRevisionId) return { accepted: false, reason: 'missing_binding' };
  if (mission.workspace.currentRevisionId !== workspaceRevisionId) return { accepted: false, reason: 'workspace_revision_mismatch' };
  if (mission.workspace.revisionStatus !== 'clean' || input.workspaceState !== 'clean') return { accepted: false, reason: 'workspace_not_clean' };
  if (currentVerification) {
    if (currentVerification.missionId !== mission.id || currentVerification.id !== mission.workflow.currentVerificationRunId || currentVerification.designRevisionId !== designRevisionId || currentVerification.workspaceRevisionId !== workspaceRevisionId) return { accepted: false, reason: 'missing_binding' };
    if (['queued', 'running'].includes(currentVerification.status)) return { accepted: false, reason: 'already_running' };
  }
  return { accepted: true, designRevisionId, workspaceRevisionId };
}

export interface ImplementationAdmissionFacts {
  missions: readonly Mission[];
  mission: Mission;
  tasks: readonly MissionTask[];
  revisions: readonly DesignRevision[];
  revision: DesignRevision | null;
  task: MissionTask | null;
  artifacts: readonly MissionArtifact[];
  workspaceRevision: MissionWorkspaceRevision | null;
  workspaceState: 'clean' | 'changed' | 'unavailable' | 'unchecked_running';
  workspaceRevisionStatus?: Mission['workspace']['revisionStatus'];
  agent: Agent | null;
  authoritativeAttempt: TaskAttempt | null;
  authoritativeRun: AgentRun | null;
  attempts: readonly TaskAttempt[];
  measuredTokens: number;
}

export function guardImplementationAdmission(input: ImplementationAdmissionFacts): ImplementationAdmissionDecision {
  const { mission } = input;
  if (mission.workflow.phase !== 'implementing') return { accepted: false, reason: 'wrong_phase' };
  if (!['paused', 'recovered_paused', 'running'].includes(mission.status)) return { accepted: false, reason: 'wrong_mission_status' };
  const approvedId = mission.workflow.approvedDesignRevisionId;
  if (!approvedId) return { accepted: false, reason: 'approval_missing' };
  if (mission.workflow.latestDesignRevisionId !== approvedId) return { accepted: false, reason: 'approved_revision_not_current' };
  if (!input.revision) return { accepted: false, reason: 'approved_revision_not_current' };
  if (input.revision.missionId !== mission.id) return { accepted: false, reason: 'approved_revision_wrong_mission' };
  const latest = [...input.revisions].filter((revision) => revision.missionId === mission.id).sort((left, right) => right.version - left.version)[0];
  if (!latest || latest.id !== approvedId || input.revision.id !== latest.id) return { accepted: false, reason: 'approved_revision_not_current' };
  if (input.revision.status !== 'approved' || !input.revision.approvedAt) return { accepted: false, reason: 'approved_revision_not_approved' };
  if (!input.task) return { accepted: false, reason: 'implementation_task_missing' };
  if (mission.currentTaskId !== input.task.id || input.task.stage !== 'implement') return { accepted: false, reason: 'implementation_task_not_current' };
  const implementationTasks = input.tasks.filter((task) => task.missionId === mission.id && task.stage === 'implement' && task.status !== 'stale' && task.status !== 'cancelled');
  if (implementationTasks.length !== 1 || implementationTasks[0]?.id !== input.task.id) return { accepted: false, reason: 'implementation_task_not_current' };
  if (input.task.authoritativeAttemptId) {
    if (!input.authoritativeAttempt || input.authoritativeAttempt.id !== input.task.authoritativeAttemptId || input.authoritativeAttempt.authorityVersion !== input.task.authorityVersion) return { accepted: false, reason: 'authoritative_attempt_missing' };
    if (!input.authoritativeRun || input.authoritativeRun.id !== input.authoritativeAttempt.runId) return { accepted: false, reason: 'authoritative_run_missing' };
  }
  const expectedArtifactIds = [input.revision.packageArtifactId, input.revision.previewArtifactId, input.revision.contractArtifactId];
  if (input.task.missionId !== mission.id || input.task.assignedAgentId !== mission.workflow.builderAgentId || input.task.inputDesignRevisionId !== approvedId || input.task.inputWorkspaceRevisionId !== mission.workspace.currentRevisionId || input.task.inputArtifactIds.length !== expectedArtifactIds.length || input.task.inputArtifactIds.some((id, index) => id !== expectedArtifactIds[index]) || input.task.status === 'stale' || input.task.status === 'completed' || input.task.status === 'cancelled') return { accepted: false, reason: 'implementation_task_binding_mismatch' };
  const materialization = resolveDesignReferenceMaterialization({ revision: input.revision, artifacts: input.artifacts });
  if (!materialization.ok) return { accepted: false, reason: materialization.reason };
  if (!input.workspaceRevision) return { accepted: false, reason: 'workspace_revision_missing' };
  if (input.workspaceRevision.missionId !== mission.id || input.workspaceRevision.id !== mission.workspace.currentRevisionId) return { accepted: false, reason: 'workspace_revision_stale' };
  if (mission.workspace.state !== 'ready') return { accepted: false, reason: 'workspace_revision_missing' };
  if (input.workspaceRevisionStatus === 'uncheckpointed') return { accepted: false, reason: 'workspace_revision_stale' };
  if (input.workspaceState === 'changed') return { accepted: false, reason: 'workspace_changed' };
  if (input.workspaceState !== 'clean') return { accepted: false, reason: 'workspace_revision_missing' };
  if (!input.agent || input.task.assignedAgentId !== input.agent.id) return { accepted: false, reason: 'agent_not_assigned' };
  const reservingMission = findReservingMission(input.missions, input.agent.id);
  if (!reservingMission || reservingMission.id !== mission.id) return { accepted: false, reason: 'agent_not_reserved' };
  if (input.agent.status !== 'ready') return { accepted: false, reason: 'agent_not_ready' };
  if (input.task.status !== 'pending') return { accepted: false, reason: 'task_not_pending' };
  if (input.attempts.filter((attempt) => attempt.taskId === input.task!.id).length >= 3) return { accepted: false, reason: 'recovery_limit_reached' };
  if (mission.tokenBudget !== null && input.measuredTokens >= mission.tokenBudget) return { accepted: false, reason: 'budget_exhausted' };
  return { accepted: true, materialization: materialization.materialization };
}

export function createIntentWorkflowState(input: { designerAgentId: string; builderAgentId: string; maxRepairCycles?: number }): IntentWorkflowState {
  return {
    phase: 'designing',
    designerAgentId: input.designerAgentId,
    builderAgentId: input.builderAgentId,
    latestDesignRevisionId: null,
    approvedDesignRevisionId: null,
    implementedWorkspaceRevisionId: null,
    currentVerificationRunId: null,
    repairCycle: 0,
    maxRepairCycles: input.maxRepairCycles ?? DEFAULT_MAX_REPAIR_CYCLES,
  };
}

function copyMission(mission: Mission, workflow: IntentWorkflowState, status?: Mission['status']): Mission {
  const next = structuredClone(mission);
  next.workflow = structuredClone(workflow);
  if (status) next.status = status;
  return next;
}

function exactTaskAttempt(task: MissionTask, attempt: TaskAttempt, stage: MissionTask['stage']): boolean {
  return task.authoritativeAttemptId === attempt.id &&
    task.authorityVersion === attempt.authorityVersion &&
    attempt.status === 'running' &&
    attempt.missionId === task.missionId &&
    attempt.taskId === task.id &&
    attempt.agentId === task.assignedAgentId &&
    task.stage === stage &&
    attempt.stage === stage &&
    attempt.inputDesignRevisionId === task.inputDesignRevisionId &&
    attempt.inputVerificationRunId === task.inputVerificationRunId &&
    attempt.inputWorkspaceRevisionId === task.inputWorkspaceRevisionId &&
    attempt.repairCycle === task.repairCycle;
}

export function guardAgentStageAdmission(input: {
  mission: Mission;
  task: MissionTask;
  stage: MissionTask['stage'];
  designRevisionId?: string | null;
  verificationRunId?: string | null;
  workspaceRevisionId?: string | null;
  repairCycle?: number | null;
}): WorkflowDecision<true> {
  const expectedPhase: Record<MissionTask['stage'], IntentWorkflowPhase> = {
    design: 'designing',
    implement: 'implementing',
    repair: 'repairing',
  };
  if (input.mission.workflow.phase !== expectedPhase[input.stage]) return rejected('wrong_phase');
  if (!['pending', 'running', 'paused', 'recovered_paused'].includes(input.mission.status)) return rejected('wrong_mission_status');
  if (input.mission.currentTaskId !== input.task.id) return rejected('task_not_current');
  if (input.task.stage !== input.stage) return rejected('task_stage_mismatch');
  if (input.stage === 'implement' && (input.mission.workflow.approvedDesignRevisionId === null || input.task.inputDesignRevisionId !== input.mission.workflow.approvedDesignRevisionId)) return rejected('input_binding_mismatch');
  if (input.stage === 'repair' && (input.mission.workflow.approvedDesignRevisionId === null || input.mission.workflow.currentVerificationRunId === null || input.task.inputDesignRevisionId !== input.mission.workflow.approvedDesignRevisionId || input.task.inputVerificationRunId !== input.mission.workflow.currentVerificationRunId || input.task.repairCycle !== input.mission.workflow.repairCycle)) return rejected('input_binding_mismatch');
  if (input.designRevisionId !== undefined && input.task.inputDesignRevisionId !== input.designRevisionId) return rejected('input_binding_mismatch');
  if (input.verificationRunId !== undefined && input.task.inputVerificationRunId !== input.verificationRunId) return rejected('input_binding_mismatch');
  if (input.workspaceRevisionId !== undefined && input.task.inputWorkspaceRevisionId !== input.workspaceRevisionId) return rejected('input_binding_mismatch');
  if (input.repairCycle !== undefined && input.task.repairCycle !== input.repairCycle) return rejected('input_binding_mismatch');
  return accepted(true);
}

export function acceptDesignRevision(input: {
  mission: Mission;
  task: MissionTask;
  attempt: TaskAttempt;
  revision: DesignRevision;
  requiredArtifactsPresent: boolean;
  hashesMatch: boolean;
}): WorkflowDecision<{ mission: Mission; task: MissionTask }> {
  if (!exactTaskAttempt(input.task, input.attempt, 'design') || input.mission.workflow.phase !== 'designing') return rejected('attempt_not_authoritative');
  if (input.revision.missionId !== input.mission.id || input.revision.sourceTaskId !== input.task.id || input.revision.sourceAttemptId !== input.attempt.id || input.revision.status !== 'draft') return rejected('input_binding_mismatch');
  if (!input.requiredArtifactsPresent || !input.hashesMatch) return rejected('revision_artifacts_invalid');
  const workflow = { ...input.mission.workflow, phase: 'awaiting_approval' as const, latestDesignRevisionId: input.revision.id };
  const mission = copyMission(input.mission, workflow, 'paused');
  mission.currentTaskId = null;
  const task = structuredClone(input.task);
  task.status = 'completed';
  task.authoritativeAttemptId = null;
  task.outputWorkspaceRevisionId = input.attempt.outputWorkspaceRevisionId;
  return accepted({ mission, task });
}

export function requestDesignRevision(input: { mission: Mission; revisionId: string }): WorkflowDecision<IntentWorkflowState> {
  if (input.mission.workflow.phase !== 'awaiting_approval' || input.mission.workflow.latestDesignRevisionId !== input.revisionId) return rejected('revision_not_current');
  return accepted({ ...structuredClone(input.mission.workflow), phase: 'designing', latestDesignRevisionId: input.revisionId });
}

export function approveDesignRevision(input: {
  mission: Mission;
  revision: DesignRevision;
  requiredArtifactsPresent: boolean;
  hashesMatch: boolean;
}): WorkflowDecision<IntentWorkflowState> {
  const workflow = input.mission.workflow;
  if (workflow.phase !== 'awaiting_approval' || workflow.latestDesignRevisionId !== input.revision.id || input.revision.missionId !== input.mission.id || input.revision.status !== 'draft') return rejected('revision_not_current');
  if (!input.requiredArtifactsPresent || !input.hashesMatch) return rejected('revision_artifacts_invalid');
  return accepted({ ...structuredClone(workflow), phase: 'implementing', approvedDesignRevisionId: input.revision.id });
}

export function acceptImplementationCompletion(input: {
  mission: Mission;
  task: MissionTask;
  attempt: TaskAttempt;
  outputWorkspaceRevisionId: string;
}): WorkflowDecision<{ mission: Mission; task: MissionTask }> {
  const workflow = input.mission.workflow;
  if (workflow.phase !== 'implementing' || workflow.approvedDesignRevisionId === null) return rejected('wrong_phase');
  if (!exactTaskAttempt(input.task, input.attempt, 'implement') || input.task.inputDesignRevisionId !== workflow.approvedDesignRevisionId || input.attempt.inputDesignRevisionId !== workflow.approvedDesignRevisionId) return rejected('attempt_not_authoritative');
  const nextWorkflow = { ...structuredClone(workflow), phase: 'verifying' as const, implementedWorkspaceRevisionId: input.outputWorkspaceRevisionId, currentVerificationRunId: null };
  const mission = copyMission(input.mission, nextWorkflow, 'paused');
  mission.currentTaskId = null;
  const task = structuredClone(input.task);
  task.status = 'completed';
  task.authoritativeAttemptId = null;
  task.outputWorkspaceRevisionId = input.outputWorkspaceRevisionId;
  return accepted({ mission, task });
}

export function startVerification(input: { mission: Mission; verification: VerificationRun }): WorkflowDecision<IntentWorkflowState> {
  const workflow = input.mission.workflow;
  if (workflow.phase !== 'verifying' || !workflow.approvedDesignRevisionId || !workflow.implementedWorkspaceRevisionId) return rejected('wrong_phase');
  if (input.verification.missionId !== input.mission.id || input.verification.designRevisionId !== workflow.approvedDesignRevisionId || input.verification.workspaceRevisionId !== workflow.implementedWorkspaceRevisionId) return rejected('input_binding_mismatch');
  return accepted({ ...structuredClone(workflow), currentVerificationRunId: input.verification.id });
}

export function acceptVerificationOutcome(input: {
  mission: Mission;
  verification: VerificationRun;
  implementationAccepted: boolean;
  automaticRepairAlreadyUsed: boolean;
}): WorkflowDecision<{ mission: Mission; repairCycle: number; requestRepairTask: boolean }> {
  const workflow = input.mission.workflow;
  if (input.mission.status !== 'running' || workflow.phase !== 'verifying' || workflow.currentVerificationRunId !== input.verification.id || input.verification.missionId !== input.mission.id || input.verification.designRevisionId !== workflow.approvedDesignRevisionId || input.verification.workspaceRevisionId !== workflow.implementedWorkspaceRevisionId) return rejected('verification_not_current');
  if (!['passed', 'failed', 'error'].includes(input.verification.status)) return rejected('verification_not_current');
  if (input.verification.status === 'passed') {
    if (!input.implementationAccepted) {
      const mission = copyMission(input.mission, structuredClone(workflow), 'paused');
      mission.currentTaskId = null;
      return accepted({ mission, repairCycle: workflow.repairCycle, requestRepairTask: false });
    }
    const mission = copyMission(input.mission, structuredClone(workflow), 'paused');
    mission.currentTaskId = null;
    return accepted({ mission, repairCycle: workflow.repairCycle, requestRepairTask: false });
  }
  if (input.verification.status === 'error') {
    const mission = copyMission(input.mission, structuredClone(workflow), 'paused');
    mission.currentTaskId = null;
    return accepted({ mission, repairCycle: workflow.repairCycle, requestRepairTask: false });
  }
  if (!input.implementationAccepted && !input.automaticRepairAlreadyUsed && workflow.repairCycle === 0 && workflow.repairCycle < workflow.maxRepairCycles) {
    const repairCycle = workflow.repairCycle + 1;
    const mission = copyMission(input.mission, { ...structuredClone(workflow), phase: 'repairing', repairCycle }, 'paused');
    mission.currentTaskId = null;
    return accepted({ mission, repairCycle, requestRepairTask: true });
  }
  const mission = copyMission(input.mission, { ...structuredClone(workflow), phase: 'awaiting_intervention' }, 'blocked');
  mission.currentTaskId = null;
  return accepted({ mission, repairCycle: workflow.repairCycle, requestRepairTask: false });
}

export function completeMissionAfterPublication(input: { mission: Mission; verification: VerificationRun; publicationPublished: boolean }): WorkflowDecision<Mission> {
  const workflow = input.mission.workflow;
  if (!input.publicationPublished || input.mission.status !== 'paused' || workflow.phase !== 'verifying' || workflow.currentVerificationRunId !== input.verification.id || input.verification.status !== 'passed' || input.verification.designRevisionId !== workflow.approvedDesignRevisionId || input.verification.workspaceRevisionId !== workflow.implementedWorkspaceRevisionId) return rejected('verification_not_current');
  const mission = copyMission(input.mission, { ...structuredClone(workflow), phase: 'completed' }, 'completed');
  mission.currentTaskId = null;
  return accepted(mission);
}

export function prepareImplementationRepair(input: {
  mission: Mission;
  verification: VerificationRun;
  implementationAccepted: boolean;
  automaticRepairAlreadyUsed: boolean;
  humanRepairAlreadyUsed: boolean;
}): WorkflowDecision<{ mission: Mission; repairCycle: number }> {
  const workflow = input.mission.workflow;
  if (input.verification.missionId !== input.mission.id || input.verification.designRevisionId !== workflow.approvedDesignRevisionId || input.verification.workspaceRevisionId !== workflow.implementedWorkspaceRevisionId) return rejected('verification_not_current');
  if (workflow.currentVerificationRunId !== input.verification.id) return rejected('verification_not_current');
  if (!workflow.implementedWorkspaceRevisionId || input.mission.workspace.currentRevisionId !== workflow.implementedWorkspaceRevisionId || input.mission.workspace.revisionStatus !== 'clean') return rejected('workspace_revision_mismatch');
  if (workflow.repairCycle >= workflow.maxRepairCycles) return rejected('repair_limit_reached');
  if (input.humanRepairAlreadyUsed) return rejected('repair_limit_reached');
  if (input.implementationAccepted) return rejected('verification_not_passed');
  const passedReview = workflow.phase === 'verifying' && input.mission.status === 'paused' && input.verification.status === 'passed';
  const failedAfterAutomaticRepair = workflow.phase === 'awaiting_intervention' &&
    input.mission.status === 'blocked' &&
    input.verification.status === 'failed' &&
    workflow.repairCycle > 0 &&
    input.automaticRepairAlreadyUsed;
  if (!passedReview && !failedAfterAutomaticRepair) {
    if (!['verifying', 'awaiting_intervention'].includes(workflow.phase) || !['paused', 'blocked'].includes(input.mission.status)) return rejected('wrong_phase');
    return rejected('verification_not_passed');
  }
  const repairCycle = workflow.repairCycle + 1;
  const mission = copyMission(input.mission, { ...structuredClone(workflow), phase: 'repairing', repairCycle }, 'paused');
  mission.currentTaskId = null;
  return accepted({ mission, repairCycle });
}

export function acceptRepairCompletion(input: {
  mission: Mission;
  task: MissionTask;
  attempt: TaskAttempt;
  outputWorkspaceRevisionId: string;
}): WorkflowDecision<{ mission: Mission; task: MissionTask }> {
  const workflow = input.mission.workflow;
  if (workflow.phase !== 'repairing' || !workflow.approvedDesignRevisionId || !workflow.currentVerificationRunId) return rejected('wrong_phase');
  if (!exactTaskAttempt(input.task, input.attempt, 'repair') || input.task.inputDesignRevisionId !== workflow.approvedDesignRevisionId || input.task.inputVerificationRunId !== workflow.currentVerificationRunId || input.task.repairCycle !== workflow.repairCycle) return rejected('attempt_not_authoritative');
  const mission = copyMission(input.mission, { ...structuredClone(workflow), phase: 'verifying', implementedWorkspaceRevisionId: input.outputWorkspaceRevisionId, currentVerificationRunId: null }, 'paused');
  mission.currentTaskId = null;
  const task = structuredClone(input.task);
  task.status = 'completed';
  task.authoritativeAttemptId = null;
  task.outputWorkspaceRevisionId = input.outputWorkspaceRevisionId;
  return accepted({ mission, task });
}

export function recoverInterruptedWorkflow(input: { mission: Mission; attempt: TaskAttempt }): WorkflowDecision<Mission> {
  if (input.attempt.missionId !== input.mission.id || input.attempt.status !== 'running') return rejected('attempt_not_authoritative');
  return accepted(copyMission(input.mission, input.mission.workflow, 'recovered_paused'));
}

export function invalidateForNewDesign(input: { mission: Mission; consumedDesignRevisionId: string }): WorkflowDecision<{ state: IntentWorkflowState; staleVerificationRunId: string | null; staleWorkspaceRevisionId: string | null }> {
  const workflow = input.mission.workflow;
  if (workflow.approvedDesignRevisionId !== input.consumedDesignRevisionId && workflow.latestDesignRevisionId !== input.consumedDesignRevisionId) return rejected('revision_not_current');
  return accepted({ state: { ...structuredClone(workflow), phase: 'designing', approvedDesignRevisionId: null, implementedWorkspaceRevisionId: null, currentVerificationRunId: null }, staleVerificationRunId: workflow.currentVerificationRunId, staleWorkspaceRevisionId: workflow.implementedWorkspaceRevisionId });
}

export function canCompleteMission(input: { mission: Mission; verification: VerificationRun | null }): boolean {
  const workflow = input.mission.workflow;
  return workflow.phase === 'completed' && input.mission.status === 'completed' && input.verification !== null && input.verification.id === workflow.currentVerificationRunId && input.verification.status === 'passed' && input.verification.designRevisionId === workflow.approvedDesignRevisionId && input.verification.workspaceRevisionId === workflow.implementedWorkspaceRevisionId;
}
