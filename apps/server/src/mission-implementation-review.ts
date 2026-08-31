import type { Mission, MissionEvent, VerificationRun } from './types.js';

export interface CurrentImplementationPrecheck {
  run: VerificationRun;
  event: MissionEvent;
}

export function automaticImplementationRepairUsed(events: readonly MissionEvent[], missionId: string): boolean {
  return events.some((event) =>
    event.missionId === missionId &&
    event.type === 'repair_scheduled' &&
    event.details.trigger === 'automatic_precheck',
  );
}

export function humanImplementationRepairUsed(events: readonly MissionEvent[], missionId: string): boolean {
  return events.some((event) =>
    event.missionId === missionId &&
    event.type === 'repair_scheduled' &&
    event.details.trigger === 'human_review',
  );
}

function matchesCurrentImplementation(mission: Mission, run: VerificationRun): boolean {
  return run.missionId === mission.id &&
    run.designRevisionId === mission.workflow.approvedDesignRevisionId &&
    run.workspaceRevisionId === mission.workflow.implementedWorkspaceRevisionId;
}

export function currentPassedImplementationPrecheck(input: {
  mission: Mission;
  verificationRuns: readonly VerificationRun[];
  events: readonly MissionEvent[];
}): CurrentImplementationPrecheck | null {
  const { mission } = input;
  const runId = mission.workflow.currentVerificationRunId;
  if (!runId) return null;
  const run = input.verificationRuns.find((candidate) => candidate.id === runId) ?? null;
  if (!run || run.status !== 'passed' || !matchesCurrentImplementation(mission, run)) return null;
  const event = [...input.events].reverse().find((candidate) =>
    candidate.missionId === mission.id &&
    candidate.type === 'implementation_precheck_passed' &&
    candidate.details.verificationRunId === run.id &&
    candidate.details.designRevisionId === run.designRevisionId &&
    candidate.details.workspaceRevisionId === run.workspaceRevisionId,
  ) ?? null;
  return event ? { run, event } : null;
}

export function currentImplementationAcceptance(input: {
  mission: Mission;
  verificationRuns: readonly VerificationRun[];
  events: readonly MissionEvent[];
}): MissionEvent | null {
  const { mission } = input;
  const designRevisionId = mission.workflow.approvedDesignRevisionId;
  const workspaceRevisionId = mission.workflow.implementedWorkspaceRevisionId;
  if (!designRevisionId || !workspaceRevisionId) return null;
  return [...input.events].reverse().find((candidate) => {
    if (candidate.missionId !== mission.id || candidate.type !== 'implementation_review_accepted') return false;
    if (candidate.details.designRevisionId !== designRevisionId || candidate.details.workspaceRevisionId !== workspaceRevisionId) return false;
    const precheckId = candidate.details.precheckVerificationRunId;
    if (typeof precheckId !== 'string') return false;
    const precheck = input.verificationRuns.find((run) => run.id === precheckId);
    if (!precheck || precheck.status !== 'passed' || !matchesCurrentImplementation(mission, precheck)) return false;
    return input.events.some((event) => event.type === 'implementation_precheck_passed' && event.details.verificationRunId === precheck.id && event.details.designRevisionId === designRevisionId && event.details.workspaceRevisionId === workspaceRevisionId);
  }) ?? null;
}

function exactWorkspaceReady(input: {
  mission: Mission;
  workspaceState: 'clean' | 'changed' | 'unavailable' | 'unchecked_running';
}): boolean {
  return input.workspaceState === 'clean' &&
    input.mission.workspace.revisionStatus === 'clean' &&
    Boolean(input.mission.workflow.implementedWorkspaceRevisionId) &&
    input.mission.workspace.currentRevisionId === input.mission.workflow.implementedWorkspaceRevisionId;
}

export function implementationReviewAvailable(input: {
  mission: Mission;
  verificationRuns: readonly VerificationRun[];
  events: readonly MissionEvent[];
  workspaceState: 'clean' | 'changed' | 'unavailable' | 'unchecked_running';
}): CurrentImplementationPrecheck | null {
  if (input.mission.workflow.phase !== 'verifying' || input.mission.status !== 'paused') return null;
  if (!exactWorkspaceReady(input)) return null;
  if (currentImplementationAcceptance(input)) return null;
  return currentPassedImplementationPrecheck(input);
}

export function implementationChangeRequestRun(input: {
  mission: Mission;
  verificationRuns: readonly VerificationRun[];
  events: readonly MissionEvent[];
  workspaceState: 'clean' | 'changed' | 'unavailable' | 'unchecked_running';
}): VerificationRun | null {
  if (!exactWorkspaceReady(input) || input.mission.workflow.repairCycle >= input.mission.workflow.maxRepairCycles || humanImplementationRepairUsed(input.events, input.mission.id)) return null;
  const review = implementationReviewAvailable(input);
  if (review) return review.run;
  if (currentImplementationAcceptance(input)) return null;
  if (input.mission.workflow.phase !== 'awaiting_intervention' || input.mission.status !== 'blocked') return null;
  if (input.mission.workflow.repairCycle < 1 || !automaticImplementationRepairUsed(input.events, input.mission.id)) return null;
  const runId = input.mission.workflow.currentVerificationRunId;
  if (!runId) return null;
  const run = input.verificationRuns.find((candidate) => candidate.id === runId) ?? null;
  return run?.status === 'failed' && matchesCurrentImplementation(input.mission, run) ? run : null;
}
