import { canCompleteMission } from './intent-workflow-state.js';
import { currentImplementationAcceptance, currentPassedImplementationPrecheck, implementationChangeRequestRun } from './mission-implementation-review.js';
import type { ImplementationAdmissionView } from './mission-implementation-admission.js';
import type { MissionRecoveryCapabilities } from './mission-recovery-policy.js';
import type { DesignRevision, Mission, MissionEvent, MissionTask, TaskAttempt, VerificationRun } from './types.js';

export type MissionPrimaryActionId = 'generate_design' | 'retry_design' | 'approve_design' | 'run_builder' | 'finalize_build' | 'start_verification' | 'retry_verification' | 'run_repair' | 'accept_implementation';
export interface MissionRailStep { id: 'intent' | 'design' | 'approval' | 'build' | 'review' | 'verify'; label: string; state: 'complete' | 'current' | 'upcoming'; }
export interface MissionFailureView { source: 'attempt' | 'verification' | 'inconsistency'; category: 'agent' | 'infrastructure' | 'interrupted' | 'verification_failed' | 'verification_error' | 'inconsistent'; title: string; message: string; }
export interface MissionImplementationReviewView {
  precheckVerificationRunId: string | null;
  accepted: boolean;
  canRequestChanges: boolean;
  requestChangesReason: string | null;
}
export interface MissionProductView {
  state: 'designing' | 'approval_required' | 'implementation_unlocked' | 'implementation_blocked' | 'building' | 'implementation_checking' | 'implementation_review' | 'repairing' | 'awaiting_verification' | 'verifying' | 'verification_failed' | 'verification_error' | 'complete' | 'stopped' | 'degraded';
  currentStage: 'design' | 'approval' | 'build' | 'review' | 'verify' | 'complete';
  headline: string;
  explanation: string;
  rail: MissionRailStep[];
  implementationLock: 'locked' | 'unlocked';
  implementationAdmission: ImplementationAdmissionView;
  implementationReview: MissionImplementationReviewView;
  completionAuthority: 'pending' | 'denied' | 'authorized';
  failure: MissionFailureView | null;
  primaryAction: { id: MissionPrimaryActionId } | null;
}

export interface MissionPresentationFacts {
  mission: Mission;
  tasks: readonly MissionTask[];
  attempts: readonly TaskAttempt[];
  designRevisions: readonly DesignRevision[];
  verificationRuns: readonly VerificationRun[];
  events: readonly MissionEvent[];
  recovery: MissionRecoveryCapabilities;
  implementationAdmission: ImplementationAdmissionView;
  workspaceState: 'clean' | 'changed' | 'unavailable' | 'unchecked_running';
}

const steps = [
  ['intent', 'Request'], ['design', 'Design'], ['approval', 'Approve'], ['build', 'Build'], ['review', 'Review result'], ['verify', 'Final check'],
] as const;

function rail(currentStage: MissionProductView['currentStage']): MissionRailStep[] {
  const current = currentStage === 'design' ? 1 : currentStage === 'approval' ? 2 : currentStage === 'build' ? 3 : currentStage === 'review' ? 4 : currentStage === 'verify' ? 5 : 6;
  return steps.map(([id, label], index) => ({ id, label, state: currentStage === 'complete' || index < current ? 'complete' : index === current ? 'current' : 'upcoming' }));
}

function attemptFailure(attempt: TaskAttempt | null): MissionFailureView | null {
  if (!attempt?.error) return null;
  const category = attempt.error.category === 'agent' ? 'agent' : attempt.error.category === 'interrupted' || attempt.status === 'interrupted' ? 'interrupted' : 'infrastructure';
  const title = category === 'agent' ? 'Agent step failed' : category === 'interrupted' ? 'Run interrupted' : 'Infrastructure problem';
  return { source: 'attempt', category, title, message: attempt.error.message };
}

function verificationFailure(run: VerificationRun | null): MissionFailureView | null {
  if (run?.status === 'failed') {
    const failed = run.checks.filter((check) => !check.passed);
    return {
      source: 'verification',
      category: 'verification_failed',
      title: 'Built app did not meet the approved requirements',
      message: failed.length ? failed.map((check) => `${check.label}: ${check.details}`).join(' · ') : 'The real application did not meet the approved requirements.',
    };
  }
  if (run?.status === 'error') return { source: 'verification', category: 'verification_error', title: 'Verification could not run', message: run.error?.message ?? 'The independent checker could not finish.' };
  return null;
}

function reviewView(input: MissionPresentationFacts): MissionImplementationReviewView {
  const precheck = currentPassedImplementationPrecheck({ mission: input.mission, verificationRuns: input.verificationRuns, events: input.events });
  const accepted = Boolean(currentImplementationAcceptance({ mission: input.mission, verificationRuns: input.verificationRuns, events: input.events }));
  const changeRequestRun = implementationChangeRequestRun({ mission: input.mission, verificationRuns: input.verificationRuns, events: input.events, workspaceState: input.workspaceState });
  const canRequestChanges = Boolean(changeRequestRun) && !accepted;
  let requestChangesReason: string | null = null;
  if (!canRequestChanges) {
    if (accepted) requestChangesReason = 'You already accepted this built version.';
    else if (input.mission.workflow.repairCycle >= input.mission.workflow.maxRepairCycles) requestChangesReason = 'The allowed repair limit has been reached.';
    else if (!precheck) requestChangesReason = 'The current built version must first pass the app check, or have an eligible failed check that can still be repaired.';
    else requestChangesReason = 'A repair is not available for the current version.';
  }
  return { precheckVerificationRunId: precheck?.run.id ?? null, accepted, canRequestChanges, requestChangesReason };
}

function view(input: Omit<MissionProductView, 'rail' | 'implementationAdmission' | 'implementationReview'>, facts: MissionPresentationFacts): MissionProductView {
  return { ...input, implementationAdmission: facts.implementationAdmission, implementationReview: reviewView(facts), rail: rail(input.currentStage) };
}

function stageForPhase(phase: Mission['workflow']['phase']): MissionProductView['currentStage'] {
  if (phase === 'designing') return 'design';
  if (phase === 'awaiting_approval') return 'approval';
  if (phase === 'implementing' || phase === 'repairing') return 'build';
  if (phase === 'completed') return 'complete';
  return 'verify';
}

function designExplanation(input: MissionPresentationFacts, attempt: TaskAttempt | null, failed: MissionFailureView | null, action: { id: 'retry_design' } | { id: 'generate_design' } | null): string {
  if (action?.id === 'retry_design') return 'The last design attempt failed. Retry starts again from the same saved input without changing the requested outcome.';
  if (attempt?.status === 'running') return 'The Designer is preparing a reviewable design for this request.';
  if (!failed) return 'Generate the design when you are ready to use model budget.';

  const retryReason = input.recovery.retryCurrentDesign.allowed ? null : input.recovery.retryCurrentDesign.reason;
  const designer = input.mission.participants.find((participant) => participant.agentId === input.mission.workflow.designerAgentId)?.snapshot.name ?? 'The assigned Designer';
  const reservationNote = retryReason === 'Design retry limit reached.' ? ` ${designer} stays reserved by this unfinished Mission until it is safely stopped or completed.` : '';
  return `The design attempt failed. ${input.recovery.retryCurrentDesign.allowed ? 'You can retry it.' : retryReason} The Mission is still incomplete.${reservationNote}`;
}

function interventionExplanation(input: MissionPresentationFacts, finalFailure: boolean, userRepairRemaining: boolean): string {
  if (finalFailure) return 'The built result you accepted failed the separate final check. Nothing was published, and Conductor will not automatically run another repair.';
  if (userRepairRemaining) return 'The automatic repair was already used and the app still does not meet the approved requirements. Review the failed checks and request the one remaining repair if appropriate.';
  if (input.mission.workflow.repairCycle >= input.mission.workflow.maxRepairCycles) return 'The allowed repair attempts are exhausted and the app still does not meet the approved requirements. Completion stays blocked.';
  return 'The app still does not meet the approved requirements. Completion stays blocked and no further repair is currently available.';
}

export function projectMissionProduct(input: MissionPresentationFacts): MissionProductView {
  const { mission } = input;
  const present = (value: Omit<MissionProductView, 'rail' | 'implementationAdmission' | 'implementationReview'>): MissionProductView => view(value, input);
  const task = input.tasks.find((item) => item.id === mission.currentTaskId) ?? null;
  const attempt = task?.authoritativeAttemptId ? input.attempts.find((item) => item.id === task.authoritativeAttemptId) ?? null : null;
  const verification = mission.workflow.currentVerificationRunId ? input.verificationRuns.find((item) => item.id === mission.workflow.currentVerificationRunId) ?? null : null;
  const implementationAccepted = Boolean(currentImplementationAcceptance({ mission, verificationRuns: input.verificationRuns, events: input.events }));
  const precheck = currentPassedImplementationPrecheck({ mission, verificationRuns: input.verificationRuns, events: input.events });
  const lock = mission.workflow.approvedDesignRevisionId ? 'unlocked' as const : 'locked' as const;

  if (mission.status === 'cancelled') return present({
    state: 'stopped',
    currentStage: stageForPhase(mission.workflow.phase),
    headline: 'Mission stopped',
    explanation: 'This Mission was stopped safely. Its saved history remains available, reserved Agents were released, and no unfinished result was approved as complete.',
    implementationLock: 'locked',
    completionAuthority: 'pending',
    failure: null,
    primaryAction: null,
  });

  if (mission.workflow.phase === 'designing') {
    const action = input.recovery.retryCurrentDesign.allowed ? { id: 'retry_design' as const } : task?.status === 'pending' && !attempt ? { id: 'generate_design' as const } : null;
    const failed = attemptFailure(attempt);
    return present({
      state: 'designing',
      currentStage: 'design',
      headline: failed && !action ? 'Design needs attention' : attempt?.status === 'running' ? 'Preparing design' : 'Ready to prepare design',
      explanation: designExplanation(input, attempt, failed, action),
      implementationLock: 'locked',
      completionAuthority: 'pending',
      failure: failed,
      primaryAction: action,
    });
  }

  if (mission.workflow.phase === 'awaiting_approval') return present({
    state: 'approval_required',
    currentStage: 'approval',
    headline: 'Review the proposed design',
    explanation: 'Check the rendered design and its acceptance requirements. The Builder stays locked until you approve this exact version.',
    implementationLock: 'locked',
    completionAuthority: 'pending',
    failure: null,
    primaryAction: { id: 'approve_design' },
  });

  if (mission.workflow.phase === 'implementing') {
    const running = attempt?.status === 'running' || task?.status === 'running';
    if (running) return present({
      state: 'building', currentStage: 'build', headline: 'Building the approved design', explanation: 'The Builder is implementing the exact design you approved.', implementationLock: 'unlocked', completionAuthority: 'pending', failure: attemptFailure(attempt), primaryAction: null,
    });
    if (input.recovery.resumeImplementation.allowed) return present({
      state: 'implementation_blocked', currentStage: 'build', headline: 'Builder finished — save the result', explanation: 'The Builder run completed, but Conductor could not safely save the built workspace. Finalize Build retries only that save/checkpoint step and does not rerun the Builder.', implementationLock: 'unlocked', completionAuthority: 'pending', failure: attemptFailure(attempt), primaryAction: { id: 'finalize_build' },
    });
    if (!input.implementationAdmission.allowed) return present({
      state: 'implementation_blocked', currentStage: 'build', headline: 'Build blocked', explanation: input.implementationAdmission.message ?? 'The Builder cannot start safely from the current state.', implementationLock: 'unlocked', completionAuthority: 'pending', failure: attemptFailure(attempt), primaryAction: null,
    });
    return present({
      state: 'implementation_unlocked', currentStage: 'build', headline: 'Ready to build', explanation: 'You approved the design. The Builder can now implement that exact version.', implementationLock: 'unlocked', completionAuthority: 'pending', failure: attemptFailure(attempt), primaryAction: { id: 'run_builder' },
    });
  }

  if (mission.workflow.phase === 'repairing') {
    const failed = attemptFailure(attempt);
    if (attempt?.status === 'running' || task?.status === 'running') return present({
      state: 'repairing', currentStage: 'build', headline: 'Fixing the built result', explanation: 'The Builder is applying one bounded repair while keeping the same approved design. Completion is still blocked.', implementationLock: lock, completionAuthority: 'pending', failure: failed, primaryAction: null,
    });
    if (task?.stage === 'repair' && task.status === 'pending') return present({
      state: 'repairing', currentStage: 'build', headline: 'Repair ready', explanation: 'One bounded repair is available for the exact failed built version. Starting it may use model budget.', implementationLock: lock, completionAuthority: 'pending', failure: null, primaryAction: { id: 'run_repair' },
    });
    return present({
      state: 'repairing', currentStage: 'build', headline: 'Repair needs attention', explanation: failed ? 'The repair did not finish. Conductor kept the evidence and did not approve the work as complete.' : 'A repair is recorded, but there is no safe automatic action to run now.', implementationLock: lock, completionAuthority: 'pending', failure: failed, primaryAction: null,
    });
  }

  if (mission.workflow.phase === 'verifying') {
    if (verification?.status === 'error') return present({
      state: 'verification_error',
      currentStage: implementationAccepted ? 'verify' : 'review',
      headline: implementationAccepted ? 'Final check could not run' : 'App check could not run',
      explanation: implementationAccepted
        ? 'The accepted built result is unchanged and still incomplete. Retry runs only the final checker against the same version.'
        : 'The checker hit an infrastructure problem, not a failed product requirement. Retry checks the same built result and does not rerun the Builder.',
      implementationLock: lock,
      completionAuthority: 'pending',
      failure: verificationFailure(verification),
      primaryAction: input.recovery.retryVerification.allowed ? { id: 'retry_verification' } : null,
    });

    if (verification && ['queued', 'running'].includes(verification.status)) return present({
      state: implementationAccepted ? 'verifying' : 'implementation_checking',
      currentStage: implementationAccepted ? 'verify' : 'review',
      headline: implementationAccepted ? 'Final check in progress' : 'Checking the built app',
      explanation: implementationAccepted
        ? 'The independent verifier is checking the exact built result you accepted before Conductor can publish it.'
        : 'Conductor is running the captured application and checking the approved content, interactions, runtime behavior, and protected visual anchors before asking you to review the result.',
      implementationLock: lock,
      completionAuthority: 'pending',
      failure: null,
      primaryAction: null,
    });

    if (precheck && !implementationAccepted) return present({
      state: 'implementation_review', currentStage: 'review', headline: 'Review the built result', explanation: 'The first app check passed. Compare the built application with the design you approved, then request changes or accept this exact result for the separate final check.', implementationLock: lock, completionAuthority: 'pending', failure: null, primaryAction: { id: 'accept_implementation' },
    });

    if (!verification) return present({
      state: 'awaiting_verification', currentStage: 'review', headline: 'Builder finished — checking the app', explanation: 'The work is not complete. Conductor must run the captured application before you can accept it. If automatic start was interrupted, start the same check explicitly.', implementationLock: lock, completionAuthority: 'pending', failure: null, primaryAction: input.recovery.verificationAdmission.accepted ? { id: 'start_verification' } : null,
    });
  }

  if (mission.workflow.phase === 'awaiting_intervention') {
    const finalFailure = implementationAccepted;
    const userRepairRemaining = !finalFailure && Boolean(implementationChangeRequestRun({ mission, verificationRuns: input.verificationRuns, events: input.events, workspaceState: input.workspaceState }));
    return present({
      state: 'verification_failed',
      currentStage: finalFailure ? 'verify' : 'review',
      headline: finalFailure ? 'Final check failed — completion blocked' : 'Built app needs changes',
      explanation: interventionExplanation(input, finalFailure, userRepairRemaining),
      implementationLock: lock,
      completionAuthority: 'denied',
      failure: verificationFailure(verification) ?? attemptFailure(attempt),
      primaryAction: null,
    });
  }

  if (mission.workflow.phase === 'completed' && canCompleteMission({ mission, verification })) return present({
    state: 'complete', currentStage: 'complete', headline: 'Verified and complete', explanation: 'The separate final check passed for the exact approved design and built version. This Mission is complete.', implementationLock: 'unlocked', completionAuthority: 'authorized', failure: null, primaryAction: null,
  });

  return present({
    state: 'degraded',
    currentStage: 'verify',
    headline: 'Mission needs attention',
    explanation: 'Conductor cannot safely determine the next action from the saved Mission records. No action that could approve or publish work is available.',
    implementationLock: lock,
    completionAuthority: 'pending',
    failure: { source: 'inconsistency', category: 'inconsistent', title: 'Saved Mission state is inconsistent', message: `Mission phase ${mission.workflow.phase} does not have the required current evidence.` },
    primaryAction: null,
  });
}
