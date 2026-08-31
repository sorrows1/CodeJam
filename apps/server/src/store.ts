import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MAX_ARTIFACT_INLINE_BYTES, sanitizeMissionEventDetails, safeMissionText } from './mission-evidence.js';
import type { AgentRun, Database, Mission, MissionArtifact, MissionTask, TaskAttempt, DesignRevision } from './types.js';
import { isTerminalMissionStatus } from './mission-state.js';
import { resolveDesignReferenceMaterialization } from './design-reference-store.js';

const isObject = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null;
const timestamp = (value: unknown, label: string): void => { if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`Invalid ${label}`); };
const enumValue = (value: unknown, values: readonly string[], label: string): void => { if (typeof value !== 'string' || !values.includes(value)) throw new Error(`Invalid ${label}`); };
const ref = (ids: Set<string>, value: unknown, label: string): void => { if (value !== null && (typeof value !== 'string' || !ids.has(value))) throw new Error(`${label} references missing record`); };
const sha256 = /^[0-9a-f]{64}$/i;
const boundedSafeInteger = (value: unknown, label: string): void => { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`); };

export const emptyDatabase = (): Database => ({
  version: 1, agents: [], messages: [], runs: [], missions: [], missionTasks: [], taskAttempts: [],
  missionArtifacts: [], missionEvents: [], missionWorkspaceRevisions: [], missionRecoveryCommands: [],
  designRevisions: [], verificationRuns: [], playgroundImpactAdmissions: [], agentWorkspacePublications: [],
});

function validateAppendOnly(previous: Database, next: Database): void {
  const nextAdmissions = new Map(next.playgroundImpactAdmissions.map((admission) => [admission.id, admission]));
  for (const admission of previous.playgroundImpactAdmissions) {
    const current = nextAdmissions.get(admission.id);
    if (!current) throw new Error('Playground impact admission history is append-only');
    const bindingBefore = { id: admission.id, requestId: admission.requestId, agentId: admission.agentId, prompt: admission.prompt, workspaceHash: admission.workspaceHash, threadId: admission.threadId, proposalRunId: admission.proposalRunId, createdAt: admission.createdAt };
    const bindingAfter = { id: current.id, requestId: current.requestId, agentId: current.agentId, prompt: current.prompt, workspaceHash: current.workspaceHash, threadId: current.threadId, proposalRunId: current.proposalRunId, createdAt: current.createdAt };
    if (JSON.stringify(bindingBefore) !== JSON.stringify(bindingAfter)) throw new Error('Playground impact admission binding is immutable');
    if (admission.proposal && JSON.stringify(admission.proposal) !== JSON.stringify(current.proposal)) throw new Error('Playground impact proposal is immutable');
    const compensatedPromotion = admission.status === 'promoting' && current.status === 'stale' && current.missionId === null;
    if (admission.admittedRunId && admission.admittedRunId !== current.admittedRunId || admission.missionId && admission.missionId !== current.missionId && !compensatedPromotion) throw new Error('Playground impact result binding is immutable');
    if (['admitted', 'promoted', 'stale', 'failed'].includes(admission.status) && JSON.stringify(admission) !== JSON.stringify(current)) throw new Error('Terminal Playground impact admission is immutable');
  }
  const nextDesigns = new Map(next.designRevisions.map((revision) => [revision.id, revision]));
  const referencedArtifacts = new Set<string>();
  for (const revision of previous.designRevisions) for (const id of [revision.packageArtifactId, revision.previewArtifactId, revision.contractArtifactId, revision.feedbackArtifactId]) if (id) referencedArtifacts.add(id);
  for (const revision of previous.designRevisions) {
    const current = nextDesigns.get(revision.id);
    if (!current) throw new Error('DesignRevision history is append-only');
    const allowedTransition = revision.status === 'draft' && (current.status === 'approved' || current.status === 'superseded');
    if (current.status !== revision.status && !allowedTransition) throw new Error('Illegal DesignRevision status transition');
    const before = { ...revision, status: 'draft', approvedAt: null, supersededAt: null, reviewedSurfaceIds: null, reviewedBundleHash: null };
    const after = { ...current, status: 'draft', approvedAt: null, supersededAt: null, reviewedSurfaceIds: null, reviewedBundleHash: null };
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('DesignRevision content is immutable');
    if (allowedTransition && (current.status === 'approved' && !current.approvedAt || current.status === 'superseded' && !current.supersededAt)) throw new Error('DesignRevision transition timestamp is required');
  }
  const nextVerifications = new Map(next.verificationRuns.map((run) => [run.id, run]));
  for (const verification of previous.verificationRuns) {
    const current = nextVerifications.get(verification.id);
    if (!current) throw new Error('VerificationRun history is append-only');
    const immutableBefore = { id: verification.id, missionId: verification.missionId, designRevisionId: verification.designRevisionId, workspaceRevisionId: verification.workspaceRevisionId, cycle: verification.cycle, correlationId: verification.correlationId, createdAt: verification.createdAt, startedAt: verification.startedAt };
    const immutableAfter = { id: current.id, missionId: current.missionId, designRevisionId: current.designRevisionId, workspaceRevisionId: current.workspaceRevisionId, cycle: current.cycle, correlationId: current.correlationId, createdAt: current.createdAt, startedAt: current.startedAt };
    if (JSON.stringify(immutableBefore) !== JSON.stringify(immutableAfter)) throw new Error('VerificationRun binding is immutable');
    if (verification.status === 'passed' || verification.status === 'failed' || verification.status === 'error') {
      if (JSON.stringify(verification) !== JSON.stringify(current)) throw new Error('Terminal VerificationRun is immutable');
    } else if (verification.status === 'running' && current.status === 'running' && JSON.stringify(verification) !== JSON.stringify(current)) {
      throw new Error('Running VerificationRun can only transition to a terminal state');
    } else if (current.status !== verification.status && !((verification.status === 'queued' && current.status === 'running') || (verification.status === 'running' && ['passed', 'failed', 'error'].includes(current.status)))) {
      throw new Error('Illegal VerificationRun status transition');
    }
  }
  const nextPublications = new Map(next.agentWorkspacePublications.map((publication) => [publication.id, publication]));
  for (const publication of previous.agentWorkspacePublications) {
    const current = nextPublications.get(publication.id);
    if (!current) throw new Error('Workspace publication history is append-only');
    const immutableBefore = { id: publication.id, missionId: publication.missionId, agentId: publication.agentId, designRevisionId: publication.designRevisionId, workspaceRevisionId: publication.workspaceRevisionId, verificationRunId: publication.verificationRunId, expectedAgentWorkspaceHash: publication.expectedAgentWorkspaceHash, expectedPublishedWorkspaceHash: publication.expectedPublishedWorkspaceHash, threadDisposition: publication.threadDisposition, createdAt: publication.createdAt };
    const immutableAfter = { id: current.id, missionId: current.missionId, agentId: current.agentId, designRevisionId: current.designRevisionId, workspaceRevisionId: current.workspaceRevisionId, verificationRunId: current.verificationRunId, expectedAgentWorkspaceHash: current.expectedAgentWorkspaceHash, expectedPublishedWorkspaceHash: current.expectedPublishedWorkspaceHash, threadDisposition: current.threadDisposition, createdAt: current.createdAt };
    if (JSON.stringify(immutableBefore) !== JSON.stringify(immutableAfter)) throw new Error('Workspace publication binding is immutable');
    if (publication.status === 'published' && JSON.stringify(publication) !== JSON.stringify(current)) throw new Error('Published workspace publication is immutable');
    const transition = `${publication.status}->${current.status}`;
    const allowed = publication.status === current.status || ['pending->publishing', 'pending->interrupted', 'pending->failed', 'publishing->published', 'publishing->failed', 'publishing->interrupted', 'failed->publishing', 'interrupted->publishing'].includes(transition);
    if (!allowed) throw new Error('Illegal workspace publication status transition');
    if (current.attemptCount < publication.attemptCount) throw new Error('Workspace publication attempt count cannot decrease');
  }
  const nextArtifacts = new Map(next.missionArtifacts.map((artifact) => [artifact.id, artifact]));
  const previousArtifacts = new Map(previous.missionArtifacts.map((artifact) => [artifact.id, artifact]));
  for (const id of referencedArtifacts) {
    const before = previousArtifacts.get(id); const after = nextArtifacts.get(id);
    if (!before || !after || JSON.stringify(before) !== JSON.stringify(after)) throw new Error('DesignRevision artifacts are immutable');
  }
}

function ids(items: readonly { id: string }[], label: string): Set<string> {
  const result = new Set<string>();
  for (const item of items) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || result.has(item.id)) throw new Error(`Invalid or duplicate ${label} ID`);
    result.add(item.id);
  }
  return result;
}

function validateUsage(usage: AgentRun['usage']): void {
  if (usage === null) return;
  for (const value of Object.values(usage)) if (value !== undefined) boundedSafeInteger(value, 'Run usage');
  if (usage.cachedInputTokens !== undefined && usage.inputTokens !== undefined && usage.cachedInputTokens > usage.inputTokens) throw new Error('Invalid Run usage');
}

function participantOf(mission: Mission, agentId: string, label: string): void {
  if (!mission.participants.some((participant) => participant.agentId === agentId)) throw new Error(`${label} is not a Mission participant`);
}

function validateArtifact(artifact: MissionArtifact, missionIds: Set<string>, taskMap: Map<string, MissionTask>, attemptMap: Map<string, TaskAttempt>, revisionIds: Set<string>, revisionMap: Map<string, any>): void {
  ref(missionIds, artifact.missionId, 'MissionArtifact Mission');
  if (artifact.taskId !== null && !taskMap.has(artifact.taskId)) throw new Error('MissionArtifact task references missing record');
  if (artifact.attemptId !== null && !attemptMap.has(artifact.attemptId)) throw new Error('MissionArtifact attempt references missing record');
  ref(revisionIds, artifact.workspaceRevisionId, 'MissionArtifact workspace revision');
  enumValue(artifact.kind, ['agent_output', 'human_intervention', 'design_package', 'design_preview', 'design_contract', 'design_feedback', 'verification_report', 'reference_screenshot', 'actual_screenshot'], 'MissionArtifact kind');
  if (!isObject(artifact.storage) || !['inline', 'external'].includes(artifact.storage.kind)) throw new Error('Invalid MissionArtifact storage');
  if (artifact.storage.kind === 'inline' && (artifact.content === null || typeof artifact.content !== 'string')) throw new Error('Inline artifact requires content');
  if (artifact.storage.kind === 'external' && (artifact.content !== null || typeof artifact.storage.key !== 'string' || artifact.storage.key.length === 0 || artifact.storage.key.length > 512 || artifact.storage.key.includes('..') || artifact.storage.key.includes('/') || artifact.storage.key.includes('\\'))) throw new Error('Invalid external artifact descriptor');
  if (typeof artifact.sha256 !== 'string' || !sha256.test(artifact.sha256)) throw new Error('Invalid artifact SHA-256');
  boundedSafeInteger(artifact.originalByteLength, 'artifact byte length');
  if (typeof artifact.truncated !== 'boolean') throw new Error('Invalid artifact truncation flag');
  if (artifact.storage.kind === 'inline') {
    const bounded = safeMissionText(artifact.content!, MAX_ARTIFACT_INLINE_BYTES);
    artifact.content = bounded.content;
    artifact.truncated = artifact.truncated || bounded.truncated;
    const contentBytes = Buffer.byteLength(artifact.content, 'utf8');
    if (contentBytes > MAX_ARTIFACT_INLINE_BYTES || artifact.originalByteLength < contentBytes) throw new Error('Inline artifact content is out of bounds');
    const contentHash = createHash('sha256').update(artifact.content, 'utf8').digest('hex');
    if (contentHash !== artifact.sha256.toLowerCase()) throw new Error('Inline artifact hash mismatch');
  }
  enumValue(artifact.createdBy?.kind, ['system', 'agent', 'human'], 'artifact creator');
  if (artifact.createdBy.kind === 'agent' && typeof artifact.createdBy.agentId !== 'string') throw new Error('Agent artifact creator is missing');
  if (artifact.createdBy.kind !== 'agent' && artifact.createdBy.agentId !== null) throw new Error('Non-Agent artifact creator mismatch');
  timestamp(artifact.createdAt, 'MissionArtifact createdAt');
  const task = artifact.taskId ? taskMap.get(artifact.taskId) : null;
  const attempt = artifact.attemptId ? attemptMap.get(artifact.attemptId) : null;
  if (task && task.missionId !== artifact.missionId || attempt && (attempt.missionId !== artifact.missionId || attempt.taskId !== artifact.taskId)) throw new Error('MissionArtifact correlation mismatch');
  if (artifact.kind === 'agent_output' && (!task || !attempt || artifact.createdBy.kind !== 'agent' || artifact.createdBy.agentId !== attempt.agentId)) throw new Error('Agent artifact correlation mismatch');
  if (artifact.kind === 'human_intervention' && artifact.attemptId !== null) throw new Error('Human artifact correlation mismatch');
  if (artifact.workspaceRevisionId && revisionMap.get(artifact.workspaceRevisionId)?.missionId !== artifact.missionId) throw new Error('MissionArtifact workspace revision mismatch');
}

export function validateDatabase(value: unknown): asserts value is Database {
  if (!isObject(value) || value.version !== 1) throw new Error('Unsupported database format');
  const database = value as Database;
  for (const key of ['agents', 'messages', 'runs', 'missions', 'missionTasks', 'taskAttempts', 'missionArtifacts', 'missionEvents', 'missionWorkspaceRevisions', 'missionRecoveryCommands', 'designRevisions', 'verificationRuns', 'playgroundImpactAdmissions', 'agentWorkspacePublications'] as const) if (!Array.isArray(database[key])) throw new Error(`Invalid database format: ${key}`);
  const agentIds = ids(database.agents, 'Agent');
  const runIds = ids(database.runs, 'AgentRun');
  const missionIds = ids(database.missions, 'Mission');
  const taskIds = ids(database.missionTasks, 'MissionTask');
  const attemptIds = ids(database.taskAttempts, 'TaskAttempt');
  const artifactIds = ids(database.missionArtifacts, 'MissionArtifact');
  const workspaceRevisionIds = ids(database.missionWorkspaceRevisions, 'MissionWorkspaceRevision');
  const commandIds = ids(database.missionRecoveryCommands, 'MissionRecoveryCommand');
  const designRevisionIds = ids(database.designRevisions, 'DesignRevision');
  const verificationIds = ids(database.verificationRuns, 'VerificationRun');
  const impactAdmissionIds = ids(database.playgroundImpactAdmissions, 'PlaygroundImpactAdmission');
  ids(database.agentWorkspacePublications, 'AgentWorkspacePublication');
  ids(database.messages, 'Message'); ids(database.missionEvents, 'MissionEvent');
  const missionMap = new Map(database.missions.map((mission) => [mission.id, mission]));
  const taskMap = new Map(database.missionTasks.map((task) => [task.id, task]));
  const attemptMap = new Map(database.taskAttempts.map((attempt) => [attempt.id, attempt]));
  const runMap = new Map(database.runs.map((run) => [run.id, run]));
  const artifactMap = new Map(database.missionArtifacts.map((artifact) => [artifact.id, artifact]));
  const revisionMap = new Map(database.missionWorkspaceRevisions.map((revision) => [revision.id, revision]));
  const commandMap = new Map(database.missionRecoveryCommands.map((command) => [command.id, command]));
  const designMap = new Map(database.designRevisions.map((revision) => [revision.id, revision]));

  for (const agent of database.agents) {
    if (typeof agent.name !== 'string' || typeof agent.description !== 'string' || typeof agent.instructions !== 'string' || typeof agent.workspacePath !== 'string' || typeof agent.codexThreadId !== 'string' && agent.codexThreadId !== null || typeof agent.lastError !== 'string' && agent.lastError !== null) throw new Error('Invalid Agent fields');
    enumValue(agent.status, ['ready', 'busy', 'stopped', 'error'], 'Agent status'); timestamp(agent.createdAt, 'Agent createdAt'); timestamp(agent.updatedAt, 'Agent updatedAt');
  }
  for (const message of database.messages) {
    ref(agentIds, message.agentId, 'Message agent'); ref(runIds, message.runId, 'Message run'); enumValue(message.role, ['user', 'assistant'], 'Message role'); timestamp(message.createdAt, 'Message createdAt');
    const run = runMap.get(message.runId); if (!run || !['playground', 'playground_impact', 'playground_candidate'].includes(run.context.kind) || run.agentId !== message.agentId) throw new Error('Message Playground correlation mismatch');
  }
  for (const run of database.runs) {
    enumValue(run.status, ['queued', 'running', 'completed', 'failed', 'cancelled'], 'AgentRun status'); if (!isObject(run.context)) throw new Error('Invalid AgentRun context'); validateUsage(run.usage); timestamp(run.createdAt, 'AgentRun createdAt'); if (run.startedAt !== null) timestamp(run.startedAt, 'AgentRun startedAt'); if (run.completedAt !== null) timestamp(run.completedAt, 'AgentRun completedAt');
    if (run.context.kind === 'playground') continue;
    if (run.context.kind === 'playground_impact') { ref(impactAdmissionIds, run.context.admissionId, 'Impact proposal admission'); continue; }
    if (run.context.kind === 'playground_candidate') { ref(impactAdmissionIds, run.context.admissionId, 'Impact candidate admission'); continue; }
    if (run.context.kind !== 'mission') throw new Error('Invalid AgentRun context');
    ref(missionIds, run.context.missionId, 'AgentRun Mission'); ref(taskIds, run.context.taskId, 'AgentRun task'); ref(attemptIds, run.context.attemptId, 'AgentRun attempt'); const mission = missionMap.get(run.context.missionId); if (!mission || !isTerminalMissionStatus(mission.status)) ref(agentIds, run.agentId, 'Mission AgentRun agent');
    const task = taskMap.get(run.context.taskId); const attempt = attemptMap.get(run.context.attemptId);
    if (!task || !attempt || task.missionId !== run.context.missionId || attempt.missionId !== run.context.missionId || attempt.taskId !== task.id || attempt.runId !== run.id || attempt.agentId !== run.agentId) throw new Error('AgentRun Mission correlation mismatch');
  }
  for (const mission of database.missions) {
    enumValue(mission.status, ['pending', 'running', 'paused', 'blocked', 'recovered_paused', 'completed', 'failed', 'cancelled'], 'Mission status');
    if (!mission.workspace || mission.workspace.owner !== 'conductor' || mission.workspace.key !== mission.id || mission.workspace.source?.kind !== 'agent_workspace') throw new Error('Invalid Mission workspace');
    ref(agentIds, mission.workspace.source.agentId, 'Mission source Agent'); participantOf(mission, mission.workspace.source.agentId, 'Mission source Agent');
    if (mission.workspace.source.impactAdmissionId !== null) ref(impactAdmissionIds, mission.workspace.source.impactAdmissionId, 'Mission source impact admission');
    if (mission.workspace.source.contentHash !== null && !sha256.test(mission.workspace.source.contentHash)) throw new Error('Invalid Mission source content hash');
    if (mission.workspace.source.contentHash === null) throw new Error('Mission source content hash is required');
    enumValue(mission.workspace.state, ['provisioning', 'ready', 'unavailable'], 'Mission workspace state'); enumValue(mission.workspace.revisionStatus, ['unversioned', 'clean', 'uncheckpointed'], 'Mission revision status');
    if (!Number.isSafeInteger(mission.workspace.nextRevisionSequence) || mission.workspace.nextRevisionSequence < 1) throw new Error('Invalid Mission revision sequence');
    if (!isObject(mission.workflow)) throw new Error('Invalid Mission workflow'); enumValue(mission.workflow.phase, ['designing', 'awaiting_approval', 'implementing', 'verifying', 'repairing', 'awaiting_intervention', 'completed'], 'Intent workflow phase');
    if (!Number.isSafeInteger(mission.workflow.repairCycle) || mission.workflow.repairCycle < 0 || !Number.isSafeInteger(mission.workflow.maxRepairCycles) || mission.workflow.maxRepairCycles < 0) throw new Error('Invalid repair policy');
    participantOf(mission, mission.workflow.designerAgentId, 'Designer Agent'); participantOf(mission, mission.workflow.builderAgentId, 'Builder Agent'); ref(taskIds, mission.currentTaskId, 'Mission current task'); ref(commandIds, mission.activeRecoveryCommandId, 'Mission recovery command');
    if (!Number.isSafeInteger(mission.nextEventSequence) || mission.nextEventSequence < 1) throw new Error('Invalid Mission event sequence'); if (mission.tokenBudget !== null && (!Number.isSafeInteger(mission.tokenBudget) || mission.tokenBudget <= 0)) throw new Error('Invalid Mission token budget');
    timestamp(mission.createdAt, 'Mission createdAt'); timestamp(mission.updatedAt, 'Mission updatedAt'); if (mission.startedAt !== null) timestamp(mission.startedAt, 'Mission startedAt'); if (mission.completedAt !== null) timestamp(mission.completedAt, 'Mission completedAt');
    const participants = new Set<string>(); for (const participant of mission.participants) { if (participants.has(participant.agentId) || !Number.isSafeInteger(participant.order) || participant.order !== participants.size) throw new Error('Invalid Mission participant'); participants.add(participant.agentId); if (!isTerminalMissionStatus(mission.status)) ref(agentIds, participant.agentId, 'Mission participant'); }
    ref(workspaceRevisionIds, mission.workspace.currentRevisionId, 'Mission current workspace revision'); ref(designRevisionIds, mission.workflow.latestDesignRevisionId, 'Mission latest DesignRevision'); ref(designRevisionIds, mission.workflow.approvedDesignRevisionId, 'Mission approved DesignRevision'); ref(workspaceRevisionIds, mission.workflow.implementedWorkspaceRevisionId, 'Mission implemented workspace revision'); ref(verificationIds, mission.workflow.currentVerificationRunId, 'Mission VerificationRun'); if (mission.workspace.currentRevisionId && revisionMap.get(mission.workspace.currentRevisionId)?.missionId !== mission.id || mission.workflow.latestDesignRevisionId && designMap.get(mission.workflow.latestDesignRevisionId)?.missionId !== mission.id || mission.workflow.approvedDesignRevisionId && designMap.get(mission.workflow.approvedDesignRevisionId)?.missionId !== mission.id || mission.workflow.implementedWorkspaceRevisionId && revisionMap.get(mission.workflow.implementedWorkspaceRevisionId)?.missionId !== mission.id || mission.workflow.currentVerificationRunId && database.verificationRuns.find((run) => run.id === mission.workflow.currentVerificationRunId)?.missionId !== mission.id) throw new Error('Mission workflow pointer ownership mismatch');
    const expectedStatus: Partial<Record<Mission['status'], string[]>> = { pending: ['designing'], running: ['designing', 'implementing', 'verifying', 'repairing'], paused: ['designing', 'awaiting_approval', 'implementing', 'verifying', 'repairing'], recovered_paused: ['designing', 'awaiting_approval', 'implementing', 'verifying', 'repairing'], blocked: ['implementing', 'awaiting_intervention'], completed: ['completed'] }; if (expectedStatus[mission.status] && !expectedStatus[mission.status]!.includes(mission.workflow.phase)) throw new Error('Invalid Mission status/workflow phase combination');
  }
  for (const admission of database.playgroundImpactAdmissions) {
    if (['planning', 'confirmation_required', 'staging', 'publishing', 'promoting'].includes(admission.status))
      ref(agentIds, admission.agentId, 'Impact admission Agent');
    ref(runIds, admission.proposalRunId, 'Impact admission proposal Run');
    ref(runIds, admission.admittedRunId, 'Impact admission admitted Run');
    ref(runIds, admission.candidateRunId ?? null, 'Impact admission candidate Run');
    ref(missionIds, admission.missionId, 'Impact admission Mission');
    if (typeof admission.requestId !== 'string' || typeof admission.prompt !== 'string' || !sha256.test(admission.workspaceHash) || typeof admission.agentUpdatedAt !== 'string' || typeof admission.allowNonvisualConfirmation !== 'boolean') throw new Error('Invalid Impact admission binding');
    enumValue(admission.status, ['planning', 'confirmation_required', 'staging', 'publishing', 'admitted', 'promoting', 'promoted', 'stale', 'failed'], 'Impact admission status');
    if (admission.decision !== null) enumValue(admission.decision, ['nonvisual', 'governed', 'confirmation_required'], 'Impact admission decision');
    const proposalRun = runMap.get(admission.proposalRunId);
    if (!proposalRun || proposalRun.agentId !== admission.agentId || proposalRun.context.kind !== 'playground_impact' || proposalRun.context.admissionId !== admission.id) throw new Error('Impact admission proposal Run mismatch');
    if (admission.candidateRunId) { const run = runMap.get(admission.candidateRunId); if (!run || run.agentId !== admission.agentId || run.context.kind !== 'playground_candidate' || run.context.admissionId !== admission.id) throw new Error('Impact admission candidate Run mismatch'); }
    if (admission.candidateWorkspaceHash != null && !sha256.test(admission.candidateWorkspaceHash)) throw new Error('Invalid Impact candidate workspace hash');
    if (admission.admittedRunId) { const run = runMap.get(admission.admittedRunId); if (!run || run.agentId !== admission.agentId || !['playground', 'playground_candidate'].includes(run.context.kind)) throw new Error('Impact admission ordinary Run mismatch'); }
    if (admission.missionId) { const mission = missionMap.get(admission.missionId); if (!mission || mission.workspace.source.impactAdmissionId !== admission.id || mission.workspace.source.contentHash !== admission.workspaceHash) throw new Error('Impact admission Mission mismatch'); }
    if (admission.status === 'admitted' && !admission.admittedRunId || (admission.status === 'promoting' || admission.status === 'promoted') && !admission.missionId) throw new Error('Impact admission terminal binding is incomplete');
    timestamp(admission.agentUpdatedAt, 'Impact admission Agent updatedAt'); timestamp(admission.createdAt, 'Impact admission createdAt'); timestamp(admission.updatedAt, 'Impact admission updatedAt'); if (admission.completedAt !== null) timestamp(admission.completedAt, 'Impact admission completedAt');
  }
  for (const publication of database.agentWorkspacePublications) {
    ref(missionIds, publication.missionId, 'Workspace publication Mission'); ref(agentIds, publication.agentId, 'Workspace publication Agent'); ref(designRevisionIds, publication.designRevisionId, 'Workspace publication DesignRevision'); ref(workspaceRevisionIds, publication.workspaceRevisionId, 'Workspace publication revision'); ref(verificationIds, publication.verificationRunId, 'Workspace publication VerificationRun');
    enumValue(publication.status, ['pending', 'publishing', 'published', 'failed', 'interrupted'], 'Workspace publication status');
    if (!sha256.test(publication.expectedAgentWorkspaceHash) || !sha256.test(publication.expectedPublishedWorkspaceHash) || publication.threadDisposition !== 'reset' || !Number.isSafeInteger(publication.attemptCount) || publication.attemptCount < 0) throw new Error('Invalid workspace publication binding');
    const mission = missionMap.get(publication.missionId); const verification = database.verificationRuns.find((item) => item.id === publication.verificationRunId);
    if (!mission || mission.workspace.source.agentId !== publication.agentId || verification?.missionId !== mission.id || verification.designRevisionId !== publication.designRevisionId || verification.workspaceRevisionId !== publication.workspaceRevisionId) throw new Error('Workspace publication authority mismatch');
    timestamp(publication.createdAt, 'Workspace publication createdAt'); timestamp(publication.updatedAt, 'Workspace publication updatedAt'); if (publication.completedAt !== null) timestamp(publication.completedAt, 'Workspace publication completedAt');
    if (publication.status === 'published' && publication.completedAt === null) throw new Error('Published workspace publication lacks completion timestamp');
  }
  const taskOrders = new Map<string, number>();
  for (const task of database.missionTasks) {
    const mission = missionMap.get(task.missionId); ref(missionIds, task.missionId, 'MissionTask Mission'); if (!mission) continue; participantOf(mission, task.assignedAgentId, 'MissionTask Agent'); if (!isTerminalMissionStatus(mission.status)) ref(agentIds, task.assignedAgentId, 'MissionTask agent'); enumValue(task.stage, ['design', 'implement', 'repair'], 'MissionTask stage'); enumValue(task.status, ['pending', 'running', 'paused', 'blocked', 'interrupted', 'completed', 'failed', 'stale', 'cancelled'], 'MissionTask status');
    if (!Number.isSafeInteger(task.order) || task.order < 0 || task.order !== (taskOrders.get(task.missionId) ?? 0)) throw new Error('Mission task order is not contiguous'); taskOrders.set(task.missionId, task.order + 1);
    if (task.stage === 'design' && task.assignedAgentId !== mission.workflow.designerAgentId || (task.stage === 'implement' || task.stage === 'repair') && task.assignedAgentId !== mission.workflow.builderAgentId) throw new Error('MissionTask role binding mismatch');
    ref(attemptIds, task.authoritativeAttemptId, 'MissionTask attempt'); const authoritative = task.authoritativeAttemptId ? attemptMap.get(task.authoritativeAttemptId) : null; if (authoritative && (authoritative.missionId !== task.missionId || authoritative.taskId !== task.id || authoritative.agentId !== task.assignedAgentId || authoritative.authorityVersion !== task.authorityVersion)) throw new Error('MissionTask authority correlation mismatch');
    for (const artifactId of task.inputArtifactIds) { ref(artifactIds, artifactId, 'MissionTask input artifact'); const artifact = artifactMap.get(artifactId); if (artifact && artifact.missionId !== task.missionId) throw new Error('MissionTask input artifact ownership mismatch'); }
    for (const artifactId of task.outputArtifactIds) { ref(artifactIds, artifactId, 'MissionTask output artifact'); const artifact = artifactMap.get(artifactId); if (artifact && (artifact.missionId !== task.missionId || artifact.taskId !== task.id || artifact.attemptId !== null && attemptMap.get(artifact.attemptId)?.taskId !== task.id)) throw new Error('MissionTask output artifact correlation mismatch'); }
    ref(designRevisionIds, task.inputDesignRevisionId, 'MissionTask DesignRevision'); ref(verificationIds, task.inputVerificationRunId, 'MissionTask VerificationRun'); ref(workspaceRevisionIds, task.inputWorkspaceRevisionId, 'MissionTask input revision'); ref(workspaceRevisionIds, task.outputWorkspaceRevisionId, 'MissionTask output revision');
    if (task.stage === 'design' && (task.inputDesignRevisionId !== null || task.inputVerificationRunId !== null || task.repairCycle !== null)) throw new Error('Design task input binding mismatch');
    if (task.stage === 'implement' && task.status !== 'stale') {
      const approved = task.inputDesignRevisionId ? designMap.get(task.inputDesignRevisionId) : null;
      if (!approved || task.inputVerificationRunId !== null || task.repairCycle !== null || task.inputArtifactIds.length !== 3 || task.inputArtifactIds[0] !== approved.packageArtifactId || task.inputArtifactIds[1] !== approved.previewArtifactId || task.inputArtifactIds[2] !== approved.contractArtifactId) throw new Error('Implementation task reference binding mismatch');
      const materialization = resolveDesignReferenceMaterialization({ revision: approved, artifacts: database.missionArtifacts });
      if (!materialization.ok) throw new Error('Implementation task protected reference binding mismatch');
    }
    if (task.stage === 'repair' && (task.inputDesignRevisionId === null || task.inputVerificationRunId === null || task.repairCycle === null)) throw new Error('Repair task input binding mismatch');
    if (!Number.isSafeInteger(task.authorityVersion) || task.authorityVersion < 0) throw new Error('Invalid MissionTask authority'); timestamp(task.createdAt, 'MissionTask createdAt'); timestamp(task.updatedAt, 'MissionTask updatedAt'); if (task.startedAt !== null) timestamp(task.startedAt, 'MissionTask startedAt'); if (task.completedAt !== null) timestamp(task.completedAt, 'MissionTask completedAt');
  }
  for (const mission of database.missions) {
    const tasks = database.missionTasks.filter((task) => task.missionId === mission.id); if (mission.currentTaskId && !tasks.some((task) => task.id === mission.currentTaskId)) throw new Error('Mission current task references another Mission'); if (mission.status === 'pending' && tasks.filter((task) => task.stage === 'design').length !== 1) throw new Error('Pending Mission must have exactly one Design task');
  }
  for (const attempt of database.taskAttempts) {
    const task = taskMap.get(attempt.taskId); ref(missionIds, attempt.missionId, 'TaskAttempt Mission'); ref(taskIds, attempt.taskId, 'TaskAttempt task'); if (!task || task.missionId !== attempt.missionId || task.assignedAgentId !== attempt.agentId) throw new Error('TaskAttempt Mission/task/Agent correlation mismatch'); participantOf(missionMap.get(attempt.missionId)!, attempt.agentId, 'TaskAttempt Agent'); if (!isTerminalMissionStatus(missionMap.get(attempt.missionId)!.status)) ref(agentIds, attempt.agentId, 'TaskAttempt agent'); enumValue(attempt.stage, ['design', 'implement', 'repair'], 'TaskAttempt stage'); if (attempt.stage !== task.stage || attempt.inputDesignRevisionId !== task.inputDesignRevisionId || attempt.inputVerificationRunId !== task.inputVerificationRunId || attempt.inputWorkspaceRevisionId !== task.inputWorkspaceRevisionId || attempt.repairCycle !== task.repairCycle) throw new Error('TaskAttempt input binding mismatch'); ref(runIds, attempt.runId, 'TaskAttempt run'); if (attempt.runId) { const run = runMap.get(attempt.runId); if (!run || run.context.kind !== 'mission' || run.context.missionId !== attempt.missionId || run.context.taskId !== attempt.taskId || run.context.attemptId !== attempt.id || run.agentId !== attempt.agentId) throw new Error('TaskAttempt Run correlation mismatch'); } ref(artifactIds, attempt.outputArtifactId, 'TaskAttempt artifact'); if (attempt.outputArtifactId) { const artifact = artifactMap.get(attempt.outputArtifactId); if (!artifact || artifact.missionId !== attempt.missionId || artifact.taskId !== attempt.taskId || artifact.attemptId !== attempt.id) throw new Error('TaskAttempt output artifact correlation mismatch'); } ref(workspaceRevisionIds, attempt.inputWorkspaceRevisionId, 'TaskAttempt input revision'); ref(workspaceRevisionIds, attempt.outputWorkspaceRevisionId, 'TaskAttempt output revision'); ref(commandIds, attempt.startedByRecoveryCommandId, 'TaskAttempt recovery command'); ref(attemptIds, attempt.supersededByAttemptId, 'TaskAttempt superseded attempt'); if (attempt.supersededByAttemptId) { const superseding = attemptMap.get(attempt.supersededByAttemptId); if (!superseding || superseding.id === attempt.id || superseding.missionId !== attempt.missionId || superseding.taskId !== attempt.taskId) throw new Error('TaskAttempt superseded attempt correlation mismatch'); } enumValue(attempt.status, ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'], 'TaskAttempt status'); if (!Number.isSafeInteger(attempt.attemptNumber) || attempt.attemptNumber < 1 || !Number.isSafeInteger(attempt.authorityVersion) || attempt.authorityVersion < 1) throw new Error('Invalid TaskAttempt numbering/authority'); validateUsage(attempt.usage); timestamp(attempt.createdAt, 'TaskAttempt createdAt'); timestamp(attempt.updatedAt, 'TaskAttempt updatedAt'); if (attempt.startedAt !== null) timestamp(attempt.startedAt, 'TaskAttempt startedAt'); if (attempt.completedAt !== null) timestamp(attempt.completedAt, 'TaskAttempt completedAt');
  }
  for (const artifact of database.missionArtifacts) validateArtifact(artifact, missionIds, taskMap, attemptMap, workspaceRevisionIds, revisionMap);
  for (const revision of database.designRevisions) {
    const sourceTask = taskMap.get(revision.sourceTaskId);
    const sourceAttempt = attemptMap.get(revision.sourceAttemptId);
    const designArtifacts = [[revision.packageArtifactId, 'design_package'], [revision.previewArtifactId, 'design_preview'], [revision.contractArtifactId, 'design_contract']] as const;
    for (const [artifactId, kind] of designArtifacts) {
      const artifact = artifactMap.get(artifactId);
      if (!artifact || artifact.missionId !== revision.missionId || artifact.kind !== kind || artifact.taskId !== sourceTask?.id || artifact.attemptId !== sourceAttempt?.id) throw new Error('DesignRevision artifact ownership mismatch');
    }
    if (revision.feedbackArtifactId) {
      const feedback = artifactMap.get(revision.feedbackArtifactId);
      if (!feedback || feedback.missionId !== revision.missionId || feedback.kind !== 'design_feedback' || feedback.taskId !== sourceTask?.id || feedback.attemptId !== null) throw new Error('DesignRevision feedback artifact ownership mismatch');
    }
  }
  for (const verification of database.verificationRuns) {
    const evidence = [[verification.referenceScreenshotArtifactId, 'reference_screenshot'], [verification.actualScreenshotArtifactId, 'actual_screenshot'], [verification.reportArtifactId, 'verification_report']] as const;
    for (const [artifactId, kind] of evidence) {
      if (!artifactId) continue;
      const artifact = artifactMap.get(artifactId);
      if (!artifact || artifact.missionId !== verification.missionId || artifact.kind !== kind || artifact.taskId !== null || artifact.attemptId !== null || kind !== 'reference_screenshot' && artifact.workspaceRevisionId !== verification.workspaceRevisionId) throw new Error('VerificationRun artifact ownership mismatch');
    }
  }
  for (const event of database.missionEvents) {
    if (!isObject(event.details)) throw new Error('Invalid MissionEvent details');
    event.details = sanitizeMissionEventDetails(event.details);
  }
  for (const revision of database.missionWorkspaceRevisions) {
    ref(missionIds, revision.missionId, 'Workspace revision Mission'); ref(workspaceRevisionIds, revision.parentRevisionId, 'Workspace revision parent'); ref(workspaceRevisionIds, revision.restoredFromRevisionId, 'Workspace revision restore source'); ref(taskIds, revision.taskId, 'Workspace revision task'); ref(attemptIds, revision.attemptId, 'Workspace revision attempt'); ref(artifactIds, revision.interventionArtifactId, 'Workspace revision artifact'); if (revision.taskId && taskMap.get(revision.taskId)?.missionId !== revision.missionId || revision.attemptId && attemptMap.get(revision.attemptId)?.missionId !== revision.missionId || revision.interventionArtifactId && artifactMap.get(revision.interventionArtifactId)?.missionId !== revision.missionId || revision.parentRevisionId && revisionMap.get(revision.parentRevisionId)?.missionId !== revision.missionId || revision.restoredFromRevisionId && revisionMap.get(revision.restoredFromRevisionId)?.missionId !== revision.missionId) throw new Error('Workspace revision correlation mismatch'); if (revision.parentRevisionId && revisionMap.get(revision.parentRevisionId)!.sequence >= revision.sequence || revision.restoredFromRevisionId && revisionMap.get(revision.restoredFromRevisionId)!.sequence >= revision.sequence) throw new Error('Workspace revision parent order mismatch'); if (!sha256.test(revision.contentHash) || !/^revision-[0-9a-f-]{36}$/i.test(revision.snapshotKey)) throw new Error('Invalid workspace revision metadata'); timestamp(revision.createdAt, 'Workspace revision createdAt');
  }
  for (const revision of database.designRevisions) {
    ref(missionIds, revision.missionId, 'DesignRevision Mission'); ref(designRevisionIds, revision.parentRevisionId, 'DesignRevision parent'); ref(taskIds, revision.sourceTaskId, 'DesignRevision source task'); ref(attemptIds, revision.sourceAttemptId, 'DesignRevision source attempt'); for (const id of [revision.packageArtifactId, revision.previewArtifactId, revision.contractArtifactId, revision.feedbackArtifactId]) ref(artifactIds, id, 'DesignRevision artifact'); enumValue(revision.status, ['draft', 'approved', 'superseded'], 'DesignRevision status'); if (!Number.isSafeInteger(revision.version) || revision.version < 1 || !sha256.test(revision.packageHash) || !sha256.test(revision.previewHash) || !sha256.test(revision.contractHash)) throw new Error('Invalid DesignRevision metadata'); const task = taskMap.get(revision.sourceTaskId); const attempt = attemptMap.get(revision.sourceAttemptId); if (!task || task.stage !== 'design' || task.missionId !== revision.missionId || !attempt || attempt.taskId !== task.id) throw new Error('DesignRevision source mismatch'); const packageArtifact = artifactMap.get(revision.packageArtifactId); const previewArtifact = artifactMap.get(revision.previewArtifactId); const contractArtifact = artifactMap.get(revision.contractArtifactId); if (packageArtifact?.kind !== 'design_package' || previewArtifact?.kind !== 'design_preview' || contractArtifact?.kind !== 'design_contract' || packageArtifact.sha256 !== revision.packageHash || previewArtifact.sha256 !== revision.previewHash || contractArtifact.sha256 !== revision.contractHash || [packageArtifact, previewArtifact, contractArtifact].some((artifact) => artifact?.storage.kind !== 'external')) throw new Error('DesignRevision artifact binding mismatch'); timestamp(revision.createdAt, 'DesignRevision createdAt'); if (revision.status === 'approved' && revision.approvedAt === null || revision.status !== 'approved' && revision.approvedAt !== null) throw new Error('DesignRevision approval timestamp mismatch'); if (revision.status === 'approved' && (!Array.isArray(revision.reviewedSurfaceIds) || revision.reviewedSurfaceIds.length < 1 || revision.reviewedSurfaceIds.length > 8 || new Set(revision.reviewedSurfaceIds).size !== revision.reviewedSurfaceIds.length || revision.reviewedBundleHash !== revision.packageHash)) throw new Error('Approved DesignRevision lacks exact surface review binding'); if (revision.status !== 'approved' && (revision.reviewedSurfaceIds != null || revision.reviewedBundleHash != null)) throw new Error('Unapproved DesignRevision has surface review authority'); if (revision.status === 'superseded' && revision.supersededAt === null || revision.status !== 'superseded' && revision.supersededAt !== null) throw new Error('DesignRevision supersession timestamp mismatch'); if (revision.approvedAt !== null) timestamp(revision.approvedAt, 'DesignRevision approvedAt'); if (revision.supersededAt !== null) timestamp(revision.supersededAt, 'DesignRevision supersededAt'); if (revision.parentRevisionId && (designMap.get(revision.parentRevisionId)?.missionId !== revision.missionId || designMap.get(revision.parentRevisionId)!.version >= revision.version)) throw new Error('DesignRevision parent/version mismatch'); if (revision.feedbackArtifactId && artifactMap.get(revision.feedbackArtifactId)?.taskId !== revision.sourceTaskId) throw new Error('DesignRevision feedback/source mismatch');
  }
  for (const mission of database.missions) {
    const revisions = database.designRevisions.filter((revision) => revision.missionId === mission.id).sort((left, right) => left.version - right.version);
    const latest = mission.workflow.latestDesignRevisionId ? designMap.get(mission.workflow.latestDesignRevisionId) : null;
    const approved = mission.workflow.approvedDesignRevisionId ? designMap.get(mission.workflow.approvedDesignRevisionId) : null;
    if (latest && latest.status === 'superseded' && mission.workflow.phase !== 'designing') throw new Error('Superseded DesignRevision cannot be latest outside revision');
    if (approved && approved.status !== 'approved') throw new Error('Approved DesignRevision pointer is not approved');
    if (mission.workflow.phase === 'awaiting_approval' && (!latest || latest.status !== 'draft' || mission.currentTaskId !== null)) throw new Error('Awaiting approval lacks current draft');
    if (mission.workflow.phase === 'designing' && latest && latest.status === 'approved') throw new Error('Designing Mission points at approved latest revision');
    if (mission.workflow.phase === 'implementing') {
      if (!approved || mission.workflow.latestDesignRevisionId !== approved.id || approved.status !== 'approved' || approved.approvedAt === null) throw new Error('Implementing Mission lacks current approved DesignRevision');
      if (!['completed', 'failed', 'cancelled'].includes(mission.status)) {
        const implementationTasks = database.missionTasks.filter((task) => task.missionId === mission.id && task.stage === 'implement' && task.status !== 'stale' && task.status !== 'cancelled');
        const currentTask = mission.currentTaskId ? taskMap.get(mission.currentTaskId) : null;
        if (implementationTasks.length !== 1 || !currentTask || currentTask.id !== implementationTasks[0]!.id || currentTask.inputDesignRevisionId !== approved.id || currentTask.inputWorkspaceRevisionId !== mission.workspace.currentRevisionId) throw new Error('Implementing Mission lacks current bound Implementation task');
      }
    }
    if (mission.workflow.phase === 'verifying') {
      if (!mission.workflow.approvedDesignRevisionId || !mission.workflow.implementedWorkspaceRevisionId || mission.currentTaskId !== null) throw new Error('Verifying Mission pointers are invalid');
      const implementationTask = database.missionTasks.find((task) => task.missionId === mission.id && (task.stage === 'implement' || task.stage === 'repair') && task.status === 'completed' && task.outputWorkspaceRevisionId === mission.workflow.implementedWorkspaceRevisionId);
      if (!implementationTask) throw new Error('Verifying Mission lacks completed Implementation or Repair output');
    }
    if (revisions.length && revisions.at(-1)!.version !== revisions.length) throw new Error('DesignRevision version history is not contiguous');
  }
  for (const revision of database.designRevisions) if (revision.parentRevisionId && designMap.get(revision.parentRevisionId)?.missionId !== revision.missionId) throw new Error('DesignRevision parent Mission mismatch');
  const designVersions = new Map<string, number>(); for (const revision of database.designRevisions) { const previous = designVersions.get(revision.missionId) ?? 0; if (revision.version !== previous + 1) throw new Error('DesignRevision versions are not contiguous'); designVersions.set(revision.missionId, revision.version); }
  for (const task of database.missionTasks) { const mission = missionMap.get(task.missionId)!; if (task.inputDesignRevisionId && designMap.get(task.inputDesignRevisionId)?.missionId !== task.missionId || task.inputVerificationRunId && database.verificationRuns.find((run) => run.id === task.inputVerificationRunId)?.missionId !== task.missionId || task.inputWorkspaceRevisionId && revisionMap.get(task.inputWorkspaceRevisionId)?.missionId !== task.missionId || task.outputWorkspaceRevisionId && revisionMap.get(task.outputWorkspaceRevisionId)?.missionId !== task.missionId) throw new Error('MissionTask input binding ownership mismatch'); if ((task.stage === 'implement' || task.stage === 'repair') && task.inputDesignRevisionId !== mission.workflow.approvedDesignRevisionId && task.status !== 'stale') throw new Error('MissionTask approved DesignRevision binding mismatch'); }
  for (const verification of database.verificationRuns) { ref(missionIds, verification.missionId, 'VerificationRun Mission'); ref(designRevisionIds, verification.designRevisionId, 'VerificationRun DesignRevision'); ref(workspaceRevisionIds, verification.workspaceRevisionId, 'VerificationRun workspace revision'); for (const id of [verification.referenceScreenshotArtifactId, verification.actualScreenshotArtifactId, verification.reportArtifactId]) ref(artifactIds, id, 'VerificationRun artifact'); enumValue(verification.status, ['queued', 'running', 'passed', 'failed', 'error'], 'VerificationRun status'); if (typeof verification.correlationId !== 'string' || verification.correlationId.length < 1 || verification.correlationId.length > 128) throw new Error('Invalid VerificationRun correlation'); if (!Array.isArray(verification.checks) || verification.checks.length > 128) throw new Error('Invalid VerificationRun checks'); for (const item of verification.checks) { if (!isObject(item) || typeof item.id !== 'string' || typeof item.kind !== 'string' || !['text', 'element', 'interaction', 'runtime'].includes(item.kind) || typeof item.label !== 'string' || typeof item.passed !== 'boolean' || typeof item.details !== 'string') throw new Error('Invalid VerificationRun check'); } if (!Array.isArray(verification.consoleErrors) || verification.consoleErrors.length > 32 || verification.consoleErrors.some((item) => typeof item !== 'string')) throw new Error('Invalid VerificationRun console errors'); if (!Array.isArray(verification.pageErrors) || verification.pageErrors.length > 32 || verification.pageErrors.some((item) => typeof item !== 'string')) throw new Error('Invalid VerificationRun page errors'); if (verification.url !== null && typeof verification.url !== 'string' || verification.durationMs !== null && (!Number.isSafeInteger(verification.durationMs) || verification.durationMs < 0)) throw new Error('Invalid VerificationRun runtime metadata'); if (!Number.isSafeInteger(verification.cycle) || verification.cycle < 0 || verification.visualDifference !== null && (!Number.isFinite(verification.visualDifference) || verification.visualDifference < 0)) throw new Error('Invalid VerificationRun metrics'); if (verification.error !== null && verification.error.category !== 'infrastructure') throw new Error('Invalid VerificationRun error'); timestamp(verification.createdAt, 'VerificationRun createdAt'); timestamp(verification.updatedAt, 'VerificationRun updatedAt'); if (verification.startedAt !== null) timestamp(verification.startedAt, 'VerificationRun startedAt'); if (verification.completedAt !== null) timestamp(verification.completedAt, 'VerificationRun completedAt'); if (['queued', 'running'].includes(verification.status) && verification.completedAt !== null || ['passed', 'failed', 'error'].includes(verification.status) && (verification.completedAt === null || verification.reportArtifactId === null)) throw new Error('Invalid VerificationRun lifecycle'); if (verification.status === 'running' && verification.startedAt === null) throw new Error('Running VerificationRun lacks startedAt'); if (verification.status === 'error' && verification.error === null) throw new Error('Infrastructure VerificationRun error is missing'); if (verification.status === 'passed' && (verification.error !== null || verification.checks.some((item) => !item.passed))) throw new Error('Passing VerificationRun has failed evidence'); if (designMap.get(verification.designRevisionId)?.missionId !== verification.missionId || revisionMap.get(verification.workspaceRevisionId)?.missionId !== verification.missionId) throw new Error('VerificationRun binding mismatch'); for (const id of [verification.referenceScreenshotArtifactId, verification.actualScreenshotArtifactId]) if (id && artifactMap.get(id)?.kind !== (id === verification.referenceScreenshotArtifactId ? 'reference_screenshot' : 'actual_screenshot')) throw new Error('VerificationRun screenshot artifact kind mismatch'); if (verification.reportArtifactId && artifactMap.get(verification.reportArtifactId)?.kind !== 'verification_report') throw new Error('VerificationRun report artifact kind mismatch'); }
  for (const mission of database.missions) { const verification = mission.workflow.currentVerificationRunId ? database.verificationRuns.find((run) => run.id === mission.workflow.currentVerificationRunId) : null; if (verification && (verification.missionId !== mission.id || verification.designRevisionId !== mission.workflow.approvedDesignRevisionId || verification.workspaceRevisionId !== mission.workflow.implementedWorkspaceRevisionId)) throw new Error('Mission current VerificationRun authority mismatch'); if (mission.status === 'completed' && (!verification || verification.status !== 'passed')) throw new Error('Completed Mission lacks current PASS authority'); if (mission.status === 'completed' && !database.agentWorkspacePublications.some((publication) => publication.missionId === mission.id && publication.verificationRunId === verification?.id && publication.status === 'published')) throw new Error('Completed Mission lacks published Agent continuation'); }
  for (const mission of database.missions) { const events = database.missionEvents.filter((event) => event.missionId === mission.id).sort((a, b) => a.sequence - b.sequence); for (let index = 0; index < events.length; index += 1) { const event = events[index]!; if (event.sequence !== index + 1) throw new Error('MissionEvent sequence is not contiguous'); enumValue(event.type, ['mission_created', 'participants_reserved', 'workspace_ready', 'attempt_started', 'attempt_completed', 'attempt_failed', 'attempt_result_discarded', 'mission_status_changed', 'participants_released', 'startup_interrupted', 'revision_created', 'revision_restored', 'human_intervention', 'downstream_marked_stale', 'recovery_command', 'recovery_completed', 'budget_admission_denied', 'design_revision_created', 'design_feedback_submitted', 'design_approved', 'implementation_admission_denied', 'verification_started', 'verification_passed', 'verification_failed', 'verification_error', 'verification_result_discarded', 'implementation_precheck_passed', 'implementation_review_accepted', 'implementation_changes_requested', 'repair_scheduled', 'workspace_publication_started', 'workspace_publication_failed', 'workspace_published', 'intent_workflow_completed'], 'MissionEvent type'); if (event.taskId && taskMap.get(event.taskId)?.missionId !== mission.id || event.attemptId && attemptMap.get(event.attemptId)?.missionId !== mission.id || event.agentId && !mission.participants.some((participant) => participant.agentId === event.agentId)) throw new Error('MissionEvent correlation mismatch'); timestamp(event.createdAt, 'MissionEvent createdAt'); } if (mission.nextEventSequence !== events.length + 1) throw new Error('Mission event sequence does not match history'); }
  const revisionSequences = new Map<string, number>(); for (const revision of database.missionWorkspaceRevisions) { const previous = revisionSequences.get(revision.missionId) ?? 0; if (revision.sequence !== previous + 1) throw new Error('Workspace revision sequence is not contiguous'); revisionSequences.set(revision.missionId, revision.sequence); }
  for (const mission of database.missions) { if (mission.workspace.nextRevisionSequence !== (revisionSequences.get(mission.id) ?? 0) + 1) throw new Error('Mission revision sequence does not match history'); if (mission.workspace.revisionStatus === 'clean' && !mission.workspace.currentRevisionId) throw new Error('Clean Mission has no current revision'); }
  const applying = new Set<string>(); for (const command of database.missionRecoveryCommands) { ref(missionIds, command.missionId, 'Recovery command Mission'); ref(taskIds, command.taskId, 'Recovery command task'); ref(workspaceRevisionIds, command.revisionId, 'Recovery command revision'); ref(attemptIds, command.resultAttemptId, 'Recovery result attempt'); ref(workspaceRevisionIds, command.resultRevisionId, 'Recovery result revision'); enumValue(command.kind, ['resume', 'retry_current', 'rollback_and_retry', 'intervene_and_retry', 'stop_preserve', 'stop_restore'], 'Recovery command kind'); enumValue(command.status, ['applying', 'completed', 'failed', 'interrupted'], 'Recovery command status'); timestamp(command.createdAt, 'Recovery command createdAt'); timestamp(command.updatedAt, 'Recovery command updatedAt'); if (command.status === 'applying') { if (applying.has(command.missionId)) throw new Error('Multiple applying recovery commands'); applying.add(command.missionId); } }
  for (const mission of database.missions) { const active = mission.activeRecoveryCommandId ? commandMap.get(mission.activeRecoveryCommandId) : null; if (mission.activeRecoveryCommandId && (!active || active.missionId !== mission.id || active.status !== 'applying')) throw new Error('Mission active recovery command mismatch'); }
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}
  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isObject(parsed) || parsed.version !== 1) throw new Error('Unsupported database format');
      validateDatabase(parsed);
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const next = emptyDatabase(); validateDatabase(next); await this.persist(next); this.data = next;
    }
  }
  snapshot(): Database { return structuredClone(this.data); }
  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => { const previous = this.data; const next = structuredClone(this.data); result = await mutation(next); validateAppendOnly(previous, next); validateDatabase(next); await this.persist(next); this.data = next; });
    this.queue = operation.catch(() => undefined); await operation; return result;
  }
  private async persist(data: Database): Promise<void> { const temporaryPath = this.filePath + '.tmp'; await writeFile(temporaryPath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 }); await rename(temporaryPath, this.filePath); }
}
