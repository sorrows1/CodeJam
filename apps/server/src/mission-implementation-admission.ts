import { summarizeMissionUsage } from './mission-budget.js';
import {
  guardImplementationAdmission,
  type ImplementationAdmissionDecision,
  type ImplementationAdmissionFacts,
  type ImplementationAdmissionRejection,
} from './intent-workflow-state.js';
import type { Database, Mission } from './types.js';

export type MissionWorkspaceInspectionState = ImplementationAdmissionFacts['workspaceState'];

export interface ImplementationAdmissionView {
  allowed: boolean;
  reason: ImplementationAdmissionRejection | null;
  message: string | null;
}

const messages: Record<ImplementationAdmissionRejection, string> = {
  wrong_phase: 'The Mission is not at the build step right now.',
  wrong_mission_status: 'The Mission is not in a state where the Builder can run.',
  approval_missing: 'Approve the current design before starting the Builder.',
  approved_revision_not_current: 'The design you approved is no longer the latest design.',
  approved_revision_not_approved: 'The selected design no longer has a valid approval.',
  approved_revision_wrong_mission: 'The approved design belongs to a different Mission.',
  implementation_task_missing: 'The build step is unavailable.',
  implementation_task_not_current: 'This build step is no longer current.',
  implementation_task_binding_mismatch: 'This build no longer matches the approved design and saved starting workspace.',
  reference_artifacts_missing: 'Part of the approved design reference is missing.',
  reference_binding_invalid: 'The approved design reference no longer matches this Mission.',
  reference_integrity_failed: 'Conductor could not verify the approved design reference.',
  workspace_revision_missing: 'The saved starting workspace for this build is unavailable.',
  workspace_revision_stale: 'The saved starting workspace is no longer current.',
  workspace_changed: 'The workspace changed after this build was approved.',
  agent_not_assigned: 'The assigned Builder is unavailable.',
  agent_not_reserved: 'The assigned Builder is no longer reserved for this Mission.',
  agent_not_ready: 'The assigned Builder is not ready.',
  task_not_pending: 'This build cannot be started now.',
  authoritative_attempt_missing: 'Conductor cannot identify the current Builder attempt safely.',
  authoritative_run_missing: 'Conductor cannot identify the current Builder run safely.',
  recovery_limit_reached: 'The allowed Builder attempt limit has been reached.',
  budget_exhausted: 'This Mission has reached its token limit.',
};

export function implementationAdmissionMessage(reason: ImplementationAdmissionRejection): string {
  return messages[reason];
}

export function buildImplementationAdmissionFacts(input: {
  database: Database;
  mission: Mission;
  workspaceState: MissionWorkspaceInspectionState;
}): ImplementationAdmissionFacts {
  const { database, mission } = input;
  const task = database.missionTasks.find((item) => item.id === mission.currentTaskId && item.missionId === mission.id) ?? null;
  const revision = mission.workflow.approvedDesignRevisionId
    ? database.designRevisions.find((item) => item.id === mission.workflow.approvedDesignRevisionId) ?? null
    : null;
  const workspaceRevision = task?.inputWorkspaceRevisionId
    ? database.missionWorkspaceRevisions.find((item) => item.id === task.inputWorkspaceRevisionId) ?? null
    : null;
  const agent = task ? database.agents.find((item) => item.id === task.assignedAgentId) ?? null : null;
  const authoritativeAttempt = task?.authoritativeAttemptId
    ? database.taskAttempts.find((item) => item.id === task.authoritativeAttemptId) ?? null
    : null;
  const authoritativeRun = authoritativeAttempt?.runId
    ? database.runs.find((item) => item.id === authoritativeAttempt.runId) ?? null
    : null;

  return {
    missions: database.missions,
    mission,
    tasks: database.missionTasks,
    revisions: database.designRevisions,
    revision,
    task,
    artifacts: database.missionArtifacts,
    workspaceRevision,
    workspaceState: input.workspaceState,
    workspaceRevisionStatus: mission.workspace.revisionStatus,
    agent,
    authoritativeAttempt,
    authoritativeRun,
    attempts: database.taskAttempts.filter((item) => item.missionId === mission.id),
    measuredTokens: summarizeMissionUsage(mission.id, database.runs).totalTokens,
  };
}

export function decideImplementationAdmission(
  facts: ImplementationAdmissionFacts,
  referenceIntegrityVerified = true,
): ImplementationAdmissionDecision {
  const decision = guardImplementationAdmission(facts);
  if (decision.accepted && !referenceIntegrityVerified) {
    return { accepted: false, reason: 'reference_integrity_failed' };
  }
  return decision;
}

export function projectImplementationAdmission(decision: ImplementationAdmissionDecision): ImplementationAdmissionView {
  if (decision.accepted) return { allowed: true, reason: null, message: null };
  return { allowed: false, reason: decision.reason, message: implementationAdmissionMessage(decision.reason) };
}
