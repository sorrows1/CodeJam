import type { ImplementationAdmissionRejection, MissionDetail, VerificationRun } from '../types';

export type MissionFeedKind = 'human_intent' | 'stage_started' | 'design_revision' | 'human_feedback' | 'approval' | 'builder_activity' | 'build_complete' | 'verification_started' | 'verification_result' | 'implementation_review' | 'repair' | 'failure' | 'recovery' | 'admission_blocked';
export interface MissionFeedItem { id: string; sequence: number; kind: MissionFeedKind; actor: 'You' | 'Designer' | 'Builder' | 'Verifier' | 'Conductor'; title: string; body: string; timestamp: string; revisionId?: string; verificationRunId?: string; attemptId?: string; failure?: { title: string; message: string; note: string }; }

type MissionEvent = MissionDetail['events'][number];
type MissionTask = MissionDetail['tasks'][number];
type MissionAttempt = MissionDetail['attempts'][number];
type MissionRevision = MissionDetail['designRevisions'][number];

type FeedCopyContext = {
  detail: MissionDetail;
  event: MissionEvent;
  kind: MissionFeedKind;
  task: MissionTask | null;
  attempt: MissionAttempt | null;
  revision: MissionRevision | null;
  run: VerificationRun | null;
  mode: 'final' | 'precheck' | null;
  finalizationFailure: boolean;
  durableFailureMessage: string | null;
};

const implementationAdmissionMessages: Record<ImplementationAdmissionRejection, string> = {
  wrong_phase: 'This build cannot start from the current step.',
  wrong_mission_status: 'This Mission is not currently able to start a build.',
  approval_missing: 'Approve the current design before starting the build.',
  approved_revision_not_current: 'The approved design is no longer the latest design.',
  approved_revision_not_approved: 'The selected design no longer has a valid approval.',
  approved_revision_wrong_mission: 'The approved design belongs to a different Mission.',
  implementation_task_missing: 'The build task is unavailable.',
  implementation_task_not_current: 'This build task is no longer current.',
  implementation_task_binding_mismatch: 'The build task no longer matches the approved design and saved workspace.',
  reference_artifacts_missing: 'Part of the approved design reference is missing.',
  reference_binding_invalid: 'The approved design reference no longer matches this Mission.',
  reference_integrity_failed: 'Conductor could not verify the approved design reference.',
  workspace_revision_missing: 'The saved workspace for this build is unavailable.',
  workspace_revision_stale: 'The build input is no longer the current saved workspace.',
  workspace_changed: 'The workspace changed after this build was approved.',
  agent_not_assigned: 'The assigned Builder is unavailable.',
  agent_not_reserved: 'The assigned Builder is no longer reserved for this Mission.',
  agent_not_ready: 'The assigned Builder is not ready.',
  task_not_pending: 'This build task cannot be started now.',
  authoritative_attempt_missing: 'Conductor cannot identify the current Builder attempt safely.',
  authoritative_run_missing: 'Conductor cannot identify the current Builder run safely.',
  recovery_limit_reached: 'The allowed Builder attempt limit has been reached.',
  budget_exhausted: 'This Mission has reached its token limit.',
};

function admissionMessage(reason: unknown): string | null {
  return typeof reason === 'string' && reason in implementationAdmissionMessages ? implementationAdmissionMessages[reason as ImplementationAdmissionRejection] : null;
}

function eventKind(type: string, stage: string | null): MissionFeedKind | null {
  if (type === 'design_revision_created') return 'design_revision';
  if (type === 'design_feedback_submitted' || type === 'implementation_changes_requested') return 'human_feedback';
  if (type === 'design_approved') return 'approval';
  if (type === 'implementation_review_accepted') return 'implementation_review';
  if (type === 'implementation_precheck_passed') return 'verification_result';
  if (type === 'repair_scheduled') return 'repair';
  if (type === 'attempt_failed' || type === 'verification_error') return 'failure';
  if (type === 'attempt_started') return stage === 'implement' || stage === 'repair' ? 'builder_activity' : 'stage_started';
  if (type === 'attempt_completed') return stage === 'implement' || stage === 'repair' ? 'build_complete' : null;
  if (type === 'implementation_admission_denied') return 'admission_blocked';
  if (type === 'verification_started') return 'verification_started';
  if (type === 'verification_passed' || type === 'verification_failed') return 'verification_result';
  if (type.startsWith('recovery') || type === 'startup_interrupted') return 'recovery';
  return null;
}

function runForEvent(detail: MissionDetail, event: MissionEvent): VerificationRun | null {
  const runId = typeof event.details.verificationRunId === 'string' ? event.details.verificationRunId : null;
  return runId ? detail.verificationRuns.find((candidate) => candidate.id === runId) ?? null : null;
}

function verificationResultBody(run: VerificationRun | null, type: string): string {
  if (!run) return type === 'verification_failed'
    ? 'The built application did not meet the approved requirements.'
    : 'Conductor recorded the check result for this exact built version.';

  if (run.status === 'passed') {
    const passed = run.checks.filter((check) => check.passed).length;
    return `The real application passed ${passed}/${run.checks.length} required checks.`;
  }

  if (run.status === 'failed') {
    const failed = run.checks.filter((check) => !check.passed);
    return failed.length
      ? failed.map((check) => `${check.label}: ${check.details}`).join(' · ')
      : 'The built application did not meet the approved requirements.';
  }

  if (run.status === 'error') return run.error?.message ?? 'The verification environment could not finish the check.';
  return 'Conductor recorded the check for this exact built version.';
}

function feedTitle(context: FeedCopyContext): string {
  const { detail, event, kind, mode, revision, task, finalizationFailure } = context;

  if (kind === 'design_revision') return `Design v${revision?.version ?? ''} ready to review`;
  if (event.type === 'implementation_changes_requested') return 'Requested changes to the built result';
  if (kind === 'human_feedback') return 'Requested design changes';
  if (kind === 'approval') return 'Design approved';
  if (kind === 'implementation_review') return 'Built result accepted for final check';
  if (kind === 'repair') return event.details.trigger === 'automatic_precheck' ? 'Conductor authorized one repair' : 'Repair requested';
  if (kind === 'builder_activity') return task?.stage === 'repair' ? 'Repair started' : 'Builder started';
  if (kind === 'build_complete') return task?.stage === 'repair' ? 'Repair finished' : 'Builder finished';
  if (event.type === 'implementation_precheck_passed') return 'Built app passed the first check';
  if (kind === 'verification_started') return mode === 'final' ? 'Final check started' : 'Checking the built app';
  if (kind === 'verification_result') return event.type === 'verification_passed' ? 'Verified and complete' : 'Verification failed — completion blocked';
  if (kind === 'admission_blocked') return 'Build blocked';
  if (finalizationFailure) return 'Builder finished, but saving the result was interrupted';
  return detail.timeline.events.find((candidate) => candidate.id === event.id)?.summary ?? event.type.replaceAll('_', ' ');
}

function feedBody(context: FeedCopyContext): string {
  const { event, kind, task, attempt, run, mode, finalizationFailure, durableFailureMessage } = context;

  if (kind === 'design_revision') return `The Designer finished attempt ${attempt?.attemptNumber ?? ''}. Conductor checked the proposed design and prepared it for your review.`;

  if (event.type === 'implementation_changes_requested') {
    return 'Your requested fixes were saved against this exact built version. The approved design stays unchanged while the Builder gets one bounded repair attempt.';
  }

  if (kind === 'implementation_review') {
    return 'You accepted this exact built result after the first check. A separate final check is still required before Conductor can publish it.';
  }

  if (kind === 'repair') {
    return event.details.trigger === 'automatic_precheck'
      ? 'The first check found a requirement mismatch, so Conductor authorized one bounded repair against the same approved design.'
      : 'You requested one bounded repair against the same approved design.';
  }

  if (kind === 'build_complete') {
    return task?.stage === 'repair'
      ? 'Conductor saved the repaired application and will check the real app again before you review it.'
      : 'The Builder finished and Conductor saved the result. The work is still not complete; the real app must pass independent checks first.';
  }

  if (kind === 'approval') return 'You approved this exact design and its requirements. The Builder is now allowed to implement it.';

  if (kind === 'admission_blocked') return admissionMessage(event.details.reason) ?? 'Conductor blocked the Builder because the current build requirements are not safely satisfied.';

  if (finalizationFailure) {
    return 'The Builder run finished successfully, but Conductor could not safely save the built workspace. Retrying finalization saves the existing result without rerunning the Builder.';
  }

  if (kind === 'failure') return durableFailureMessage ?? 'This step did not finish successfully.';

  if (event.type === 'implementation_precheck_passed') {
    return `${verificationResultBody(run, event.type)} You can now compare the approved design with the built result. This PASS did not authorize completion.`;
  }

  if (kind === 'human_feedback') return 'Your design changes were saved and the Designer will prepare a new version for review.';

  if (kind === 'verification_started') {
    return mode === 'final'
      ? 'The independent verifier is checking the exact built result you accepted before publication.'
      : 'Conductor is running the captured application and checking the approved requirements before asking you to review the result.';
  }

  if (kind === 'verification_result') return verificationResultBody(run, event.type);
  if (kind === 'stage_started') return 'The Designer is preparing a reviewable design for this request.';
  return 'Conductor recorded this recovery step so the Mission can continue safely.';
}

function actorForEvent(kind: MissionFeedKind, event: MissionEvent, task: MissionTask | null): MissionFeedItem['actor'] {
  if (event.actor === 'human') return 'You';
  if (task?.stage === 'repair' || kind === 'builder_activity' || kind === 'build_complete') return 'Builder';
  if (kind === 'stage_started' || kind === 'design_revision') return 'Designer';
  if (kind.startsWith('verification')) return 'Verifier';
  return 'Conductor';
}

export function projectMissionFeed(detail: MissionDetail): MissionFeedItem[] {
  const items: MissionFeedItem[] = [{ id: `intent-${detail.mission.id}`, sequence: 0, kind: 'human_intent', actor: 'You', title: 'Requested outcome', body: detail.mission.goal, timestamp: detail.mission.createdAt }];
  const successfulDesignAttempts = new Set(detail.events.filter((event) => event.type === 'design_revision_created' && event.attemptId).map((event) => event.attemptId));
  const activeFinalizationAttemptId = detail.recovery.resumeImplementation.allowed ? detail.recovery.resumeImplementation.attemptId : null;
  const resumedImplementationTaskIds = new Set(detail.events.filter((event) => (event.type === 'recovery_command' || event.type === 'recovery_completed') && event.details.action === 'resume' && event.taskId).map((event) => event.taskId!));

  for (const event of detail.events) {
    if (['mission_created', 'participants_reserved', 'workspace_ready', 'revision_created', 'mission_status_changed', 'participants_released', 'intent_workflow_completed'].includes(event.type)) continue;
    if ((event.type === 'recovery_command' || event.type === 'recovery_completed') && event.details.action === 'resume') continue;

    const task = event.taskId ? detail.tasks.find((candidate) => candidate.id === event.taskId) ?? null : null;
    if (task?.stage === 'design' && event.attemptId && successfulDesignAttempts.has(event.attemptId) && (event.type === 'attempt_started' || event.type === 'attempt_completed')) continue;

    const kind = eventKind(event.type, task?.stage ?? null);
    if (!kind) continue;

    const run = runForEvent(detail, event);
    const mode = event.details.mode === 'final' ? 'final' : event.details.mode === 'precheck' ? 'precheck' : null;
    const finalizationFailure = kind === 'failure' && event.attemptId !== null && (event.attemptId === activeFinalizationAttemptId || (task?.stage === 'implement' && event.taskId !== null && resumedImplementationTaskIds.has(event.taskId)));
    const attempt = event.attemptId ? detail.attempts.find((candidate) => candidate.id === event.attemptId) ?? null : null;
    const revision = typeof event.details.revisionId === 'string' ? detail.designRevisions.find((candidate) => candidate.id === event.details.revisionId) ?? null : null;
    const durableFailureMessage = run?.status === 'error' ? run.error?.message ?? null : attempt?.error?.message ?? (typeof event.details.reason === 'string' ? event.details.reason : null);
    const context: FeedCopyContext = { detail, event, kind, task, attempt, revision, run, mode, finalizationFailure, durableFailureMessage };

    const failure = finalizationFailure && durableFailureMessage ? {
      title: attempt?.error?.category === 'infrastructure' ? 'Infrastructure problem' : 'Could not save the built result',
      message: durableFailureMessage,
      note: 'Conductor kept the completed Builder run and its exact inputs. No new implementation checkpoint was committed, so retrying does not need another Builder run.',
    } : undefined;

    items.push({
      id: event.id,
      sequence: event.sequence,
      kind,
      actor: actorForEvent(kind, event, task),
      title: feedTitle(context),
      body: feedBody(context),
      timestamp: event.createdAt,
      ...(typeof event.details.revisionId === 'string' ? { revisionId: event.details.revisionId } : {}),
      ...(event.attemptId ? { attemptId: event.attemptId } : {}),
      ...(typeof event.details.verificationRunId === 'string' ? { verificationRunId: event.details.verificationRunId } : {}),
      ...(failure ? { failure } : {}),
    });
  }

  return items.sort((left, right) => left.sequence - right.sequence || left.timestamp.localeCompare(right.timestamp));
}

export interface ReadableContract { viewport: string; requiredText: string[]; requiredElements: string[]; interactions: string[]; raw: string; valid: boolean; }

export function parseReadableContract(raw: string): ReadableContract {
  try {
    type ContractShape = { viewport?: { width?: number; height?: number }; requiredText?: unknown[]; requiredElements?: Array<{ role?: unknown; name?: unknown }>; interactions?: Array<{ action?: unknown; target?: { role?: unknown; name?: unknown }; expected?: { requiredText?: unknown[]; requiredElements?: Array<{ role?: unknown; name?: unknown }> } }> };
    const parsed = JSON.parse(raw) as ContractShape & { primarySurfaceId?: string; surfaces?: Array<{ id?: string; viewport?: ContractShape['viewport']; contract?: ContractShape }> };
    const primary = parsed.surfaces?.find((surface) => surface.id === parsed.primarySurfaceId) ?? parsed.surfaces?.[0];
    const value: ContractShape = primary ? { ...primary.contract, viewport: primary.viewport ?? primary.contract?.viewport } : parsed;
    return {
      viewport: `${value.viewport?.width ?? '?'} × ${value.viewport?.height ?? '?'}`,
      requiredText: (value.requiredText ?? []).filter((item): item is string => typeof item === 'string'),
      requiredElements: (value.requiredElements ?? []).map((item) => `${String(item.role ?? 'element')} “${String(item.name ?? 'unnamed')}”`),
      interactions: (value.interactions ?? []).map((item) => `${String(item.action ?? 'action')} ${String(item.target?.role ?? 'element')} “${String(item.target?.name ?? 'unnamed')}” → ${[...(item.expected?.requiredText ?? []), ...(item.expected?.requiredElements ?? []).map((entry) => `${String(entry.role)} “${String(entry.name)}”`)].join(', ') || 'expected state'}`),
      raw,
      valid: true,
    };
  } catch {
    return { viewport: 'Unavailable', requiredText: [], requiredElements: [], interactions: [], raw, valid: false };
  }
}
