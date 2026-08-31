import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import { createDesignPackage, createPreviewHtml, createSurfacePreviewHtml, canonicalizeDesignPackage, canonicalizeDesignBundleContract, canonicalizeDesignBundleDraft, hashDesignArtifact, parseDesignBundleDraft, parseDesignPackage, primaryDesignSurface } from './design-package.js';
import { canonicalizeDesignContract } from './design-contract.js';
import { acceptDesignRevision, approveDesignRevision, requestDesignRevision } from './intent-workflow-state.js';
import { addEvent, safeMissionText } from './mission-evidence.js';
import { designTaskDefinition } from './mission-prompt.js';
import { JsonStore } from './store.js';
import type { DesignReferenceDescriptor } from './design-reference-store.js';
import type { DesignRevision, MissionArtifact, MissionTask, RunnerResult, TaskAttempt } from './types.js';
import type { MissionWorkspacePort } from './workspace.js';
import { resolveDesignReferenceMaterialization, type DesignReferenceMaterialization, type DesignReferenceStore } from './design-reference-store.js';

const now = () => new Date().toISOString();
const MAX_FEEDBACK_BYTES = 16 * 1024;

function externalArtifact(input: { missionId: string; taskId: string; attemptId: string; id: string; kind: MissionArtifact['kind']; descriptor: DesignReferenceDescriptor; timestamp: string }): MissionArtifact {
  return { id: input.id, missionId: input.missionId, taskId: input.taskId, attemptId: input.attemptId, kind: input.kind, mediaType: input.descriptor.mediaType, content: null, storage: { kind: 'external', key: input.descriptor.key }, sha256: input.descriptor.sha256, workspaceRevisionId: null, createdBy: { kind: 'system', agentId: null }, originalByteLength: input.descriptor.byteLength, truncated: false, createdAt: input.timestamp };
}

export interface DesignFinalizationInput { missionId: string; taskId: string; attemptId: string; result: RunnerResult | null; error: Error | null; }

export class DesignGovernanceService {
  constructor(private readonly store: JsonStore, private readonly workspaces: MissionWorkspacePort, private readonly references: DesignReferenceStore, private readonly redactionSecrets: readonly string[] = []) {}

  async seedForRevision(revisionId: string): Promise<{ indexHtml: string; stylesCss: string; contractJson: string; bundleJson: string }> {
    const database = this.store.snapshot(); const revision = database.designRevisions.find((item) => item.id === revisionId); if (!revision) throw new HttpError(409, 'Design parent revision is unavailable', 'DESIGN_REVISION_NOT_CURRENT');
    const resolved = resolveDesignReferenceMaterialization({ revision, artifacts: database.missionArtifacts }); if (!resolved.ok) throw new HttpError(409, 'Design package is unavailable', 'DESIGN_REFERENCE_INVALID', { reason: resolved.reason });
    const packageValue = parseDesignPackage(await this.references.read(resolved.materialization.package, 768 * 1024)); const primary = primaryDesignSurface(packageValue); return { indexHtml: primary.files.indexHtml, stylesCss: primary.files.stylesCss, contractJson: canonicalizeDesignContract(primary.contract), bundleJson: canonicalizeDesignBundleDraft(packageValue) };
  }

  async finalizeDesign(input: DesignFinalizationInput): Promise<void> {
    const snapshot = this.store.snapshot();
    const mission = snapshot.missions.find((item) => item.id === input.missionId);
    const task = snapshot.missionTasks.find((item) => item.id === input.taskId && item.missionId === input.missionId);
    const attempt = snapshot.taskAttempts.find((item) => item.id === input.attemptId && item.missionId === input.missionId);
    const baseline = mission?.workspace.currentRevisionId ? snapshot.missionWorkspaceRevisions.find((item) => item.id === mission.workspace.currentRevisionId) : undefined;
    if (!mission || !task || !attempt || !baseline) return;
    let packageValue: ReturnType<typeof createDesignPackage> | null = null;
    let failure: { category: 'agent' | 'infrastructure' | 'cancelled'; message: string } | null = input.error ? { category: input.error.name === 'RunCancelledError' ? 'cancelled' : 'infrastructure', message: input.error.message } : null;
    if (!failure && input.result) {
      try {
        const inspection = await this.workspaces.inspectDesignDraft(input.missionId, baseline);
        if (!inspection.baselineMatches) failure = { category: 'agent', message: 'design_write_policy_violation: input checkpoint changed' };
        else if (inspection.unauthorizedPaths.length || inspection.invalidPaths.length || !inspection.files) failure = { category: 'agent', message: 'design_write_policy_violation' };
        else if (inspection.files.bundleJson) packageValue = parseDesignBundleDraft(inspection.files.bundleJson);
        else if (inspection.files.indexHtml !== null && inspection.files.stylesCss !== null && inspection.files.contractJson !== null) packageValue = createDesignPackage({ indexHtml: inspection.files.indexHtml, stylesCss: inspection.files.stylesCss, contract: inspection.files.contractJson });
        else failure = { category: 'agent', message: 'design_write_policy_violation: Design bundle is incomplete' };
      } catch (error) { failure = { category: 'agent', message: error instanceof Error ? error.message : String(error) }; }
    }
    try {
      await this.workspaces.restoreMissionRevision(input.missionId, baseline);
      const restored = await this.workspaces.inspectMissionWorkspace(input.missionId, baseline.contentHash, false);
      if (restored.state !== 'clean' || restored.contentHash !== baseline.contentHash) throw new Error('Restored workspace hash does not match input checkpoint');
    } catch (error) {
      await this.markRestorationFailure(input, error instanceof Error ? error.message : String(error));
      return;
    }
    if (failure || !packageValue) { await this.markAttemptFailure(input, failure ?? { category: 'agent', message: 'Design output was empty' }); return; }
    const revisionId = randomUUID();
    const packageJson = canonicalizeDesignPackage(packageValue);
    const previewHtml = createPreviewHtml(packageValue);
    const contractJson = canonicalizeDesignBundleContract(packageValue);
    let materialization: DesignReferenceMaterialization;
    try { materialization = await this.references.materialize({ missionId: input.missionId, revisionId, packageJson, previewHtml, contractJson }); }
    catch (error) { await this.markAttemptFailure(input, { category: 'infrastructure', message: error instanceof Error ? error.message : String(error) }); return; }
    await this.store.mutate(async (database) => {
      const currentMission = database.missions.find((item) => item.id === input.missionId);
      const currentTask = database.missionTasks.find((item) => item.id === input.taskId);
      const currentAttempt = database.taskAttempts.find((item) => item.id === input.attemptId);
      if (!currentMission || !currentTask || !currentAttempt || currentMission.currentTaskId !== currentTask.id || currentAttempt.status !== 'running' || currentTask.authoritativeAttemptId !== currentAttempt.id || currentMission.workspace.currentRevisionId !== baseline.id) {
        if (currentMission) addEvent(database, currentMission, 'attempt_result_discarded', { taskId: input.taskId, attemptId: input.attemptId, ...(currentAttempt ? { agentId: currentAttempt.agentId } : {}) }, { reason: 'design authority changed' });
        return;
      }
      const timestamp = now();
      const packageArtifact = externalArtifact({ missionId: input.missionId, taskId: input.taskId, attemptId: input.attemptId, id: randomUUID(), kind: 'design_package', descriptor: materialization.package, timestamp });
      const previewArtifact = externalArtifact({ missionId: input.missionId, taskId: input.taskId, attemptId: input.attemptId, id: randomUUID(), kind: 'design_preview', descriptor: materialization.preview, timestamp });
      const contractArtifact = externalArtifact({ missionId: input.missionId, taskId: input.taskId, attemptId: input.attemptId, id: randomUUID(), kind: 'design_contract', descriptor: materialization.contract, timestamp });
      database.missionArtifacts.push(packageArtifact, previewArtifact, contractArtifact);
      const revision: DesignRevision = { id: revisionId, missionId: input.missionId, version: database.designRevisions.filter((item) => item.missionId === input.missionId).length + 1, parentRevisionId: currentMission.workflow.latestDesignRevisionId, status: 'draft', sourceTaskId: input.taskId, sourceAttemptId: input.attemptId, packageArtifactId: packageArtifact.id, packageHash: hashDesignArtifact(packageJson), previewArtifactId: previewArtifact.id, previewHash: hashDesignArtifact(previewHtml), contractArtifactId: contractArtifact.id, contractHash: hashDesignArtifact(contractJson), feedbackArtifactId: currentTask.inputArtifactIds.find((id) => database.missionArtifacts.find((artifact) => artifact.id === id)?.kind === 'design_feedback') ?? null, createdAt: timestamp, approvedAt: null, supersededAt: null };
      database.designRevisions.push(revision);
      const decision = acceptDesignRevision({ mission: currentMission, task: currentTask, attempt: currentAttempt, revision, requiredArtifactsPresent: true, hashesMatch: true });
      if (!decision.accepted) throw new Error(`Design finalization rejected: ${decision.reason}`);
      Object.assign(currentMission, decision.value.mission); Object.assign(currentTask, decision.value.task);
      currentTask.outputArtifactIds = [packageArtifact.id, previewArtifact.id, contractArtifact.id];
      currentAttempt.status = 'completed'; currentAttempt.runtimeThreadId = input.result?.threadId ?? null; currentAttempt.usage = input.result?.usage ?? null; currentAttempt.outputArtifactId = packageArtifact.id; currentAttempt.completedAt = timestamp; currentAttempt.updatedAt = timestamp;
      addEvent(database, currentMission, 'attempt_completed', { taskId: currentTask.id, attemptId: currentAttempt.id, agentId: currentAttempt.agentId }, { stage: 'design' });
      addEvent(database, currentMission, 'design_revision_created', { taskId: currentTask.id, attemptId: currentAttempt.id, agentId: currentAttempt.agentId }, { revisionId: revision.id, version: revision.version });
      addEvent(database, currentMission, 'mission_status_changed', { taskId: currentTask.id }, { status: currentMission.status, workflowPhase: currentMission.workflow.phase });
    });
  }

  private async markAttemptFailure(input: DesignFinalizationInput, error: { category: 'agent' | 'infrastructure' | 'cancelled'; message: string }): Promise<void> {
    await this.store.mutate((database) => {
      const mission = database.missions.find((item) => item.id === input.missionId); const task = database.missionTasks.find((item) => item.id === input.taskId); const attempt = database.taskAttempts.find((item) => item.id === input.attemptId);
      if (!mission || !task || !attempt || attempt.status !== 'running' || task.authoritativeAttemptId !== attempt.id) return;
      const timestamp = now(); const safeMessage = safeMissionText(error.message, 4096, this.redactionSecrets).content; attempt.status = error.category === 'cancelled' ? 'cancelled' : 'failed'; attempt.error = { category: error.category, message: safeMessage }; attempt.runtimeThreadId = input.result?.threadId ?? null; attempt.usage = input.result?.usage ?? null; attempt.completedAt = timestamp; attempt.updatedAt = timestamp; task.status = 'failed'; task.updatedAt = timestamp; mission.status = 'paused'; mission.updatedAt = timestamp; addEvent(database, mission, 'attempt_failed', { taskId: task.id, attemptId: attempt.id, agentId: attempt.agentId }, { category: error.category, reason: safeMessage });
    });
  }

  private async markRestorationFailure(input: DesignFinalizationInput, message: string): Promise<void> {
    await this.store.mutate(async (database) => {
      const mission = database.missions.find((item) => item.id === input.missionId); const attempt = database.taskAttempts.find((item) => item.id === input.attemptId); const task = database.missionTasks.find((item) => item.id === input.taskId); if (!mission || !attempt || !task) return;
      const timestamp = now(); attempt.status = 'failed'; attempt.error = { category: 'infrastructure', message: safeMissionText(`Design workspace restoration failed: ${message}`, 4096, this.redactionSecrets).content }; attempt.completedAt = timestamp; attempt.updatedAt = timestamp; task.status = 'failed'; task.updatedAt = timestamp; mission.status = 'recovered_paused'; mission.workspace.revisionStatus = 'uncheckpointed'; mission.workflow.phase = 'designing'; mission.updatedAt = timestamp; addEvent(database, mission, 'attempt_failed', { taskId: task.id, attemptId: attempt.id, agentId: attempt.agentId }, { category: 'infrastructure', reason: 'workspace restoration failed' });
    });
  }

  async submitFeedback(missionId: string, revisionId: string, feedback: string): Promise<void> {
    const bounded = safeMissionText(feedback, MAX_FEEDBACK_BYTES, this.redactionSecrets); if (!bounded.content.trim() || bounded.originalByteLength > MAX_FEEDBACK_BYTES) throw new HttpError(400, 'Feedback must be 1-16384 UTF-8 bytes');
    await this.store.mutate((database) => {
      const mission = database.missions.find((item) => item.id === missionId); const revision = database.designRevisions.find((item) => item.id === revisionId && item.missionId === missionId); if (!mission) throw new HttpError(404, 'Mission not found'); if (!revision) throw new HttpError(404, 'DesignRevision not found');
      const decision = requestDesignRevision({ mission, revisionId }); if (!decision.accepted) throw new HttpError(409, 'Feedback is only accepted for the latest draft', 'DESIGN_REVISION_NOT_CURRENT');
      const taskId = randomUUID(); const timestamp = now(); const content = bounded.content.trim(); const artifact: MissionArtifact = { id: randomUUID(), missionId, taskId, attemptId: null, kind: 'design_feedback', mediaType: 'text/plain', content, storage: { kind: 'inline' }, sha256: createHash('sha256').update(content, 'utf8').digest('hex'), workspaceRevisionId: mission.workspace.currentRevisionId, createdBy: { kind: 'human', agentId: null }, originalByteLength: bounded.originalByteLength, truncated: bounded.truncated, createdAt: timestamp };
      const definition = designTaskDefinition(); const task: MissionTask = { id: taskId, missionId, order: database.missionTasks.filter((item) => item.missionId === missionId).length, stage: 'design', assignedAgentId: mission.workflow.designerAgentId, title: definition.title, instruction: definition.instruction, inputDesignRevisionId: null, inputVerificationRunId: null, inputWorkspaceRevisionId: mission.workspace.currentRevisionId, repairCycle: null, status: 'pending', authoritativeAttemptId: null, authorityVersion: 0, inputArtifactIds: [artifact.id], outputArtifactIds: [], outputWorkspaceRevisionId: null, createdAt: timestamp, updatedAt: timestamp, startedAt: null, completedAt: null };
      database.missionArtifacts.push(artifact); database.missionTasks.push(task); revision.status = 'superseded'; revision.supersededAt = timestamp; Object.assign(mission.workflow, decision.value); mission.currentTaskId = task.id; mission.status = 'paused'; mission.updatedAt = timestamp; addEvent(database, mission, 'design_feedback_submitted', { taskId: task.id, actor: 'human' }, { revisionId, feedbackArtifactId: artifact.id });
    });
  }

  async approve(missionId: string, revisionId: string, reviewedSurfaceIds: string[]): Promise<void> {
    if (!Array.isArray(reviewedSurfaceIds)) throw new HttpError(400, 'Reviewed surface acknowledgments are required', 'DESIGN_APPROVAL_DENIED');
    const snapshot = this.store.snapshot(); const mission = snapshot.missions.find((item) => item.id === missionId); const revision = snapshot.designRevisions.find((item) => item.id === revisionId && item.missionId === missionId); if (!mission) throw new HttpError(404, 'Mission not found'); if (!revision) throw new HttpError(404, 'DesignRevision not found');
    const resolved = resolveDesignReferenceMaterialization({ revision, artifacts: snapshot.missionArtifacts }); if (!resolved.ok) throw new HttpError(409, 'Design reference artifacts are unavailable', 'DESIGN_REFERENCE_INVALID', { reason: resolved.reason }); const materialization = resolved.materialization;
    if (!(await this.references.verify(materialization))) throw new HttpError(409, 'Design reference integrity check failed', 'DESIGN_REFERENCE_INVALID');
    const packageValue = parseDesignPackage(await this.references.read(materialization.package, 768 * 1024));
    const expectedSurfaceIds = packageValue.surfaces.map((surface) => surface.id).sort();
    const acknowledged = [...reviewedSurfaceIds].sort();
    if (acknowledged.length !== expectedSurfaceIds.length || new Set(acknowledged).size !== acknowledged.length || acknowledged.some((id, index) => id !== expectedSurfaceIds[index])) throw new HttpError(409, 'Every protected design surface must be reviewed before atomic approval', 'DESIGN_APPROVAL_DENIED');
    await this.store.mutate(async (database) => {
      const currentMission = database.missions.find((item) => item.id === missionId)!; const currentRevision = database.designRevisions.find((item) => item.id === revisionId && item.missionId === missionId)!; const revisions = database.designRevisions.filter((item) => item.missionId === missionId).sort((a, b) => a.version - b.version);
      if (revisions.at(-1)?.id !== revisionId || revisions.at(-1)?.status !== 'draft') throw new HttpError(409, 'DesignRevision is not the latest draft', 'DESIGN_REVISION_NOT_CURRENT');
      if (!(await this.references.verify(materialization))) throw new HttpError(409, 'Design reference integrity check failed', 'DESIGN_REFERENCE_INVALID');
      const decision = approveDesignRevision({ mission: currentMission, revision: currentRevision, requiredArtifactsPresent: true, hashesMatch: true }); if (!decision.accepted) throw new HttpError(409, 'DesignRevision cannot be approved', 'DESIGN_APPROVAL_DENIED');
      const timestamp = now(); currentRevision.status = 'approved'; currentRevision.approvedAt = timestamp; currentRevision.reviewedSurfaceIds = acknowledged; currentRevision.reviewedBundleHash = currentRevision.packageHash; Object.assign(currentMission.workflow, decision.value); const definition = { title: 'Implementation', instruction: 'Implement the approved DesignRevision in the Mission workspace. The approved reference is immutable and is not writable by the Agent.' }; const task: MissionTask = { id: randomUUID(), missionId, order: database.missionTasks.filter((item) => item.missionId === missionId).length, stage: 'implement', assignedAgentId: currentMission.workflow.builderAgentId, title: definition.title, instruction: definition.instruction, inputDesignRevisionId: revisionId, inputVerificationRunId: null, inputWorkspaceRevisionId: currentMission.workspace.currentRevisionId, repairCycle: null, status: 'pending', authoritativeAttemptId: null, authorityVersion: 0, inputArtifactIds: [currentRevision.packageArtifactId, currentRevision.previewArtifactId, currentRevision.contractArtifactId], outputArtifactIds: [], outputWorkspaceRevisionId: null, createdAt: timestamp, updatedAt: timestamp, startedAt: null, completedAt: null }; database.missionTasks.push(task); currentMission.currentTaskId = task.id; currentMission.status = 'paused'; currentMission.updatedAt = timestamp; addEvent(database, currentMission, 'design_approved', { taskId: task.id, actor: 'human' }, { revisionId, implementationTaskId: task.id, reviewedSurfaceCount: acknowledged.length });
    });
  }

  async getReference(missionId: string, revisionId: string): Promise<{ revision: DesignRevision; primarySurfaceId: string; surfaces: Array<{ id: string; title: string; route: string; entrypoint: string; states: string[]; viewport: { width: number; height: number }; previewHtml: string; contractJson: string }>; previewHtml: string; contractJson: string }> {
    const database = this.store.snapshot(); const mission = database.missions.find((item) => item.id === missionId); const revision = database.designRevisions.find((item) => item.id === revisionId && item.missionId === missionId); if (!mission) throw new HttpError(404, 'Mission not found'); if (!revision) throw new HttpError(404, 'DesignRevision not found');
    const resolved = resolveDesignReferenceMaterialization({ revision, artifacts: database.missionArtifacts }); if (!resolved.ok) throw new HttpError(409, 'Design reference artifacts are unavailable', 'DESIGN_REFERENCE_INVALID', { reason: resolved.reason }); const packageJson = await this.references.read(resolved.materialization.package, 768 * 1024); const packageValue = parseDesignPackage(packageJson);
    const preview = await this.references.read(resolved.materialization.preview, 768 * 1024); const contract = await this.references.read(resolved.materialization.contract, 64 * 1024); const surfaces = packageValue.surfaces.map((surface) => ({ id: surface.id, title: surface.title, route: surface.route, entrypoint: surface.entrypoint, states: [...surface.states], viewport: { ...surface.contract.viewport }, previewHtml: createSurfacePreviewHtml(surface), contractJson: canonicalizeDesignContract(surface.contract) })); return { revision, primarySurfaceId: packageValue.primarySurfaceId, surfaces, previewHtml: preview, contractJson: contract };
  }
}
