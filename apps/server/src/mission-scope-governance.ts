import { createHash, randomUUID } from 'node:crypto';
import { addEvent, safeMissionText } from './mission-evidence.js';
import { designTaskDefinition } from './mission-prompt.js';
import { JsonStore } from './store.js';
import type { MissionArtifact, MissionTask, MissionWorkspaceRevision, RunnerResult } from './types.js';
import type { MissionWorkspacePort } from './workspace.js';

const now = () => new Date().toISOString();

export async function rejectUnexpectedImplementationScope(input: {
  store: JsonStore;
  workspaces: MissionWorkspacePort;
  missionId: string;
  taskId: string;
  attemptId: string;
  runId: string;
  baseline: MissionWorkspaceRevision;
  captured: MissionWorkspaceRevision;
  unexpectedPaths: string[];
  result: RunnerResult;
  redactionSecrets?: readonly string[];
}): Promise<void> {
  let restored = false;
  try { await input.workspaces.restoreMissionRevision(input.missionId, input.baseline); const inspection = await input.workspaces.inspectMissionWorkspace(input.missionId, input.baseline.contentHash, false); restored = inspection.state === 'clean' && inspection.contentHash === input.baseline.contentHash; }
  catch { restored = false; }
  finally { await input.workspaces.discardMissionRevision(input.missionId, input.captured).catch(() => undefined); }
  await input.store.mutate((database) => {
    const mission = database.missions.find((item) => item.id === input.missionId); const task = database.missionTasks.find((item) => item.id === input.taskId); const attempt = database.taskAttempts.find((item) => item.id === input.attemptId); const run = database.runs.find((item) => item.id === input.runId);
    if (!mission || !task || !attempt || !run || task.authoritativeAttemptId !== attempt.id || !['running', 'interrupted'].includes(attempt.status)) return;
    const timestamp = now(); const paths = input.unexpectedPaths.slice(0, 32); const message = `Implementation changed frontend scope outside the approved atomic bundle: ${paths.join(', ')}`;
    attempt.status = 'failed'; attempt.runtimeThreadId = input.result.threadId; attempt.usage = input.result.usage; attempt.error = { category: 'agent', message }; attempt.completedAt = timestamp; attempt.updatedAt = timestamp; task.status = 'stale'; task.authoritativeAttemptId = null; task.updatedAt = timestamp;
    const designTaskId = randomUUID(); const feedback = safeMissionText(`Re-design the whole affected surface bundle. Unexpected implemented frontend paths were rejected and restored: ${paths.join(', ')}`, 16 * 1024, input.redactionSecrets ?? []);
    const feedbackArtifact: MissionArtifact = { id: randomUUID(), missionId: mission.id, taskId: designTaskId, attemptId: null, kind: 'design_feedback', mediaType: 'text/plain', content: feedback.content, storage: { kind: 'inline' }, sha256: createHash('sha256').update(feedback.content, 'utf8').digest('hex'), workspaceRevisionId: input.baseline.id, createdBy: { kind: 'system', agentId: null }, originalByteLength: feedback.originalByteLength, truncated: feedback.truncated, createdAt: timestamp };
    const definition = designTaskDefinition();
    const designTask: MissionTask = { id: designTaskId, missionId: mission.id, order: database.missionTasks.filter((item) => item.missionId === mission.id).length, stage: 'design', assignedAgentId: mission.workflow.designerAgentId, title: definition.title, instruction: definition.instruction, inputDesignRevisionId: null, inputVerificationRunId: null, inputWorkspaceRevisionId: input.baseline.id, repairCycle: null, status: 'pending', authoritativeAttemptId: null, authorityVersion: 0, inputArtifactIds: [feedbackArtifact.id], outputArtifactIds: [], outputWorkspaceRevisionId: null, createdAt: timestamp, updatedAt: timestamp, startedAt: null, completedAt: null };
    database.missionArtifacts.push(feedbackArtifact); database.missionTasks.push(designTask); mission.workflow.phase = 'designing'; mission.workflow.latestDesignRevisionId = null; mission.workflow.approvedDesignRevisionId = null; mission.workflow.implementedWorkspaceRevisionId = null; mission.workflow.currentVerificationRunId = null; mission.currentTaskId = designTask.id; mission.status = restored ? 'paused' : 'recovered_paused'; mission.workspace.currentRevisionId = input.baseline.id; mission.workspace.revisionStatus = restored ? 'clean' : 'uncheckpointed'; mission.updatedAt = timestamp;
    addEvent(database, mission, 'attempt_failed', { taskId: task.id, attemptId: attempt.id, agentId: attempt.agentId }, { category: 'agent', reason: message, stage: task.stage });
    addEvent(database, mission, 'downstream_marked_stale', { taskId: task.id }, { reason: 'unexpected_frontend_scope', unexpectedPaths: paths.join(', '), restored });
    addEvent(database, mission, 'design_feedback_submitted', { taskId: designTask.id, actor: 'system' }, { reason: 'unexpected_frontend_scope', feedbackArtifactId: feedbackArtifact.id });
  });
}
