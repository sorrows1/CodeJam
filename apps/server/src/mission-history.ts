import type { MissionEvent, RunUsage, TaskAttempt, VerificationCheck, VerificationRun } from './types.js';
import type { MissionRuntimeActivityView } from './mission-runtime-observability.js';

const MAX_HISTORY_ENTRIES = 50;
const MAX_EVENTS = 12;
const MAX_ERRORS = 16;
export type ChangedFile = { path: string; operation: 'ADDED' | 'MODIFIED' | 'DELETED' | 'WRITE' };
export type MissionHistoryEntry =
  | { kind: 'attempt'; id: string; createdAt: string; attemptId: string; taskId: string; stage: TaskAttempt['stage']; status: TaskAttempt['status']; authorityVersion: number; inputDesignRevisionId: string | null; inputVerificationRunId: string | null; inputWorkspaceRevisionId: string | null; outputWorkspaceRevisionId: string | null; usage: RunUsage | null; failure: TaskAttempt['error']; events: Array<{ type: MissionEvent['type']; createdAt: string }>; files: ChangedFile[]; filesAvailable: boolean; filesTruncated: boolean; live: MissionRuntimeActivityView | null }
  | { kind: 'verification'; id: string; createdAt: string; runId: string; status: VerificationRun['status']; cycle: number; correlationId: string; designRevisionId: string; workspaceRevisionId: string; checks: VerificationCheck[]; consoleErrors: string[]; pageErrors: string[]; durationMs: number | null; referenceScreenshotArtifactId: string | null; actualScreenshotArtifactId: string | null; current: boolean; stale: boolean; mode: 'precheck' | 'final' };

/** Pure, immutable-record projection. Live observations decorate only their exact attempt. */
export function projectMissionHistory(input: { attempts: readonly TaskAttempt[]; verificationRuns: readonly VerificationRun[]; events: readonly MissionEvent[]; currentVerificationRunId: string | null; runtimeActivity: MissionRuntimeActivityView | null; changedFiles?: ReadonlyMap<string, { files: ChangedFile[]; truncated: boolean }> }): MissionHistoryEntry[] {
  const attempts: MissionHistoryEntry[] = input.attempts.map((attempt) => {
    const manifest = input.changedFiles?.get(attempt.id);
    return { kind: 'attempt', id: `attempt:${attempt.id}`, createdAt: attempt.createdAt, attemptId: attempt.id, taskId: attempt.taskId, stage: attempt.stage, status: attempt.status, authorityVersion: attempt.authorityVersion, inputDesignRevisionId: attempt.inputDesignRevisionId, inputVerificationRunId: attempt.inputVerificationRunId, inputWorkspaceRevisionId: attempt.inputWorkspaceRevisionId, outputWorkspaceRevisionId: attempt.outputWorkspaceRevisionId, usage: attempt.usage ? { ...attempt.usage } : null, failure: attempt.error ? { ...attempt.error } : null, events: input.events.filter((event) => event.attemptId === attempt.id).slice(-MAX_EVENTS).map((event) => ({ type: event.type, createdAt: event.createdAt })), files: manifest?.files.map((file) => ({ ...file })) ?? [], filesAvailable: Boolean(manifest), filesTruncated: manifest?.truncated ?? false, live: input.runtimeActivity?.attemptId === attempt.id ? structuredClone(input.runtimeActivity) : null };
  });
  const verifications: MissionHistoryEntry[] = input.verificationRuns.map((run) => {
    const started = input.events.find((event) => event.type === 'verification_started' && event.details.verificationRunId === run.id);
    const completedAsFinal = input.events.some((event) => event.details.verificationRunId === run.id && (
      (event.type === 'verification_passed' && event.details.mode === 'final') ||
      event.type === 'intent_workflow_completed'
    ));
    const current = run.id === input.currentVerificationRunId;
    return { kind: 'verification', id: `verification:${run.id}`, createdAt: run.createdAt, runId: run.id, status: run.status, cycle: run.cycle, correlationId: run.correlationId, designRevisionId: run.designRevisionId, workspaceRevisionId: run.workspaceRevisionId, checks: run.checks.map((check) => ({ ...check })), consoleErrors: run.consoleErrors.slice(0, MAX_ERRORS), pageErrors: run.pageErrors.slice(0, MAX_ERRORS), durationMs: run.durationMs, referenceScreenshotArtifactId: run.referenceScreenshotArtifactId, actualScreenshotArtifactId: run.actualScreenshotArtifactId, current, stale: !current, mode: started?.details.mode === 'final' || completedAsFinal ? 'final' : 'precheck' };
  });
  return [...attempts, ...verifications].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).slice(-MAX_HISTORY_ENTRIES);
}
