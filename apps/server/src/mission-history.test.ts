import { describe, expect, it } from 'vitest';
import { projectMissionHistory } from './mission-history.js';
import type { TaskAttempt, VerificationRun } from './types.js';

const attempt = (id: string, createdAt: string): TaskAttempt => ({ id, missionId: 'm', taskId: `task-${id}`, agentId: 'a', attemptNumber: 1, authorityVersion: 1, stage: 'implement', inputDesignRevisionId: 'd', inputVerificationRunId: null, inputWorkspaceRevisionId: 'w1', repairCycle: null, status: 'completed', runId: 'r', runtimeThreadId: null, inputArtifactIds: [], outputArtifactId: null, outputWorkspaceRevisionId: 'w2', usage: { inputTokens: 3 }, error: null, supersededAt: null, supersededByAttemptId: null, startedByRecoveryCommandId: null, createdAt, startedAt: createdAt, completedAt: createdAt, updatedAt: createdAt });
const verification = (id: string, status: VerificationRun['status'], createdAt: string): VerificationRun => ({ id, missionId: 'm', designRevisionId: 'd', workspaceRevisionId: 'w2', cycle: 0, status, correlationId: `c-${id}`, checks: [{ id: `check-${id}`, kind: 'text', label: id, passed: status === 'passed', details: status }], consoleErrors: [`console-${id}`], pageErrors: [], url: null, durationMs: 10, referenceScreenshotArtifactId: null, actualScreenshotArtifactId: `shot-${id}`, reportArtifactId: null, visualDifference: null, error: status === 'error' ? { category: 'infrastructure', message: 'boom' } : null, createdAt, startedAt: createdAt, completedAt: createdAt, updatedAt: createdAt });

describe('Mission history projection', () => {
  it('keeps historical verifier evidence unchanged and labels current authority separately', () => {
    const history = projectMissionHistory({ attempts: [], verificationRuns: [verification('old', 'failed', '2026-01-01T00:00:02.000Z'), verification('current', 'passed', '2026-01-01T00:00:03.000Z')], events: [], currentVerificationRunId: 'current', runtimeActivity: null });
    expect(history[0]).toMatchObject({ kind: 'verification', runId: 'old', status: 'failed', current: false, stale: true, checks: [{ details: 'failed' }], actualScreenshotArtifactId: 'shot-old' });
    expect(history[1]).toMatchObject({ kind: 'verification', runId: 'current', status: 'passed', current: true, stale: false });
  });
  it('labels a legacy completed final run from only its exact completion event', () => {
    const oldFinal = verification('old-final', 'passed', '2026-01-01T00:00:02.000Z');
    const unrelated = verification('unrelated', 'passed', '2026-01-01T00:00:03.000Z');
    const history = projectMissionHistory({ attempts: [], verificationRuns: [oldFinal, unrelated], events: [
      { id: 'event-1', missionId: 'm', sequence: 1, type: 'intent_workflow_completed', actor: { kind: 'system', agentId: null }, details: { verificationRunId: oldFinal.id }, createdAt: '2026-01-01T00:00:04.000Z' },
    ], currentVerificationRunId: unrelated.id, runtimeActivity: null });
    expect(history[0]).toMatchObject({ kind: 'verification', runId: oldFinal.id, mode: 'final' });
    expect(history[1]).toMatchObject({ kind: 'verification', runId: unrelated.id, mode: 'precheck' });
  });
  it('overlays telemetry only on the exact matching attempt', () => {
    const history = projectMissionHistory({ attempts: [attempt('one', '2026-01-01T00:00:01.000Z'), attempt('two', '2026-01-01T00:00:02.000Z')], verificationRuns: [], events: [], currentVerificationRunId: null, runtimeActivity: { stage: 'implement', attemptId: 'two', attemptNumber: 1, status: 'running', startedAt: '2026-01-01T00:00:02.000Z', completedAt: null, usage: null, activities: [{ label: 'live', observedAt: '2026-01-01T00:00:03.000Z' }] } });
    expect(history[0]).toMatchObject({ kind: 'attempt', attemptId: 'one', live: null });
    expect(history[1]).toMatchObject({ kind: 'attempt', attemptId: 'two', live: { activities: [{ label: 'live' }] } });
  });
  it('joins only the exact attempt changed-file manifest without contents', () => { const history = projectMissionHistory({ attempts: [attempt('one', '2026-01-01T00:00:01.000Z'), attempt('two', '2026-01-01T00:00:02.000Z')], verificationRuns: [], events: [], currentVerificationRunId: null, runtimeActivity: null, changedFiles: new Map([['two', { files: [{ path: 'src/App.tsx', operation: 'MODIFIED' as const }], truncated: false }]]) }); expect(history[0]).toMatchObject({ kind: 'attempt', attemptId: 'one', files: [], filesAvailable: false }); expect(history[1]).toMatchObject({ kind: 'attempt', attemptId: 'two', files: [{ path: 'src/App.tsx', operation: 'MODIFIED' }], filesAvailable: true, filesTruncated: false }); expect(JSON.stringify(history)).not.toContain('file contents'); });
  it('labels proven Design draft paths as writes without fabricating filesystem creation', () => { const design = { ...attempt('design', '2026-01-01T00:00:01.000Z'), stage: 'design' as const }; const history = projectMissionHistory({ attempts: [design], verificationRuns: [], events: [], currentVerificationRunId: null, runtimeActivity: null, changedFiles: new Map([['design', { files: [{ path: '.conductor/design-draft/index.html', operation: 'WRITE' as const }], truncated: false }]]) }); expect(history[0]).toMatchObject({ kind: 'attempt', files: [{ operation: 'WRITE' }], filesAvailable: true }); expect(JSON.stringify(history)).not.toContain('ADDED'); });
  it('keeps the polled history projection at its fixed 50-entry bound', () => { const attempts = Array.from({ length: 60 }, (_, index) => attempt(String(index), new Date(index).toISOString())); const history = projectMissionHistory({ attempts, verificationRuns: [], events: [], currentVerificationRunId: null, runtimeActivity: null }); expect(history).toHaveLength(50); expect(history[0]).toMatchObject({ kind: 'attempt', attemptId: '10' }); });
});
