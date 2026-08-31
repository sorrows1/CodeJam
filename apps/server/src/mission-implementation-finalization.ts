import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import { resolveDesignReferenceMaterialization, type DesignReferenceStore } from './design-reference-store.js';
import { addEvent, safeMissionText } from './mission-evidence.js';
import { summarizeMissionUsage } from './mission-budget.js';
import { deriveMissionRecoveryCapabilities } from './mission-recovery-policy.js';
import { JsonStore } from './store.js';
import type { MissionArtifact } from './types.js';
import type { MissionWorkspacePort } from './workspace.js';
import { DESIGN_PACKAGE_MAX_BYTES, parseDesignPackage } from './design-package.js';
import { isFrontendPath } from './playground-impact.js';
import { rejectUnexpectedImplementationScope } from './mission-scope-governance.js';

const now = () => new Date().toISOString();
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface ImplementationFinalizationResult {
  resultAttemptId: string;
  resultRevisionId: string;
}

export async function finalizeCompletedImplementation(input: {
  store: JsonStore;
  workspaces: MissionWorkspacePort;
  references: DesignReferenceStore;
  missionId: string;
  taskId: string;
  recoveryCommandId: string;
  redactionSecrets?: readonly string[];
}): Promise<ImplementationFinalizationResult> {
  const snapshot = input.store.snapshot();
  const mission = snapshot.missions.find((item) => item.id === input.missionId);
  if (!mission) throw new HttpError(404, 'Mission not found');
  const task = snapshot.missionTasks.find((item) => item.id === mission.currentTaskId && item.missionId === mission.id) ?? null;
  if (!task || task.id !== input.taskId) throw new HttpError(409, 'Recovery request does not identify the current implementation task', 'MISSION_STAGE_UNAVAILABLE');
  const attempt = task.authoritativeAttemptId ? snapshot.taskAttempts.find((item) => item.id === task.authoritativeAttemptId && item.missionId === mission.id) ?? null : null;
  const baseline = task.inputWorkspaceRevisionId ? snapshot.missionWorkspaceRevisions.find((item) => item.id === task.inputWorkspaceRevisionId && item.missionId === mission.id) ?? null : null;
  const activeCommand = mission.activeRecoveryCommandId ? snapshot.missionRecoveryCommands.find((item) => item.id === mission.activeRecoveryCommandId) ?? null : null;
  const capabilities = deriveMissionRecoveryCapabilities({
    missions: snapshot.missions,
    mission,
    currentTask: task,
    attempts: snapshot.taskAttempts.filter((item) => item.missionId === mission.id),
    runs: snapshot.runs.filter((item) => item.context.kind === 'mission' && item.context.missionId === mission.id),
    currentVerification: null,
    workspaceRevision: baseline,
    workspaceState: 'unavailable',
    assignedAgent: snapshot.agents.find((item) => item.id === task.assignedAgentId) ?? null,
    measuredTokens: summarizeMissionUsage(mission.id, snapshot.runs).totalTokens,
    activeCommand: activeCommand?.id === input.recoveryCommandId ? null : activeCommand,
  });
  const recovery = capabilities.resumeImplementation;
  if (!recovery.allowed) throw new HttpError(409, recovery.reason, 'MISSION_STAGE_UNAVAILABLE', { stage: 'implement' });
  if (!attempt || !baseline) throw new HttpError(409, 'Builder finalization evidence is incomplete', 'MISSION_STAGE_UNAVAILABLE');

  const designRevision = snapshot.designRevisions.find((item) => item.id === recovery.designRevisionId && item.missionId === mission.id);
  if (!designRevision || designRevision.status !== 'approved') throw new HttpError(409, 'Approved DesignRevision is no longer valid', 'MISSION_STAGE_UNAVAILABLE');
  const materialization = resolveDesignReferenceMaterialization({ revision: designRevision, artifacts: snapshot.missionArtifacts });
  if (!materialization.ok || !(await input.references.verify(materialization.materialization))) throw new HttpError(409, 'Protected DesignRevision reference integrity failed', 'MISSION_STAGE_UNAVAILABLE');

  const captured = await input.workspaces.captureMissionRevision({
    missionId: mission.id,
    revision: {
      id: randomUUID(),
      missionId: mission.id,
      sequence: mission.workspace.nextRevisionSequence,
      parentRevisionId: baseline.id,
      restoredFromRevisionId: null,
      origin: 'task_success',
      boundaries: [{ kind: 'after_task', taskId: task.id }],
      taskId: task.id,
      attemptId: attempt.id,
      interventionArtifactId: null,
      createdBy: 'agent',
      createdAt: now(),
    },
  });

  try {
    const packageValue = parseDesignPackage(await input.references.read(materialization.materialization.package, DESIGN_PACKAGE_MAX_BYTES));
    const manifest = await input.workspaces.compareRevisions(mission.id, baseline, captured, input.redactionSecrets ?? []);
    const allowed = new Set(packageValue.surfaces.flatMap((surface) => [surface.entrypoint, ...surface.sourcePaths, ...surface.sharedDependencies]));
    const unexpected = manifest.files.filter((file) => isFrontendPath(file.path) && !allowed.has(file.path)).map((file) => file.path);
    if (manifest.truncated) unexpected.push('[changed-file manifest exceeded its bound]');
    if (unexpected.length) {
      await rejectUnexpectedImplementationScope({ store: input.store, workspaces: input.workspaces, missionId: mission.id, taskId: task.id, attemptId: attempt.id, runId: recovery.runId, baseline, captured, unexpectedPaths: unexpected, result: { output: snapshot.runs.find((item) => item.id === recovery.runId)?.output ?? null, threadId: attempt.runtimeThreadId, usage: snapshot.runs.find((item) => item.id === recovery.runId)?.usage ?? null }, redactionSecrets: input.redactionSecrets ?? [] });
      return { resultAttemptId: attempt.id, resultRevisionId: baseline.id };
    }
  } catch (error) {
    await input.workspaces.discardMissionRevision(mission.id, captured).catch(() => undefined);
    await input.workspaces.restoreMissionRevision(mission.id, baseline).catch(() => undefined);
    throw new HttpError(409, `Builder scope validation failed: ${error instanceof Error ? error.message : String(error)}`, 'MISSION_STAGE_UNAVAILABLE');
  }

  return input.store.mutate((database): ImplementationFinalizationResult => {
    const currentMission = database.missions.find((item) => item.id === mission.id);
    const currentTask = database.missionTasks.find((item) => item.id === task.id);
    const currentAttempt = database.taskAttempts.find((item) => item.id === attempt.id);
    const currentRun = database.runs.find((item) => item.id === recovery.runId);
    const currentCommand = database.missionRecoveryCommands.find((item) => item.id === input.recoveryCommandId) ?? null;
    const currentBaseline = database.missionWorkspaceRevisions.find((item) => item.id === baseline.id && item.missionId === mission.id) ?? null;
    if (!currentMission || !currentTask || !currentAttempt || !currentRun || !currentBaseline || !currentCommand || currentCommand.status !== 'applying' || currentMission.activeRecoveryCommandId !== currentCommand.id) throw new HttpError(409, 'Builder finalization authority changed', 'MISSION_STAGE_UNAVAILABLE');

    const currentCapabilities = deriveMissionRecoveryCapabilities({
      missions: database.missions,
      mission: currentMission,
      currentTask,
      attempts: database.taskAttempts.filter((item) => item.missionId === currentMission.id),
      runs: database.runs.filter((item) => item.context.kind === 'mission' && item.context.missionId === currentMission.id),
      currentVerification: null,
      workspaceRevision: currentBaseline,
      workspaceState: 'unavailable',
      assignedAgent: database.agents.find((item) => item.id === currentTask.assignedAgentId) ?? null,
      measuredTokens: summarizeMissionUsage(currentMission.id, database.runs).totalTokens,
      activeCommand: null,
    });
    const currentRecovery = currentCapabilities.resumeImplementation;
    if (!currentRecovery.allowed || currentRecovery.taskId !== currentTask.id || currentRecovery.attemptId !== currentAttempt.id || currentRecovery.runId !== currentRun.id || currentRecovery.inputWorkspaceRevisionId !== currentBaseline.id || currentRecovery.designRevisionId !== currentAttempt.inputDesignRevisionId) throw new HttpError(409, 'Builder finalization inputs are no longer current', 'MISSION_STAGE_UNAVAILABLE');

    let output: MissionArtifact | null = null;
    if (currentRun.output !== null) {
      const boundedOutput = safeMissionText(currentRun.output, MAX_OUTPUT_BYTES, input.redactionSecrets ?? []);
      output = {
        id: randomUUID(), missionId: currentMission.id, taskId: currentTask.id, attemptId: currentAttempt.id,
        kind: 'agent_output', mediaType: 'text/plain', content: boundedOutput.content, storage: { kind: 'inline' },
        sha256: createHash('sha256').update(boundedOutput.content, 'utf8').digest('hex'), workspaceRevisionId: captured.id,
        createdBy: { kind: 'agent', agentId: currentAttempt.agentId }, originalByteLength: boundedOutput.originalByteLength,
        truncated: boundedOutput.truncated, createdAt: now(),
      };
    }

    database.missionWorkspaceRevisions.push(captured);
    if (output) database.missionArtifacts.push(output);
    const timestamp = now();
    currentMission.workflow.phase = 'verifying';
    currentMission.workflow.implementedWorkspaceRevisionId = captured.id;
    currentMission.workflow.currentVerificationRunId = null;
    currentMission.status = 'paused';
    currentMission.currentTaskId = null;
    currentMission.workspace.currentRevisionId = captured.id;
    currentMission.workspace.revisionStatus = 'clean';
    currentMission.workspace.nextRevisionSequence = captured.sequence + 1;
    currentMission.updatedAt = timestamp;

    currentTask.status = 'completed';
    currentTask.authoritativeAttemptId = null;
    currentTask.outputArtifactIds = output ? [output.id] : [];
    currentTask.outputWorkspaceRevisionId = captured.id;
    currentTask.completedAt = timestamp;
    currentTask.updatedAt = timestamp;

    currentAttempt.status = 'completed';
    currentAttempt.error = null;
    currentAttempt.outputArtifactId = output?.id ?? null;
    currentAttempt.outputWorkspaceRevisionId = captured.id;
    currentAttempt.completedAt = currentAttempt.completedAt ?? currentRun.completedAt ?? timestamp;
    currentAttempt.updatedAt = timestamp;

    addEvent(database, currentMission, 'attempt_completed', { taskId: currentTask.id, attemptId: currentAttempt.id, agentId: currentAttempt.agentId }, { stage: 'implement', workspaceRevisionId: captured.id, recoveredFinalization: true });
    addEvent(database, currentMission, 'mission_status_changed', { taskId: currentTask.id }, { status: currentMission.status, workflowPhase: currentMission.workflow.phase });
    return { resultAttemptId: currentAttempt.id, resultRevisionId: captured.id };
  });
}
