import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import { completeMissionAfterPublication } from './intent-workflow-state.js';
import { addEvent, safeMissionText } from './mission-evidence.js';
import { currentImplementationAcceptance } from './mission-implementation-review.js';
import { JsonStore } from './store.js';
import type { AgentWorkspacePublication, VerificationRun } from './types.js';
import { WorkspaceManager } from './workspace.js';
import { inspectWorkspaceProjection } from './workspace-projection.js';

const now = () => new Date().toISOString();

export class MissionContinuationService {
  private readonly active = new Map<string, Promise<void>>();
  constructor(private readonly store: JsonStore, private readonly workspaces: WorkspaceManager, private readonly redactionSecrets: readonly string[] = []) {}

  async start(missionId: string, verificationRunId: string): Promise<void> {
    const initial = this.store.snapshot();
    const initialVerification = initial.verificationRuns.find((item) => item.id === verificationRunId && item.missionId === missionId);
    const initialRevision = initialVerification ? initial.missionWorkspaceRevisions.find((item) => item.id === initialVerification.workspaceRevisionId && item.missionId === missionId) : null;
    if (!initialRevision) throw new HttpError(409, 'Mission continuation workspace revision is unavailable');
    const initialSourceRoot = await this.workspaces.resolveMissionRevision(missionId, initialRevision);
    const expectedPublishedWorkspaceHash = (await inspectWorkspaceProjection(initialSourceRoot)).contentHash;
    const publication = await this.store.mutate((database) => {
      const mission = database.missions.find((item) => item.id === missionId);
      const verification = database.verificationRuns.find((item) => item.id === verificationRunId && item.missionId === missionId);
      if (!mission || !verification) throw new HttpError(404, 'Mission continuation authority not found');
      const existing = database.agentWorkspacePublications.find((item) => item.missionId === missionId);
      if (existing) {
        if (existing.verificationRunId !== verificationRunId) throw new HttpError(409, 'Mission continuation is bound to another verification');
        return structuredClone(existing);
      }
      const acceptance = currentImplementationAcceptance({ mission, verificationRuns: database.verificationRuns, events: database.missionEvents });
      const workspaceRevision = database.missionWorkspaceRevisions.find((item) => item.id === verification.workspaceRevisionId && item.missionId === missionId);
      if (!acceptance || verification.status !== 'passed' || mission.status !== 'paused' || mission.workflow.phase !== 'verifying' || mission.workflow.currentVerificationRunId !== verification.id || mission.workflow.approvedDesignRevisionId !== verification.designRevisionId || mission.workflow.implementedWorkspaceRevisionId !== verification.workspaceRevisionId || mission.workspace.currentRevisionId !== verification.workspaceRevisionId || !workspaceRevision || !mission.workspace.source.contentHash) throw new HttpError(409, 'Mission continuation is not authorized', 'MISSION_STAGE_UNAVAILABLE');
      const timestamp = now();
      const record: AgentWorkspacePublication = { id: randomUUID(), missionId, agentId: mission.workspace.source.agentId, designRevisionId: verification.designRevisionId, workspaceRevisionId: verification.workspaceRevisionId, verificationRunId: verification.id, expectedAgentWorkspaceHash: mission.workspace.source.contentHash, expectedPublishedWorkspaceHash, status: 'pending', attemptCount: 0, threadDisposition: 'reset', error: null, createdAt: timestamp, updatedAt: timestamp, completedAt: null };
      database.agentWorkspacePublications.push(record);
      addEvent(database, mission, 'workspace_publication_started', {}, { publicationId: record.id, verificationRunId: verification.id, workspaceRevisionId: verification.workspaceRevisionId });
      return structuredClone(record);
    });
    await this.execute(publication.id);
  }

  async retry(missionId: string): Promise<void> {
    const publication = this.store.snapshot().agentWorkspacePublications.find((item) => item.missionId === missionId);
    if (!publication) throw new HttpError(404, 'Mission workspace publication not found');
    if (publication.status === 'published') return;
    await this.execute(publication.id);
  }

  private async execute(publicationId: string): Promise<void> {
    const running = this.active.get(publicationId);
    if (running) return running;
    const execution = this.perform(publicationId).finally(() => this.active.delete(publicationId));
    this.active.set(publicationId, execution);
    return execution;
  }

  private async perform(publicationId: string): Promise<void> {
    const publication = await this.store.mutate((database) => {
      const record = database.agentWorkspacePublications.find((item) => item.id === publicationId);
      if (!record) throw new HttpError(404, 'Mission workspace publication not found');
      if (record.status === 'published') return structuredClone(record);
      const mission = database.missions.find((item) => item.id === record.missionId);
      const verification = database.verificationRuns.find((item) => item.id === record.verificationRunId);
      if (!mission || !verification || mission.status === 'completed' || mission.workflow.currentVerificationRunId !== verification.id || verification.status !== 'passed') throw new HttpError(409, 'Mission workspace publication is stale');
      record.status = 'publishing'; record.attemptCount += 1; record.error = null; record.updatedAt = now();
      return structuredClone(record);
    });
    if (publication.status === 'published') return;
    try {
      const snapshot = this.store.snapshot();
      const revision = snapshot.missionWorkspaceRevisions.find((item) => item.id === publication.workspaceRevisionId && item.missionId === publication.missionId);
      if (!revision) throw new Error('Published Mission workspace revision is unavailable');
      const sourceRoot = await this.workspaces.resolveMissionRevision(publication.missionId, revision);
      const recovery = await this.workspaces.recoverAgentWorkspacePublication({ transactionId: publication.id, agentId: publication.agentId, expectedAgentHash: publication.expectedAgentWorkspaceHash, expectedPublishedHash: publication.expectedPublishedWorkspaceHash });
      if (recovery.state === 'ambiguous') throw new Error('Mission workspace publication requires operator reconciliation');
      if (recovery.state === 'original') {
        const receipt = await this.workspaces.publishAgentWorkspace({ transactionId: publication.id, agentId: publication.agentId, sourceRoot, expectedAgentHash: publication.expectedAgentWorkspaceHash, expectedSourceHash: publication.expectedPublishedWorkspaceHash });
        if (receipt.publishedHash !== publication.expectedPublishedWorkspaceHash) throw new Error('Published Mission workspace hash does not match the verified revision');
      }
      await this.complete(publication.id);
      await this.workspaces.finalizeAgentWorkspacePublication(publication.id).catch(() => undefined);
    } catch (error) {
      const bounded = safeMissionText(error instanceof Error ? error.message : String(error), 1_024, this.redactionSecrets).content;
      await this.store.mutate((database) => {
        const record = database.agentWorkspacePublications.find((item) => item.id === publication.id);
        const mission = database.missions.find((item) => item.id === publication.missionId);
        if (!record || record.status === 'published' || !mission) return;
        record.status = 'failed'; record.error = bounded; record.updatedAt = now();
        mission.status = 'recovered_paused'; mission.updatedAt = record.updatedAt;
        addEvent(database, mission, 'workspace_publication_failed', {}, { publicationId: record.id, reason: bounded });
      });
    }
  }

  private async complete(publicationId: string): Promise<void> {
    await this.store.mutate((database) => {
      const publication = database.agentWorkspacePublications.find((item) => item.id === publicationId);
      if (!publication) throw new Error('Mission workspace publication disappeared');
      if (publication.status === 'published') return;
      const mission = database.missions.find((item) => item.id === publication.missionId);
      const verification = database.verificationRuns.find((item) => item.id === publication.verificationRunId) as VerificationRun | undefined;
      const agent = database.agents.find((item) => item.id === publication.agentId);
      if (!mission || !verification || !agent || publication.status !== 'publishing') throw new Error('Mission workspace publication authority changed');
      if (mission.status === 'recovered_paused') mission.status = 'paused';
      const decision = completeMissionAfterPublication({ mission, verification, publicationPublished: true });
      if (!decision.accepted) throw new Error('Mission completion authority changed during workspace publication');
      const timestamp = now();
      publication.status = 'published'; publication.error = null; publication.updatedAt = timestamp; publication.completedAt = timestamp;
      agent.codexThreadId = null; agent.status = 'ready'; agent.lastError = null; agent.updatedAt = timestamp;
      Object.assign(mission, decision.value); mission.completedAt = timestamp; mission.updatedAt = timestamp;
      addEvent(database, mission, 'workspace_published', {}, { publicationId: publication.id, agentId: agent.id, workspaceRevisionId: publication.workspaceRevisionId, threadDisposition: 'reset' });
      addEvent(database, mission, 'intent_workflow_completed', {}, { verificationRunId: verification.id, publicationId: publication.id });
      addEvent(database, mission, 'participants_released', {});
    });
  }

  async reconcileStartup(): Promise<void> {
    for (const publication of this.store.snapshot().agentWorkspacePublications.filter((item) => item.status !== 'published')) {
      const recovery = await this.workspaces.recoverAgentWorkspacePublication({ transactionId: publication.id, agentId: publication.agentId, expectedAgentHash: publication.expectedAgentWorkspaceHash, expectedPublishedHash: publication.expectedPublishedWorkspaceHash });
      if (recovery.state === 'published') {
        await this.store.mutate((database) => { const record = database.agentWorkspacePublications.find((item) => item.id === publication.id); if (record && record.status !== 'published') record.status = 'publishing'; });
        await this.complete(publication.id).catch(() => undefined);
        await this.workspaces.finalizeAgentWorkspacePublication(publication.id).catch(() => undefined);
      } else {
        await this.store.mutate((database) => { const record = database.agentWorkspacePublications.find((item) => item.id === publication.id); const mission = database.missions.find((item) => item.id === publication.missionId); if (record && ['pending', 'publishing'].includes(record.status)) { record.status = recovery.state === 'original' ? 'interrupted' : 'failed'; record.error = recovery.state === 'original' ? 'Workspace publication was interrupted by server restart' : 'Workspace publication requires operator reconciliation'; record.updatedAt = now(); if (mission && mission.status !== 'completed') { mission.status = 'recovered_paused'; mission.updatedAt = record.updatedAt; } } });
      }
    }
  }
}
