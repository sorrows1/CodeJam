import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HttpError } from './errors.js';
import { addEvent, safeMissionText } from './mission-evidence.js';
import { boundedMissionSection, designTaskDefinition, MAX_GOAL_BYTES, MAX_INSTRUCTIONS_BYTES } from './mission-prompt.js';
import { MissionExecutionService } from './mission-execution.js';
import { MissionRecoveryService, type RecoveryRequest } from './mission-recovery-service.js';
import { JsonStore } from './store.js';
import type { AgentWorkspacePublication, DesignRevision, Mission, MissionArtifact, MissionEvent, MissionRecoveryCommand, MissionTask, MissionWorkspaceRevision, TaskAttempt, VerificationRun } from './types.js';
import { findReservingMission } from './mission-state.js';
import type { RunExecutionPort } from './run-execution.js';
import { WorkspaceManager } from './workspace.js';
import { summarizeMissionUsage } from './mission-budget.js';
import { deriveMissionRecoveryCapabilities, type MissionRecoveryCapabilities } from './mission-recovery-policy.js';
import { projectMissionProduct, type MissionProductView } from './mission-presentation.js';
import { projectMissionTimeline, type MissionTimeline } from './mission-timeline.js';
import { createIntentWorkflowState, prepareImplementationRepair } from './intent-workflow-state.js';
import { MissionRuntimeObservability, type MissionRuntimeActivityView } from './mission-runtime-observability.js';
import { projectMissionInspector, type MissionInspectorProjection } from './mission-inspector.js';
import { projectMissionHistory, type MissionHistoryEntry } from './mission-history.js';
import { buildImplementationAdmissionFacts, decideImplementationAdmission, projectImplementationAdmission } from './mission-implementation-admission.js';
import { automaticImplementationRepairUsed, currentImplementationAcceptance, humanImplementationRepairUsed, implementationChangeRequestRun, implementationReviewAvailable } from './mission-implementation-review.js';
import { createHumanImplementationFeedbackArtifact, createRepairTask } from './mission-repair.js';
import { DesignGovernanceService } from './design-governance-service.js';
import { FileDesignReferenceStore } from './file-design-reference-store.js';
import type { DesignReferenceStore } from './design-reference-store.js';
import { MissionVerificationService } from './mission-verification.js';
import { PlaywrightVerifier, type BrowserVerifier } from './verification.js';
import { FileMissionEvidenceStore } from './mission-evidence-store.js';
import { RevisionPreviewService, type PreviewRuntime, type PreviewTarget } from './revision-preview-service.js';
import { MissionContinuationService } from './mission-continuation-service.js';

const now = () => new Date().toISOString();
const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IMPLEMENTATION_FEEDBACK_BYTES = 4 * 1024;

export interface CreateMissionInput { goal: string; sourceAgentId: string; designerAgentId: string; builderAgentId: string; tokenBudget?: number | null | undefined; promotion?: { admissionId: string; workspaceHash: string; agentUpdatedAt: string; threadId: string | null } | undefined; }
export interface ImplementationReviewInput { decision: 'accept' | 'request_changes'; feedback?: string | undefined; }
export interface MissionAgentAvailability { agentId: string; availableForMission: boolean; reservingMissionId: string | null; reservingMissionGoal: string | null; reason: 'available' | 'agent_not_ready' | 'reserved'; }
export interface MissionSummary { mission: Mission; product: Pick<MissionProductView, 'state' | 'headline' | 'currentStage' | 'completionAuthority'>; }
export interface MissionDetail { history: MissionHistoryEntry[]; }
export interface MissionDetail { inspector: MissionInspectorProjection; mission: Mission; product: MissionProductView; publication: AgentWorkspacePublication | null; budget: MissionBudgetView; timeline: MissionTimeline; runtimeActivity: MissionRuntimeActivityView | null; tasks: MissionTask[]; attempts: TaskAttempt[]; artifacts: MissionArtifact[]; designRevisions: DesignRevision[]; verificationRuns: VerificationRun[]; currentArtifactId: string | null; events: MissionEvent[]; revisions: Array<{ id: string; sequence: number; label: string; origin: MissionWorkspaceRevision['origin']; boundaries: MissionWorkspaceRevision['boundaries']; parentRevisionId: string | null; restoredFromRevisionId: string | null; createdBy: MissionWorkspaceRevision['createdBy']; taskId: string | null; createdAt: string }>; workspaceInspection: { state: 'clean' | 'changed' | 'unavailable' | 'unchecked_running'; currentRevisionId: string | null; displayPath: string }; currentRevisionId: string | null; displayPath: string; recovery: Omit<MissionRecoveryCapabilities, 'verificationAdmission'> & { activeCommand: MissionRecoveryCommand | null } }
export interface MissionBudgetView { tokenLimit: number | null; usage: ReturnType<typeof summarizeMissionUsage>; remainingTokens: number | null; exhausted: boolean; mayOvershootActiveAttempt: true; policy: 'measured_total_exhausted'; }

export class MissionService {
  readonly execution: MissionExecutionService;
  readonly recovery: MissionRecoveryService;
  readonly design: DesignGovernanceService;
  readonly verification: MissionVerificationService;
  readonly continuation: MissionContinuationService;
  private readonly references: DesignReferenceStore;
  private readonly evidence: FileMissionEvidenceStore;
  private readonly previews: RevisionPreviewService;
  private readonly runtimeActivity = new MissionRuntimeObservability();
  private readonly promotionExecutions = new Map<string, Promise<Mission>>();

  constructor(
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    execution: RunExecutionPort,
    references?: DesignReferenceStore,
    private readonly redactionSecrets: readonly string[] = [],
    verifier?: BrowserVerifier,
    previewRuntime: PreviewRuntime = { async prepare() { throw new Error('Container preview Runtime is unavailable'); } },
  ) {
    const referenceStore = references ?? new FileDesignReferenceStore(path.join(path.dirname(workspaces.missionWorkspacePath(randomUUID())), '..', '.design-references'));
    this.references = referenceStore;
    this.evidence = new FileMissionEvidenceStore(path.join(path.dirname(workspaces.missionWorkspacePath(randomUUID())), '..', '.mission-evidence'));
    this.previews = new RevisionPreviewService(store, workspaces, referenceStore, previewRuntime, path.join(path.dirname(workspaces.missionWorkspacePath(randomUUID())), '..', '.revision-previews'), Date.now, redactionSecrets);
    this.design = new DesignGovernanceService(store, workspaces, referenceStore, redactionSecrets);
    this.continuation = new MissionContinuationService(store, workspaces, redactionSecrets);
    let executionService!: MissionExecutionService;
    const verificationService = new MissionVerificationService(
      store,
      workspaces,
      referenceStore,
      verifier ?? new PlaywrightVerifier(),
      this.evidence,
      redactionSecrets,
      async (missionId) => { await executionService.startCurrentTask(missionId); },
      async (missionId, verificationRunId) => { await this.continuation.start(missionId, verificationRunId); },
    );
    executionService = new MissionExecutionService(
      store,
      workspaces,
      execution,
      this.design,
      referenceStore,
      redactionSecrets,
      this.runtimeActivity,
      async (missionId) => { await verificationService.start(missionId); },
    );
    this.execution = executionService;
    this.verification = verificationService;
    this.recovery = new MissionRecoveryService(store, workspaces, this.execution, referenceStore, redactionSecrets);
  }

  async getEvidence(missionId: string, artifactId: string): Promise<{ bytes: Buffer; mediaType: string }> {
    const database = this.store.snapshot();
    if (!database.missions.some((mission) => mission.id === missionId)) throw new HttpError(404, 'Mission not found');
    const artifact = database.missionArtifacts.find((item) => item.id === artifactId && item.missionId === missionId);
    if (!artifact || artifact.storage.kind !== 'external' || !['actual_screenshot', 'reference_screenshot'].includes(artifact.kind)) throw new HttpError(404, 'Mission evidence not found');
    try { return { bytes: await this.evidence.read(artifact.storage.key, artifact.sha256, artifact.originalByteLength), mediaType: artifact.mediaType }; }
    catch { throw new HttpError(410, 'Mission evidence is unavailable'); }
  }
  async createPreview(missionId: string, target: PreviewTarget) { try { return await this.previews.create(missionId, target); } catch (error) { throw new HttpError(error instanceof Error && error.message.includes('limit') ? 409 : 422, error instanceof Error ? error.message : 'Preview unavailable'); } }
  async getPreview(missionId: string, sessionId: string) { try { return await this.previews.get(missionId, sessionId); } catch { throw new HttpError(404, 'Preview session not found'); } }
  async stopPreview(missionId: string, sessionId: string) { try { await this.previews.stop(missionId, sessionId); } catch { throw new HttpError(404, 'Preview session not found'); } }
  async getPreviewAsset(missionId: string, sessionId: string, token: string, assetPath: string) { try { return await this.previews.asset(missionId, sessionId, token, assetPath); } catch (error) { throw new HttpError(error instanceof Error && error.message.includes('authentication') ? 401 : 404, 'Preview asset unavailable'); } }
  async createAgentPreview(agentId: string) { try { return await this.previews.createAgent(agentId); } catch (error) { throw new HttpError(error instanceof Error && error.message.includes('limit') ? 409 : 422, error instanceof Error ? error.message : 'Preview unavailable'); } }
  async stopAgentPreview(agentId: string, sessionId: string) { try { await this.previews.stop(agentId, sessionId); } catch { throw new HttpError(404, 'Preview session not found'); } }
  async getAgentPreviewAsset(agentId: string, sessionId: string, token: string, assetPath: string) { try { return await this.previews.asset(agentId, sessionId, token, assetPath); } catch (error) { throw new HttpError(error instanceof Error && error.message.includes('authentication') ? 401 : 404, 'Preview asset unavailable'); } }
  async shutdown(): Promise<void> { await this.previews.stopAll(); }

  listMissions(): Mission[] { return this.store.snapshot().missions.filter((mission) => mission.workspace.state !== 'provisioning').sort((left, right) => right.createdAt.localeCompare(left.createdAt)); }
  listMissionSummaries(): MissionSummary[] { return this.listMissions().map((mission) => { const product = this.getMission(mission.id).product; return { mission, product: { state: product.state, headline: product.headline, currentStage: product.currentStage, completionAuthority: product.completionAuthority } }; }); }
  listAgentAvailability(): MissionAgentAvailability[] {
    const database = this.store.snapshot();
    return database.agents.map((agent) => {
      const reserving = findReservingMission(database.missions, agent.id);
      if (reserving) return { agentId: agent.id, availableForMission: false, reservingMissionId: reserving.id, reservingMissionGoal: reserving.goal, reason: 'reserved' };
      if (agent.status !== 'ready') return { agentId: agent.id, availableForMission: false, reservingMissionId: null, reservingMissionGoal: null, reason: 'agent_not_ready' };
      return { agentId: agent.id, availableForMission: true, reservingMissionId: null, reservingMissionGoal: null, reason: 'available' };
    });
  }

  getMission(id: string): MissionDetail {
    const database = this.store.snapshot();
    const mission = database.missions.find((item) => item.id === id);
    if (!mission) throw new HttpError(404, 'Mission not found');
    const tasks = database.missionTasks.filter((item) => item.missionId === id).sort((a, b) => a.order - b.order);
    const revisions = database.missionWorkspaceRevisions.filter((item) => item.missionId === id).sort((a, b) => a.sequence - b.sequence);
    const commands = database.missionRecoveryCommands.filter((item) => item.missionId === id);
    const active = mission.activeRecoveryCommandId ? commands.find((item) => item.id === mission.activeRecoveryCommandId) ?? null : null;
    const currentRevision = revisions.find((revision) => revision.id === mission.workspace.currentRevisionId);
    const inspectionState = mission.workspace.revisionStatus === 'unversioned' || mission.workspace.revisionStatus === 'uncheckpointed' ? 'unavailable' : this.workspaces.inspectMissionWorkspaceSync(id, currentRevision?.contentHash ?? null, mission.status === 'running').state;
    const artifacts = database.missionArtifacts.filter((item) => item.missionId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const events = database.missionEvents.filter((item) => item.missionId === id).sort((a, b) => a.sequence - b.sequence);
    const timeline = projectMissionTimeline(events, 100);
    const usage = summarizeMissionUsage(id, database.runs);
    const budget: MissionBudgetView = { tokenLimit: mission.tokenBudget, usage, remainingTokens: mission.tokenBudget === null ? null : Math.max(0, mission.tokenBudget - usage.totalTokens), exhausted: mission.tokenBudget !== null && usage.totalTokens >= mission.tokenBudget, mayOvershootActiveAttempt: true, policy: 'measured_total_exhausted' };
    const attempts = database.taskAttempts.filter((item) => item.missionId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const missionRuns = database.runs.filter((item) => item.context.kind === 'mission' && item.context.missionId === id);
    const designRevisions = database.designRevisions.filter((item) => item.missionId === id).sort((a, b) => a.version - b.version);
    const verificationRuns = database.verificationRuns.filter((item) => item.missionId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const currentTask = tasks.find((item) => item.id === mission.currentTaskId) ?? null;
    const taskInputRevision = currentTask?.inputWorkspaceRevisionId ? revisions.find((item) => item.id === currentTask.inputWorkspaceRevisionId) ?? null : currentRevision ?? null;
    const currentVerification = mission.workflow.currentVerificationRunId ? verificationRuns.find((item) => item.id === mission.workflow.currentVerificationRunId) ?? null : null;
    const capabilities = deriveMissionRecoveryCapabilities({ missions: database.missions, mission, currentTask, attempts, runs: missionRuns, currentVerification, workspaceRevision: taskInputRevision, workspaceState: inspectionState, assignedAgent: currentTask ? database.agents.find((item) => item.id === currentTask.assignedAgentId) ?? null : null, measuredTokens: usage.totalTokens, activeCommand: active });
    const recovery = { activeCommand: active, retryCurrentDesign: capabilities.retryCurrentDesign, resumeImplementation: capabilities.resumeImplementation, retryVerification: capabilities.retryVerification, stopPreserving: capabilities.stopPreserving };
    const admissionFacts = buildImplementationAdmissionFacts({ database, mission, workspaceState: inspectionState });
    const admissionGuard = decideImplementationAdmission(admissionFacts);
    const implementationAdmission = projectImplementationAdmission(admissionGuard.accepted ? decideImplementationAdmission(admissionFacts, this.references.verifySync(admissionGuard.materialization)) : admissionGuard);
    const product = projectMissionProduct({ mission, tasks, attempts, designRevisions, verificationRuns, events, recovery: capabilities, implementationAdmission, workspaceState: inspectionState });
    const runtimeActivity = this.runtimeActivity.getForMission(id);
    const inspector = projectMissionInspector({ attempts, designRevisions, verificationRuns, events, currentVerificationRunId: mission.workflow.currentVerificationRunId, runtimeActivity });
    const history = projectMissionHistory({ attempts, verificationRuns, events, currentVerificationRunId: mission.workflow.currentVerificationRunId, runtimeActivity });
    return {
      inspector, history, mission, product, publication: database.agentWorkspacePublications.find((item) => item.missionId === id) ?? null, budget, timeline, runtimeActivity, tasks, attempts, artifacts, designRevisions, verificationRuns,
      currentArtifactId: artifacts.at(-1)?.id ?? null,
      events: events.slice(-100),
      revisions: revisions.map((revision) => ({ id: revision.id, sequence: revision.sequence, label: revision.boundaries.map((boundary) => `${boundary.kind} ${boundary.taskId}`).join(' / '), origin: revision.origin, boundaries: revision.boundaries, parentRevisionId: revision.parentRevisionId, restoredFromRevisionId: revision.restoredFromRevisionId, createdBy: revision.createdBy, taskId: revision.taskId, createdAt: revision.createdAt })),
      workspaceInspection: { state: inspectionState, currentRevisionId: mission.workspace.currentRevisionId, displayPath: this.workspaces.missionWorkspacePath(id) },
      currentRevisionId: mission.workspace.currentRevisionId,
      displayPath: this.workspaces.missionWorkspacePath(id),
      recovery,
    };
  }

  async getMissionWithHistory(id: string): Promise<MissionDetail> {
    const detail = this.getMission(id); const database = this.store.snapshot(); const revisions = new Map(database.missionWorkspaceRevisions.filter((revision) => revision.missionId === id).map((revision) => [revision.id, revision])); const manifests = new Map<string, { files: Array<{ path: string; operation: 'ADDED' | 'MODIFIED' | 'DELETED' | 'WRITE' }>; truncated: boolean }>();
    const visibleAttemptIds = new Set(detail.history.flatMap((entry) => entry.kind === 'attempt' ? [entry.attemptId] : []));
    for (const attempt of detail.attempts.filter((item) => visibleAttemptIds.has(item.id))) { if (attempt.stage === 'design' && database.designRevisions.some((revision) => revision.sourceAttemptId === attempt.id)) { manifests.set(attempt.id, { files: [{ path: '.conductor/design-draft/design-bundle.json', operation: 'WRITE' as const }], truncated: false }); continue; } if (!attempt.inputWorkspaceRevisionId || !attempt.outputWorkspaceRevisionId) continue; const before = revisions.get(attempt.inputWorkspaceRevisionId); const after = revisions.get(attempt.outputWorkspaceRevisionId); if (!before || !after) continue; try { manifests.set(attempt.id, await this.workspaces.compareRevisions(id, before, after, this.redactionSecrets)); } catch { /* Bounded or unverifiable manifests fail closed as unavailable. */ } }
    detail.history = projectMissionHistory({ attempts: detail.attempts, verificationRuns: detail.verificationRuns, events: detail.events, currentVerificationRunId: detail.mission.workflow.currentVerificationRunId, runtimeActivity: detail.runtimeActivity, changedFiles: manifests }); return detail;
  }

  promotePlaygroundImpact(admissionId: string): Promise<Mission> {
    const active = this.promotionExecutions.get(admissionId);
    if (active) return active;
    const execution = this.performPlaygroundPromotion(admissionId).finally(() => this.promotionExecutions.delete(admissionId));
    this.promotionExecutions.set(admissionId, execution);
    return execution;
  }

  private async performPlaygroundPromotion(admissionId: string): Promise<Mission> {
    const snapshot = this.store.snapshot();
    const admission = snapshot.playgroundImpactAdmissions.find((item) => item.id === admissionId);
    if (!admission) throw new HttpError(404, 'Playground impact admission not found');
    if (admission.missionId) {
      const existing = snapshot.missions.find((item) => item.id === admission.missionId);
      if (existing) return existing;
    }
    if (admission.decision !== 'governed' && !(admission.decision === 'confirmation_required' && admission.status === 'confirmation_required')) throw new HttpError(409, 'Impact admission is not eligible for Mission promotion');
    const agent = snapshot.agents.find((item) => item.id === admission.agentId);
    if (!agent || agent.status !== 'ready' || agent.updatedAt !== admission.agentUpdatedAt || agent.codexThreadId !== admission.threadId) throw new HttpError(409, 'Agent binding changed after impact proposal', 'PLAYGROUND_IMPACT_STALE');
    const workspaceHash = await this.workspaces.fingerprintAgentWorkspace(agent.id);
    if (workspaceHash !== admission.workspaceHash) {
      await this.store.mutate((database) => { const current = database.playgroundImpactAdmissions.find((item) => item.id === admissionId); if (current && !current.missionId) { current.status = 'stale'; current.reason = 'Agent workspace changed after impact proposal'; current.updatedAt = now(); current.completedAt = current.updatedAt; } });
      throw new HttpError(409, 'Agent workspace changed after impact proposal', 'PLAYGROUND_IMPACT_STALE');
    }
    return this.createMission({ goal: admission.prompt, sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id, promotion: { admissionId, workspaceHash, agentUpdatedAt: admission.agentUpdatedAt, threadId: admission.threadId } });
  }

  async createMission(input: CreateMissionInput): Promise<Mission> {
    const goal = input.goal.trim();
    if (!goal || bytes(goal) > MAX_GOAL_BYTES) throw new HttpError(400, 'Mission goal must be 1-8192 UTF-8 bytes');
    if (![input.sourceAgentId, input.designerAgentId, input.builderAgentId].every((id) => uuid.test(id))) throw new HttpError(400, 'Mission role Agents must be valid IDs');
    if (input.tokenBudget !== undefined && input.tokenBudget !== null && (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 0)) throw new HttpError(400, 'Mission token budget must be a positive safe integer');
    const sourceAtStart = this.store.snapshot().agents.find((agent) => agent.id === input.sourceAgentId);
    if (!sourceAtStart) throw new HttpError(404, 'Mission source Agent not found');
    const sourceHash = await this.workspaces.fingerprintAgentWorkspace(input.sourceAgentId);
    if (input.promotion && input.promotion.workspaceHash !== sourceHash) throw new HttpError(409, 'Impact promotion workspace binding is stale', 'PLAYGROUND_IMPACT_STALE');
    const id = randomUUID();
    const timestamp = now();
    const mission: Mission = { id, goal: safeMissionText(goal, MAX_GOAL_BYTES, this.redactionSecrets).content, status: 'pending', participants: [], workflow: createIntentWorkflowState({ designerAgentId: input.designerAgentId, builderAgentId: input.builderAgentId }), workspace: { owner: 'conductor', key: id, state: 'provisioning', source: { kind: 'agent_workspace', agentId: input.sourceAgentId, agentUpdatedAt: sourceAtStart.updatedAt, impactAdmissionId: input.promotion?.admissionId ?? null, contentHash: sourceHash }, currentRevisionId: null, revisionStatus: 'unversioned', nextRevisionSequence: 1 }, currentTaskId: null, nextEventSequence: 1, activeRecoveryCommandId: null, tokenBudget: input.tokenBudget ?? null, createdAt: timestamp, updatedAt: timestamp, startedAt: null, completedAt: null };
    let taskId = '';
    await this.store.mutate((database) => {
      const roleIds = [input.sourceAgentId, input.designerAgentId, input.builderAgentId];
      const participantIds = [...new Set(roleIds)];
      const selected = participantIds.map((agentId) => database.agents.find((agent) => agent.id === agentId));
      if (selected.some((agent) => !agent)) throw new HttpError(404, 'Mission participant Agent not found');
      for (const agent of selected) {
        if (agent!.status !== 'ready') throw new HttpError(409, 'Mission participant Agent must be ready');
        const reserving = findReservingMission(database.missions, agent!.id);
        if (reserving) throw new HttpError(409, 'Agent is reserved by Mission ' + reserving.id);
      }
      const source = selected.find((agent) => agent!.id === input.sourceAgentId)!;
      if (input.promotion) {
        const admission = database.playgroundImpactAdmissions.find((item) => item.id === input.promotion!.admissionId && item.agentId === source.id);
        if (!admission || admission.missionId || admission.workspaceHash !== input.promotion.workspaceHash || admission.agentUpdatedAt !== input.promotion.agentUpdatedAt || admission.threadId !== input.promotion.threadId || source.updatedAt !== admission.agentUpdatedAt || source.codexThreadId !== admission.threadId) throw new HttpError(409, 'Impact promotion binding is stale', 'PLAYGROUND_IMPACT_STALE');
        admission.status = 'promoting'; admission.decision = 'governed'; admission.missionId = id; admission.updatedAt = timestamp;
      }
      mission.workspace.source.agentUpdatedAt = source.updatedAt;
      mission.participants = selected.map((agent, order) => ({ agentId: agent!.id, order, snapshot: { name: boundedMissionSection(agent!.name, 4 * 1024), description: boundedMissionSection(agent!.description, 4 * 1024), instructions: boundedMissionSection(agent!.instructions, MAX_INSTRUCTIONS_BYTES), agentUpdatedAt: agent!.updatedAt } }));
      database.missions.push(mission);
      addEvent(database, mission, 'mission_created', {});
      for (const agentId of participantIds) addEvent(database, mission, 'participants_reserved', { agentId });
      taskId = randomUUID();
      const definition = designTaskDefinition();
      database.missionTasks.push({ id: taskId, missionId: id, order: 0, stage: 'design', assignedAgentId: input.designerAgentId, title: definition.title, instruction: definition.instruction, inputDesignRevisionId: null, inputVerificationRunId: null, inputWorkspaceRevisionId: null, repairCycle: null, status: 'pending', authoritativeAttemptId: null, authorityVersion: 0, inputArtifactIds: [], outputArtifactIds: [], outputWorkspaceRevisionId: null, createdAt: timestamp, updatedAt: timestamp, startedAt: null, completedAt: null });
      mission.currentTaskId = taskId;
    });
    try {
      await this.workspaces.createMissionWorkspace(id, input.sourceAgentId, sourceHash);
      const revision = await this.workspaces.captureMissionRevision({ missionId: id, revision: { id: randomUUID(), missionId: id, sequence: 1, parentRevisionId: null, restoredFromRevisionId: null, origin: 'mission_start', boundaries: [{ kind: 'before_task', taskId }], taskId, attemptId: null, interventionArtifactId: null, createdBy: 'system', createdAt: now() } });
      return await this.store.mutate((database) => {
        const stored = database.missions.find((item) => item.id === id);
        const task = database.missionTasks.find((item) => item.id === taskId);
        if (!stored || !task || stored.workspace.state !== 'provisioning' || stored.currentTaskId !== taskId || !this.isCreationOnly(database, id)) throw new Error('Mission provisioning authority changed before publication');
        database.missionWorkspaceRevisions.push(revision);
        stored.workspace.state = 'ready';
        stored.workspace.currentRevisionId = revision.id;
        stored.workspace.revisionStatus = 'clean';
        stored.workspace.nextRevisionSequence = 2;
        task.inputWorkspaceRevisionId = revision.id;
        stored.updatedAt = now();
        if (input.promotion) { const admission = database.playgroundImpactAdmissions.find((item) => item.id === input.promotion!.admissionId && item.missionId === id); if (!admission) throw new Error('Impact promotion authority changed before publication'); admission.status = 'promoted'; admission.completedAt = stored.updatedAt; admission.updatedAt = stored.updatedAt; }
        addEvent(database, stored, 'workspace_ready', {});
        addEvent(database, stored, 'revision_created', {}, { revisionId: revision.id, origin: revision.origin });
        return structuredClone(stored);
      });
    } catch (error) {
      const diagnostic = this.provisioningDiagnostic(error);
      const compensated = await this.compensateProvisioning(id, diagnostic);
      throw new HttpError(500, compensated ? `Mission workspace could not be provisioned: ${diagnostic}` : `Mission workspace could not be provisioned and cleanup is incomplete: ${diagnostic}`);
    }
  }

  private isCreationOnly(database: ReturnType<JsonStore['snapshot']>, missionId: string): boolean {
    const mission = database.missions.find((item) => item.id === missionId);
    if (!mission || mission.workspace.state === 'ready' || mission.workspace.currentRevisionId !== null || mission.workflow.approvedDesignRevisionId !== null || mission.workflow.latestDesignRevisionId !== null || mission.workflow.implementedWorkspaceRevisionId !== null || mission.workflow.currentVerificationRunId !== null) return false;
    return !database.taskAttempts.some((item) => item.missionId === missionId)
      && !database.designRevisions.some((item) => item.missionId === missionId)
      && !database.verificationRuns.some((item) => item.missionId === missionId)
      && !database.missionWorkspaceRevisions.some((item) => item.missionId === missionId)
      && !database.missionTasks.some((item) => item.missionId === missionId && item.stage !== 'design');
  }

  private provisioningDiagnostic(error: unknown): string {
    const candidate = error instanceof Error ? error : new Error(String(error));
    const message = safeMissionText(candidate.message, 512, this.redactionSecrets).content;
    if (message.startsWith('Mission source contains an unsupported')) return message;
    const code = (candidate as NodeJS.ErrnoException).code;
    return code ? `${code}: workspace filesystem operation failed` : 'workspace filesystem operation failed';
  }

  private async compensateProvisioning(missionId: string, diagnostic: string): Promise<boolean> {
    let cleanupSucceeded = true;
    try { await this.workspaces.cleanupMissionProvisioning(missionId); } catch { cleanupSucceeded = false; }
    return this.store.mutate((database) => {
      const mission = database.missions.find((item) => item.id === missionId);
      if (!mission) return cleanupSucceeded;
      const creationOnly = this.isCreationOnly(database, missionId);
      if (cleanupSucceeded && creationOnly) {
        for (const admission of database.playgroundImpactAdmissions.filter((item) => item.missionId === missionId)) { admission.missionId = null; admission.status = 'stale'; admission.reason = diagnostic; admission.error = diagnostic; admission.updatedAt = now(); admission.completedAt = admission.updatedAt; }
        database.missions = database.missions.filter((item) => item.id !== missionId);
        database.missionTasks = database.missionTasks.filter((item) => item.missionId !== missionId);
        database.missionEvents = database.missionEvents.filter((item) => item.missionId !== missionId);
        return true;
      }
      mission.status = 'failed';
      mission.workspace.state = 'unavailable';
      mission.updatedAt = now();
      addEvent(database, mission, 'mission_status_changed', {}, { status: 'failed', reason: diagnostic, provisioningCleanupSucceeded: cleanupSucceeded });
      addEvent(database, mission, 'participants_released', {});
      return false;
    });
  }

  async startMission(id: string): Promise<MissionDetail> { await this.execution.startMission(id); return this.getMission(id); }
  async startCurrentTask(id: string): Promise<{ mission: Mission; task: MissionTask; attempt: TaskAttempt }> { return this.execution.startCurrentTask(id); }

  async recover(id: string, request: RecoveryRequest): Promise<{ command: MissionRecoveryCommand; detail: MissionDetail; disposition: 'accepted' | 'replayed' | 'coalesced' }> {
    const result = await this.recovery.apply(id, request);
    if (request.action === 'resume' && result.command.status === 'completed') await this.startPrecheckIfNeeded(id);
    return { ...result, detail: this.getMission(id) };
  }

  async submitDesignFeedback(missionId: string, revisionId: string, feedback: string): Promise<MissionDetail> { await this.design.submitFeedback(missionId, revisionId, feedback); return this.getMission(missionId); }
  async approveDesignRevision(missionId: string, revisionId: string, reviewedSurfaceIds: string[]): Promise<MissionDetail> { await this.design.approve(missionId, revisionId, reviewedSurfaceIds); return this.getMission(missionId); }
  async verifyMission(missionId: string): Promise<MissionDetail> { await this.verification.start(missionId); return this.getMission(missionId); }
  async retryWorkspacePublication(missionId: string): Promise<MissionDetail> { await this.continuation.retry(missionId); return this.getMission(missionId); }

  async reviewImplementation(missionId: string, input: ImplementationReviewInput): Promise<MissionDetail> {
    if (input.decision !== 'accept' && input.decision !== 'request_changes') throw new HttpError(400, 'Unknown implementation review decision');
    const feedback = input.feedback === undefined ? '' : safeMissionText(input.feedback.trim(), MAX_IMPLEMENTATION_FEEDBACK_BYTES, this.redactionSecrets).content;
    if (input.decision === 'request_changes' && !feedback) throw new HttpError(400, 'Implementation feedback is required when requesting changes');

    const action = await this.store.mutate(async (database) => {
      const mission = database.missions.find((item) => item.id === missionId);
      if (!mission) throw new HttpError(404, 'Mission not found');
      const verificationRuns = database.verificationRuns.filter((item) => item.missionId === missionId);
      const events = database.missionEvents.filter((item) => item.missionId === missionId);
      const workspaceRevision = mission.workflow.implementedWorkspaceRevisionId
        ? database.missionWorkspaceRevisions.find((item) => item.id === mission.workflow.implementedWorkspaceRevisionId && item.missionId === missionId) ?? null
        : null;
      const workspaceState = workspaceRevision && mission.workspace.revisionStatus === 'clean'
        ? (await this.workspaces.inspectMissionWorkspace(missionId, workspaceRevision.contentHash, false)).state
        : 'unavailable';
      const review = implementationReviewAvailable({ mission, verificationRuns, events, workspaceState });
      const implementationAccepted = Boolean(currentImplementationAcceptance({ mission, verificationRuns, events }));
      if (input.decision === 'accept') {
        if (!review) throw new HttpError(409, 'A current passing implementation precheck is required before acceptance', 'MISSION_STAGE_UNAVAILABLE');
        if (implementationAccepted) throw new HttpError(409, 'Current implementation revision is already accepted', 'MISSION_STAGE_UNAVAILABLE');
        addEvent(database, mission, 'implementation_review_accepted', { actor: 'human' }, { precheckVerificationRunId: review.run.id, designRevisionId: review.run.designRevisionId, workspaceRevisionId: review.run.workspaceRevisionId });
        mission.updatedAt = now();
        return { startFinalVerification: true, startRepair: false };
      }
      const repairRun = implementationChangeRequestRun({ mission, verificationRuns, events, workspaceState });
      if (!repairRun) throw new HttpError(409, 'Implementation Repair is not available for the current authoritative revision', 'MISSION_STAGE_UNAVAILABLE');
      const decision = prepareImplementationRepair({
        mission,
        verification: repairRun,
        implementationAccepted,
        automaticRepairAlreadyUsed: automaticImplementationRepairUsed(events, mission.id),
        humanRepairAlreadyUsed: humanImplementationRepairUsed(events, mission.id),
      });
      if (!decision.accepted) throw new HttpError(409, 'Implementation Repair is not available', 'MISSION_STAGE_UNAVAILABLE', { reason: decision.reason });
      const artifact = createHumanImplementationFeedbackArtifact({ mission, workspaceRevisionId: repairRun.workspaceRevisionId, content: feedback });
      const order = Math.max(-1, ...database.missionTasks.filter((task) => task.missionId === missionId).map((task) => task.order)) + 1;
      const task = createRepairTask({ mission, verification: repairRun, order, repairCycle: decision.value.repairCycle, extraArtifactIds: [artifact.id] });
      database.missionArtifacts.push(artifact);
      Object.assign(mission, decision.value.mission);
      mission.currentTaskId = task.id;
      mission.updatedAt = now();
      database.missionTasks.push(task);
      addEvent(database, mission, 'implementation_changes_requested', { actor: 'human', taskId: task.id }, { verificationRunId: repairRun.id, designRevisionId: repairRun.designRevisionId, workspaceRevisionId: repairRun.workspaceRevisionId, repairCycle: decision.value.repairCycle, feedbackArtifactId: artifact.id });
      addEvent(database, mission, 'repair_scheduled', { taskId: task.id }, { verificationRunId: repairRun.id, designRevisionId: repairRun.designRevisionId, workspaceRevisionId: repairRun.workspaceRevisionId, repairCycle: decision.value.repairCycle, trigger: 'human_review' });
      return { startFinalVerification: false, startRepair: true };
    });

    if (action.startFinalVerification) await this.verification.start(missionId);
    if (action.startRepair) {
      try { await this.execution.startCurrentTask(missionId); } catch { /* Repair remains pending with exact authority if Runtime admission cannot start it. */ }
    }
    return this.getMission(missionId);
  }

  async getDesignReference(missionId: string, revisionId: string): Promise<Awaited<ReturnType<DesignGovernanceService['getReference']>>> { return this.design.getReference(missionId, revisionId); }

  private async startPrecheckIfNeeded(missionId: string): Promise<void> {
    const snapshot = this.store.snapshot();
    const mission = snapshot.missions.find((item) => item.id === missionId);
    if (!mission || mission.workflow.phase !== 'verifying' || !['paused', 'recovered_paused'].includes(mission.status) || mission.workflow.currentVerificationRunId !== null) return;
    try { await this.verification.start(missionId); } catch { /* The same verifier remains explicitly startable from projected server authority. */ }
  }

  async reconcileStartup(): Promise<void> {
    const evidenceKeys = new Set(this.store.snapshot().missionArtifacts.flatMap((artifact) => artifact.storage.kind === 'external' ? [artifact.storage.key] : []));
    await this.evidence.initialize(evidenceKeys);
    await this.previews.initialize();
    const candidates = this.store.snapshot().missions.filter((mission) => (mission.workspace.state === 'provisioning' || (mission.workspace.state === 'unavailable' && mission.status === 'failed')) && this.isCreationOnly(this.store.snapshot(), mission.id));
    for (const mission of candidates) await this.compensateProvisioning(mission.id, 'Abandoned Mission provisioning was reconciled during startup');
    await this.recovery.reconcileStartup();
    await this.verification.reconcileStartup();
    await this.continuation.reconcileStartup();
  }
}
