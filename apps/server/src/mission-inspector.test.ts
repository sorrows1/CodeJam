import { describe, expect, it } from 'vitest';
import { projectMissionInspector } from './mission-inspector.js';
import type { DesignRevision, MissionEvent, TaskAttempt, VerificationRun } from './types.js';

const attempt = {
  id: 'attempt-1', missionId: 'mission-1', taskId: 'task-1', agentId: 'agent-1', attemptNumber: 2, authorityVersion: 3, stage: 'design', inputDesignRevisionId: null, inputVerificationRunId: null, inputWorkspaceRevisionId: 'workspace-1', repairCycle: null, status: 'failed', runId: 'run-1', runtimeThreadId: 'thread-safe', inputArtifactIds: [], outputArtifactId: null, outputWorkspaceRevisionId: null, usage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 4 }, error: { category: 'infrastructure', message: 'bounded failure' }, supersededAt: null, supersededByAttemptId: null, startedByRecoveryCommandId: null, createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:01.000Z', completedAt: '2026-01-01T00:00:02.000Z', updatedAt: '2026-01-01T00:00:02.000Z',
} satisfies TaskAttempt;

describe('Mission Inspector projection', () => {
  it('falls back to bounded durable attempt evidence without inventing files or checks', () => {
    const event = { id: 'event-1', missionId: 'mission-1', sequence: 1, type: 'attempt_failed', taskId: 'task-1', attemptId: attempt.id, agentId: 'agent-1', actor: 'system', details: {}, createdAt: attempt.completedAt! } satisfies MissionEvent;
    const result = projectMissionInspector({ attempts: [attempt], designRevisions: [], verificationRuns: [], events: [event], currentVerificationRunId: null, runtimeActivity: null });
    expect(result).toMatchObject({ actor: 'Designer', state: 'recent', usage: attempt.usage, files: [], checks: [{ label: 'Runtime execution', status: 'failed', details: 'bounded failure' }] });
    expect(result.activity).toEqual([{ label: 'Runtime execution failed', observedAt: attempt.completedAt }]);
    expect(result.attempt).not.toHaveProperty('error');
  });

  it('shows only proven Design files and validation checks after revision materialization', () => {
    const revision = { id: 'revision-1', missionId: 'mission-1', version: 1, parentRevisionId: null, status: 'draft', sourceTaskId: 'task-1', sourceAttemptId: attempt.id, packageArtifactId: 'package', packageHash: 'hash', previewArtifactId: 'preview', previewHash: 'hash', contractArtifactId: 'contract', contractHash: 'hash', feedbackArtifactId: null, createdAt: '2026-01-01T00:00:03.000Z', approvedAt: null, supersededAt: null } satisfies DesignRevision;
    const result = projectMissionInspector({ attempts: [{ ...attempt, status: 'completed', error: null }], designRevisions: [revision], verificationRuns: [], events: [], currentVerificationRunId: null, runtimeActivity: null });
    expect(result.files.map((file) => file.path)).toEqual(['.conductor/design-draft/index.html', '.conductor/design-draft/styles.css', '.conductor/design-draft/design-contract.json']);
    expect(result.checks.map((check) => check.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
  });

  it('does not present Builder token usage or attempt metadata as verifier execution evidence', () => {
    const verification = { id: 'verify-1', missionId: 'mission-1', designRevisionId: 'revision-1', workspaceRevisionId: 'workspace-2', cycle: 0, status: 'failed', correlationId: 'correlation-1', checks: [{ id: 'check-1', kind: 'text', label: 'Required text', passed: false, details: 'missing' }], consoleErrors: [], pageErrors: [], url: 'http://127.0.0.1', durationMs: 10, referenceScreenshotArtifactId: null, actualScreenshotArtifactId: null, reportArtifactId: null, visualDifference: null, error: null, createdAt: '2026-01-01T00:00:04.000Z', startedAt: '2026-01-01T00:00:04.000Z', completedAt: '2026-01-01T00:00:05.000Z', updatedAt: '2026-01-01T00:00:05.000Z' } satisfies VerificationRun;
    const result = projectMissionInspector({ attempts: [{ ...attempt, stage: 'implement', status: 'completed', error: null }], designRevisions: [], verificationRuns: [verification], events: [], currentVerificationRunId: verification.id, runtimeActivity: null });
    expect(result).toMatchObject({ actor: 'Verifier', attempt: null, usage: null, verification: { id: verification.id }, checks: [{ label: 'Required text', status: 'failed' }] });
  });
});
