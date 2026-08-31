import { describe, expect, it } from 'vitest';
import type { ImplementationAdmissionFacts } from './intent-workflow-state.js';
import { decideImplementationAdmission, implementationAdmissionMessage, projectImplementationAdmission } from './mission-implementation-admission.js';
import type { Agent, DesignRevision, Mission, MissionArtifact, MissionTask, MissionWorkspaceRevision } from './types.js';

const time = '2026-01-01T00:00:00.000Z';
const hash = 'a'.repeat(64);

function fixture(): ImplementationAdmissionFacts {
  const mission: Mission = {
    id: 'mission-1', goal: 'Build it', status: 'paused',
    participants: [{ agentId: 'builder', order: 0, snapshot: { name: 'Builder', description: '', instructions: '', agentUpdatedAt: time } }],
    workflow: { phase: 'implementing', designerAgentId: 'builder', builderAgentId: 'builder', latestDesignRevisionId: 'design-1', approvedDesignRevisionId: 'design-1', implementedWorkspaceRevisionId: null, currentVerificationRunId: null, repairCycle: 0, maxRepairCycles: 2 },
    workspace: { owner: 'conductor', key: 'mission-1', state: 'ready', source: { kind: 'agent_workspace', agentId: 'builder', agentUpdatedAt: time }, currentRevisionId: 'workspace-1', revisionStatus: 'clean', nextRevisionSequence: 2 },
    currentTaskId: 'task-1', nextEventSequence: 1, activeRecoveryCommandId: null, tokenBudget: null, createdAt: time, updatedAt: time, startedAt: time, completedAt: null,
  };
  const revision: DesignRevision = { id: 'design-1', missionId: mission.id, version: 1, parentRevisionId: null, status: 'approved', sourceTaskId: 'design-task', sourceAttemptId: 'design-attempt', packageArtifactId: 'package', packageHash: hash, previewArtifactId: 'preview', previewHash: hash, contractArtifactId: 'contract', contractHash: hash, feedbackArtifactId: null, createdAt: time, approvedAt: time, supersededAt: null };
  const task: MissionTask = { id: 'task-1', missionId: mission.id, order: 1, stage: 'implement', assignedAgentId: 'builder', title: 'Implementation', instruction: 'Build', inputDesignRevisionId: revision.id, inputVerificationRunId: null, inputWorkspaceRevisionId: 'workspace-1', repairCycle: null, status: 'pending', authoritativeAttemptId: null, authorityVersion: 0, inputArtifactIds: ['package', 'preview', 'contract'], outputArtifactIds: [], outputWorkspaceRevisionId: null, createdAt: time, updatedAt: time, startedAt: null, completedAt: null };
  const artifact = (id: string, kind: MissionArtifact['kind'], mediaType: string): MissionArtifact => ({ id, missionId: mission.id, taskId: revision.sourceTaskId, attemptId: revision.sourceAttemptId, kind, mediaType, content: null, storage: { kind: 'external', key: `design-reference-${mission.id}-${revision.id}-${id}` }, sha256: hash, workspaceRevisionId: null, createdBy: { kind: 'system', agentId: null }, originalByteLength: 10, truncated: false, createdAt: time });
  const workspaceRevision: MissionWorkspaceRevision = { id: 'workspace-1', missionId: mission.id, sequence: 1, parentRevisionId: null, restoredFromRevisionId: null, snapshotKey: 'revision-1', contentHash: hash, origin: 'mission_start', boundaries: [{ kind: 'before_task', taskId: task.id }], taskId: task.id, attemptId: null, interventionArtifactId: null, createdBy: 'system', createdAt: time };
  const agent: Agent = { id: 'builder', name: 'Builder', description: '', instructions: '', status: 'ready', workspacePath: '/builder', codexThreadId: null, lastError: null, createdAt: time, updatedAt: time };
  return { missions: [mission], mission, tasks: [task], revisions: [revision], revision, task, artifacts: [artifact('package', 'design_package', 'application/json'), artifact('preview', 'design_preview', 'text/html'), artifact('contract', 'design_contract', 'application/json')], workspaceRevision, workspaceState: 'clean', workspaceRevisionStatus: 'clean', agent, authoritativeAttempt: null, authoritativeRun: null, attempts: [], measuredTokens: 0 };
}

describe('implementation admission projection', () => {
  it('uses the real implementation guard for ready, workspace, agent, budget, and reference truth', () => {
    const ready = fixture();
    expect(projectImplementationAdmission(decideImplementationAdmission(ready))).toEqual({ allowed: true, reason: null, message: null });
    expect(projectImplementationAdmission(decideImplementationAdmission({ ...ready, workspaceState: 'changed' }))).toMatchObject({ allowed: false, reason: 'workspace_changed' });
    expect(projectImplementationAdmission(decideImplementationAdmission({ ...ready, agent: { ...ready.agent!, status: 'stopped' } }))).toMatchObject({ allowed: false, reason: 'agent_not_ready' });
    expect(projectImplementationAdmission(decideImplementationAdmission({ ...ready, mission: { ...ready.mission, tokenBudget: 10 }, measuredTokens: 10 }))).toMatchObject({ allowed: false, reason: 'budget_exhausted' });
    expect(projectImplementationAdmission(decideImplementationAdmission(ready, false))).toMatchObject({ allowed: false, reason: 'reference_integrity_failed' });
  });

  it('maps internal rejection enums to bounded product explanations', () => {
    expect(implementationAdmissionMessage('workspace_changed')).toBe('The workspace changed after this build was approved.');
    expect(implementationAdmissionMessage('agent_not_ready')).toBe('The assigned Builder is not ready.');
    expect(implementationAdmissionMessage('reference_integrity_failed')).toBe('Conductor could not verify the approved design reference.');
  });
});
