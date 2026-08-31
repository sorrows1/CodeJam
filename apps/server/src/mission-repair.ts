import { createHash, randomUUID } from 'node:crypto';
import type { Mission, MissionArtifact, MissionTask, VerificationRun } from './types.js';

const now = () => new Date().toISOString();

export function createRepairTask(input: {
  mission: Mission;
  verification: VerificationRun;
  order: number;
  repairCycle: number;
  extraArtifactIds?: readonly string[];
}): MissionTask {
  const { mission, verification } = input;
  if (!mission.workflow.approvedDesignRevisionId || !mission.workflow.implementedWorkspaceRevisionId) throw new Error('Repair requires current design and workspace bindings');
  if (verification.missionId !== mission.id || verification.designRevisionId !== mission.workflow.approvedDesignRevisionId || verification.workspaceRevisionId !== mission.workflow.implementedWorkspaceRevisionId) throw new Error('Repair verification binding is stale');
  const inputArtifactIds = [verification.reportArtifactId, verification.actualScreenshotArtifactId, ...(input.extraArtifactIds ?? [])].filter((id): id is string => Boolean(id));
  const timestamp = now();
  return {
    id: randomUUID(),
    missionId: mission.id,
    order: input.order,
    stage: 'repair',
    assignedAgentId: mission.workflow.builderAgentId,
    title: 'Repair implementation',
    instruction: 'Repair only the concrete implementation mismatches identified by Conductor while preserving the exact approved DesignRevision. Do not redesign the product or modify protected reference material.',
    inputDesignRevisionId: verification.designRevisionId,
    inputVerificationRunId: verification.id,
    inputWorkspaceRevisionId: verification.workspaceRevisionId,
    repairCycle: input.repairCycle,
    status: 'pending',
    authoritativeAttemptId: null,
    authorityVersion: 0,
    inputArtifactIds,
    outputArtifactIds: [],
    outputWorkspaceRevisionId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    completedAt: null,
  };
}

export function createHumanImplementationFeedbackArtifact(input: {
  mission: Mission;
  workspaceRevisionId: string;
  content: string;
}): MissionArtifact {
  const content = input.content.trim();
  const timestamp = now();
  return {
    id: randomUUID(),
    missionId: input.mission.id,
    taskId: null,
    attemptId: null,
    kind: 'human_intervention',
    mediaType: 'text/plain',
    content,
    storage: { kind: 'inline' },
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    workspaceRevisionId: input.workspaceRevisionId,
    createdBy: { kind: 'human', agentId: null },
    originalByteLength: Buffer.byteLength(content, 'utf8'),
    truncated: false,
    createdAt: timestamp,
  };
}
