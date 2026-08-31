import type { DesignRevision, MissionEvent, TaskAttempt, VerificationRun } from './types.js';
import type { MissionRuntimeActivityView } from './mission-runtime-observability.js';

const MAX_ACTIVITY = 8;

export interface MissionInspectorProjection {
  actor: 'Designer' | 'Builder' | 'Verifier';
  state: 'running' | 'recent' | 'unavailable';
  attempt: Pick<TaskAttempt, 'id' | 'attemptNumber' | 'authorityVersion' | 'stage' | 'status' | 'runtimeThreadId' | 'startedAt' | 'completedAt'> | null;
  verification: Pick<VerificationRun, 'id' | 'status' | 'designRevisionId' | 'workspaceRevisionId' | 'correlationId' | 'startedAt' | 'completedAt' | 'durationMs'> | null;
  activity: Array<{ label: string; observedAt: string }>;
  files: Array<{ operation: 'WRITTEN'; path: string }>;
  checks: Array<{ label: string; status: 'passed' | 'failed' | 'running'; details: string | null }>;
  usage: TaskAttempt['usage'];
}

const newestFirst = <T extends { createdAt: string }>(left: T, right: T) => right.createdAt.localeCompare(left.createdAt);

/** Pure, bounded projection of server-owned records and normalized ephemeral observations. */
export function projectMissionInspector(input: {
  attempts: TaskAttempt[];
  designRevisions: DesignRevision[];
  verificationRuns: VerificationRun[];
  events: MissionEvent[];
  currentVerificationRunId: string | null;
  runtimeActivity: MissionRuntimeActivityView | null;
}): MissionInspectorProjection {
  const attempt = input.runtimeActivity ? input.attempts.find((candidate) => candidate.id === input.runtimeActivity?.attemptId) ?? null : [...input.attempts].sort(newestFirst)[0] ?? null;
  const verification = input.currentVerificationRunId ? input.verificationRuns.find((candidate) => candidate.id === input.currentVerificationRunId) ?? null : [...input.verificationRuns].sort(newestFirst)[0] ?? null;
  const verifierIsCurrent = verification !== null && (verification.id === input.currentVerificationRunId || !attempt || verification.createdAt > attempt.createdAt);
  const selectedAttempt = verifierIsCurrent ? null : attempt;
  const actor = verifierIsCurrent ? 'Verifier' : selectedAttempt?.stage === 'implement' || selectedAttempt?.stage === 'repair' ? 'Builder' : 'Designer';
  const live = input.runtimeActivity?.status === 'running' || verification?.status === 'queued' || verification?.status === 'running';
  const selectedRevision = selectedAttempt ? input.designRevisions.find((revision) => revision.sourceAttemptId === selectedAttempt.id) ?? null : null;
  const durableActivity = selectedAttempt ? input.events.filter((event) => event.attemptId === selectedAttempt.id && ['attempt_started', 'attempt_completed', 'attempt_failed', 'attempt_result_discarded'].includes(event.type)).map((event) => ({ label: event.type === 'attempt_started' ? 'Runtime execution started' : event.type === 'attempt_completed' ? 'Runtime execution completed' : event.type === 'attempt_failed' ? 'Runtime execution failed' : 'Stale execution result rejected', observedAt: event.createdAt })) : [];
  const activity = (input.runtimeActivity?.activities.length ? input.runtimeActivity.activities : durableActivity).slice(-MAX_ACTIVITY);
  const files = selectedRevision ? [
    { operation: 'WRITTEN' as const, path: '.conductor/design-draft/index.html' },
    { operation: 'WRITTEN' as const, path: '.conductor/design-draft/styles.css' },
    { operation: 'WRITTEN' as const, path: '.conductor/design-draft/design-contract.json' },
  ] : [];
  const checks = verifierIsCurrent && verification
    ? verification.checks.map((check) => ({ label: check.label, status: check.passed ? 'passed' as const : 'failed' as const, details: check.details || null }))
    : selectedRevision
      ? [
          { label: 'JSON syntax', status: 'passed' as const, details: null },
          { label: 'DesignContract validation', status: 'passed' as const, details: null },
          { label: 'Allowed-write validation', status: 'passed' as const, details: null },
          { label: 'Protected reference capture', status: 'passed' as const, details: null },
        ]
      : selectedAttempt
        ? [{ label: 'Runtime execution', status: selectedAttempt.status === 'running' ? 'running' as const : selectedAttempt.status === 'completed' ? 'passed' as const : 'failed' as const, details: selectedAttempt.error?.message ?? null }]
        : [];
  return {
    actor,
    state: live ? 'running' : selectedAttempt || verification ? 'recent' : 'unavailable',
    attempt: selectedAttempt ? { id: selectedAttempt.id, attemptNumber: selectedAttempt.attemptNumber, authorityVersion: selectedAttempt.authorityVersion, stage: selectedAttempt.stage, status: selectedAttempt.status, runtimeThreadId: selectedAttempt.runtimeThreadId, startedAt: selectedAttempt.startedAt, completedAt: selectedAttempt.completedAt } : null,
    verification: verification ? { id: verification.id, status: verification.status, designRevisionId: verification.designRevisionId, workspaceRevisionId: verification.workspaceRevisionId, correlationId: verification.correlationId, startedAt: verification.startedAt, completedAt: verification.completedAt, durationMs: verification.durationMs } : null,
    activity,
    files,
    checks,
    usage: verifierIsCurrent ? null : input.runtimeActivity?.usage ?? selectedAttempt?.usage ?? null,
  };
}
