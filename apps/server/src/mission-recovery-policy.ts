import { guardVerificationAdmission, type VerificationAdmissionDecision } from './intent-workflow-state.js';
import { findReservingMission, isStartupInterruptedDesignAttempt, isTerminalMissionStatus, MAX_ATTEMPTS_PER_TASK } from './mission-state.js';
import type { Agent, AgentRun, Mission, MissionRecoveryCommand, MissionTask, MissionWorkspaceRevision, TaskAttempt, VerificationRun } from './types.js';

type Denied = { allowed: false; reason: string };
export interface MissionRecoveryCapabilities {
  retryCurrentDesign: { allowed: true; taskId: string; attemptId: string; inputWorkspaceRevisionId: string } | Denied;
  resumeImplementation: { allowed: true; taskId: string; attemptId: string; runId: string; inputWorkspaceRevisionId: string; designRevisionId: string } | Denied;
  retryVerification: { allowed: true; verificationRunId: string; designRevisionId: string; workspaceRevisionId: string } | Denied;
  stopPreserving: { allowed: boolean; reason: string | null };
  verificationAdmission: VerificationAdmissionDecision;
}

export interface MissionRecoveryFacts {
  missions: readonly Mission[];
  mission: Mission;
  currentTask: MissionTask | null;
  attempts: readonly TaskAttempt[];
  runs: readonly AgentRun[];
  currentVerification: VerificationRun | null;
  workspaceRevision: MissionWorkspaceRevision | null;
  workspaceState: 'clean' | 'changed' | 'unavailable' | 'unchecked_running';
  assignedAgent: Agent | null;
  measuredTokens: number;
  activeCommand: MissionRecoveryCommand | null;
}

const deny = (reason: string): Denied => ({ allowed: false, reason });

export function deriveMissionRecoveryCapabilities(input: MissionRecoveryFacts): MissionRecoveryCapabilities {
  const { mission, currentTask, activeCommand } = input;
  const verificationAdmission = guardVerificationAdmission({ mission, currentVerification: input.currentVerification, workspaceState: input.workspaceState });
  let retryCurrentDesign: MissionRecoveryCapabilities['retryCurrentDesign'] = deny('Current Design attempt is not retryable.');
  const pointedAttempt = currentTask?.authoritativeAttemptId ? input.attempts.find((item) => item.id === currentTask.authoritativeAttemptId) ?? null : null;
  const interruptedCandidates = currentTask && !currentTask.authoritativeAttemptId
    ? input.attempts.filter((item) => item.taskId === currentTask.id && isStartupInterruptedDesignAttempt(currentTask, item))
    : [];
  const attempt = pointedAttempt ?? (interruptedCandidates.length === 1 ? interruptedCandidates[0] : null);
  if (isTerminalMissionStatus(mission.status)) retryCurrentDesign = deny('Mission is terminal.');
  else if (activeCommand) retryCurrentDesign = deny('Another recovery command is applying.');
  else if (mission.workflow.phase !== 'designing' || !['paused', 'recovered_paused'].includes(mission.status)) retryCurrentDesign = deny('Mission is not paused in Design.');
  else if (!currentTask || mission.currentTaskId !== currentTask.id || currentTask.stage !== 'design') retryCurrentDesign = deny('Current task is not Design.');
  else if (!attempt || attempt.missionId !== mission.id || attempt.taskId !== currentTask.id || attempt.agentId !== currentTask.assignedAgentId || !(attempt.authorityVersion === currentTask.authorityVersion || isStartupInterruptedDesignAttempt(currentTask, attempt)) || !['failed', 'cancelled', 'interrupted'].includes(attempt.status) || !['failed', 'interrupted'].includes(currentTask.status)) retryCurrentDesign = deny('No authoritative failed Design attempt exists.');
  else if (input.attempts.some((item) => item.taskId === currentTask.id && item.status === 'running')) retryCurrentDesign = deny('The authoritative Design attempt is still running.');
  else if (!currentTask.inputWorkspaceRevisionId || !input.workspaceRevision || input.workspaceRevision.id !== currentTask.inputWorkspaceRevisionId || input.workspaceRevision.missionId !== mission.id) retryCurrentDesign = deny('The exact Design input checkpoint is unavailable.');
  else if (mission.workspace.owner !== 'conductor' || mission.workspace.state !== 'ready' || mission.workspace.currentRevisionId !== currentTask.inputWorkspaceRevisionId || mission.workspace.revisionStatus !== 'clean' || input.workspaceState !== 'clean') retryCurrentDesign = deny('Mission workspace is not clean at the Design input checkpoint.');
  else if (input.attempts.filter((item) => item.taskId === currentTask.id).length >= MAX_ATTEMPTS_PER_TASK) retryCurrentDesign = deny('Design retry limit reached.');
  else if (mission.tokenBudget !== null && input.measuredTokens >= mission.tokenBudget) retryCurrentDesign = deny('Mission token budget is exhausted.');
  else if (!input.assignedAgent || input.assignedAgent.id !== currentTask.assignedAgentId || input.assignedAgent.status !== 'ready' || findReservingMission(input.missions, input.assignedAgent.id)?.id !== mission.id) retryCurrentDesign = deny('Assigned Designer is not available and reserved for this Mission.');
  else retryCurrentDesign = { allowed: true, taskId: currentTask.id, attemptId: attempt.id, inputWorkspaceRevisionId: currentTask.inputWorkspaceRevisionId };

  let resumeImplementation: MissionRecoveryCapabilities['resumeImplementation'] = deny('Current Builder result does not have a recoverable finalization checkpoint.');
  const implementationRun = attempt?.runId ? input.runs.find((item) => item.id === attempt.runId) ?? null : null;
  if (isTerminalMissionStatus(mission.status)) resumeImplementation = deny('Mission is terminal.');
  else if (activeCommand) resumeImplementation = deny('Another recovery command is applying.');
  else if (mission.workflow.phase !== 'implementing' || mission.status !== 'recovered_paused') resumeImplementation = deny('Mission is not paused after Builder finalization failure.');
  else if (!currentTask || mission.currentTaskId !== currentTask.id || currentTask.stage !== 'implement') resumeImplementation = deny('Current task is not the implementation task.');
  else if (!attempt || currentTask.authoritativeAttemptId !== attempt.id || attempt.stage !== 'implement' || attempt.status !== 'failed' || attempt.error?.category !== 'infrastructure') resumeImplementation = deny('No authoritative Builder infrastructure-finalization failure exists.');
  else if (!implementationRun || implementationRun.status !== 'completed' || implementationRun.error !== null || implementationRun.context.kind !== 'mission' || implementationRun.context.missionId !== mission.id || implementationRun.context.taskId !== currentTask.id || implementationRun.context.attemptId !== attempt.id) resumeImplementation = deny('The Builder AgentRun did not complete successfully.');
  else if (currentTask.status !== 'failed' || mission.workspace.revisionStatus !== 'uncheckpointed' || mission.workspace.state !== 'ready' || mission.workspace.owner !== 'conductor') resumeImplementation = deny('Mission workspace is not awaiting deterministic Builder finalization.');
  else if (!attempt.inputWorkspaceRevisionId || !input.workspaceRevision || input.workspaceRevision.id !== attempt.inputWorkspaceRevisionId || currentTask.inputWorkspaceRevisionId !== attempt.inputWorkspaceRevisionId || mission.workspace.currentRevisionId !== attempt.inputWorkspaceRevisionId) resumeImplementation = deny('The exact Builder input workspace revision is no longer current.');
  else if (!attempt.inputDesignRevisionId || mission.workflow.approvedDesignRevisionId !== attempt.inputDesignRevisionId || currentTask.inputDesignRevisionId !== attempt.inputDesignRevisionId || mission.workflow.implementedWorkspaceRevisionId !== null || mission.workflow.currentVerificationRunId !== null) resumeImplementation = deny('The exact approved DesignRevision binding is no longer current.');
  else if (!input.assignedAgent || input.assignedAgent.id !== currentTask.assignedAgentId || attempt.agentId !== currentTask.assignedAgentId || findReservingMission(input.missions, currentTask.assignedAgentId)?.id !== mission.id) resumeImplementation = deny('The Builder participant binding is no longer reserved by this Mission.');
  else resumeImplementation = { allowed: true, taskId: currentTask.id, attemptId: attempt.id, runId: implementationRun.id, inputWorkspaceRevisionId: attempt.inputWorkspaceRevisionId, designRevisionId: attempt.inputDesignRevisionId };

  let retryVerification: MissionRecoveryCapabilities['retryVerification'] = deny('Current verification is not retryable.');
  if (activeCommand) retryVerification = deny('Another recovery command is applying.');
  else if (!input.currentVerification || input.currentVerification.status !== 'error') retryVerification = deny('Only verifier infrastructure errors can be retried.');
  else if (!verificationAdmission.accepted) retryVerification = deny(`Verification retry denied: ${verificationAdmission.reason}.`);
  else retryVerification = { allowed: true, verificationRunId: input.currentVerification.id, designRevisionId: verificationAdmission.designRevisionId, workspaceRevisionId: verificationAdmission.workspaceRevisionId };

  const authoritativeRunning = input.attempts.some((item) => item.missionId === mission.id && item.status === 'running' && input.currentTask?.authoritativeAttemptId === item.id);
  const verificationRunning = input.currentVerification !== null && ['queued', 'running'].includes(input.currentVerification.status);
  const stopAllowed = !isTerminalMissionStatus(mission.status) && !activeCommand && !authoritativeRunning && !verificationRunning;
  return { retryCurrentDesign, resumeImplementation, retryVerification, stopPreserving: { allowed: stopAllowed, reason: stopAllowed ? null : 'Mission cannot stop while terminal, recovering, or actively executing.' }, verificationAdmission };
}
