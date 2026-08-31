import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentService } from './agent-service.js';
import { loadConfig } from './config.js';
import { FileDesignReferenceStore } from './file-design-reference-store.js';
import { MissionService } from './mission-service.js';
import { RunExecutionService } from './run-execution.js';
import { JsonStore } from './store.js';
import type { AgentRunner, MissionWorkspaceRevision, RunnerRequest, RunnerResult } from './types.js';
import type { BrowserVerifier, VerifierRequest, VerifierResult } from './verification.js';
import { WorkspaceManager } from './workspace.js';

const contract = JSON.stringify({ schemaVersion: 1, viewport: { width: 800, height: 600 }, requiredText: ['Hello'], requiredElements: [], interactions: [] });
const roots: string[] = [];

class BuilderRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];
  constructor(private readonly referenceRoot?: string, private readonly tamperReference = false, private readonly implementationGate?: { started: () => void; release: Promise<void> }, private readonly output: string | null = 'completed') {}
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(request);
    if (request.missionAttempt?.stage === 'design') {
      const draft = path.join(request.workspacePath, '.conductor', 'design-draft');
      await mkdir(draft, { recursive: true });
      await writeFile(path.join(draft, 'index.html'), '<main>Hello</main>');
      await writeFile(path.join(draft, 'styles.css'), 'main { color: red; }');
      await writeFile(path.join(draft, 'design-contract.json'), contract);
    } else {
      await writeFile(path.join(request.workspacePath, 'README.md'), '# Implemented');
      if (this.tamperReference && this.referenceRoot && request.missionAttempt?.inputDesignRevisionId) await writeFile(path.join(this.referenceRoot, request.missionAttempt.missionId, request.missionAttempt.inputDesignRevisionId, 'preview.html'), '<main>Tampered</main>');
      if (this.implementationGate) { this.implementationGate.started(); await this.implementationGate.release; }
    }
    return { output: this.output, threadId: request.missionAttempt?.stage === 'implement' ? 'builder-thread' : 'designer-thread', usage: { inputTokens: 2, outputTokens: 3 } };
  }
  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

class InfrastructureErrorVerifier implements BrowserVerifier {
  async verify(request: VerifierRequest): Promise<VerifierResult> {
    return {
      status: 'error',
      correlationId: request.correlationId,
      checks: [],
      consoleErrors: [],
      pageErrors: [],
      url: null,
      durationMs: 1,
      screenshotBase64: null,
      error: { category: 'infrastructure', message: 'deterministic test verifier unavailable' },
    };
  }
}

class FailOnceTaskSuccessWorkspaceManager extends WorkspaceManager {
  private failedTaskSuccessCapture = false;
  override async captureMissionRevision(input: { missionId: string; revision: Omit<MissionWorkspaceRevision, 'snapshotKey' | 'contentHash'> }): Promise<MissionWorkspaceRevision> {
    if (input.revision.origin === 'task_success' && !this.failedTaskSuccessCapture) {
      this.failedTaskSuccessCapture = true;
      throw new Error('simulated post-Builder checkpoint failure');
    }
    return super.captureMissionRevision(input);
  }
}

async function setup(tamperReference = false, implementationGate?: { started: () => void; release: Promise<void> }, output: string | null = 'completed', providerSecret = '', failTaskSuccessCapture = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'mission-implementation-')); roots.push(root);
  const config = loadConfig({ NODE_ENV: 'test', APP_DATA_DIR: path.join(root, 'data'), AGENT_WORKSPACE_ROOT: path.join(root, 'workspaces'), CODEX_HOME: path.join(root, 'codex'), ...(providerSecret ? { MODEL_API_KEY: providerSecret, MODEL_NAME: 'test' } : {}) });
  const secrets = providerSecret ? [providerSecret] : []; const store = new JsonStore(path.join(root, 'data', 'db.json')); const workspaces = failTaskSuccessCapture ? new FailOnceTaskSuccessWorkspaceManager(config.workspaceRoot) : new WorkspaceManager(config.workspaceRoot); const references = new FileDesignReferenceStore(path.join(config.dataDirectory, 'design-references')); await references.initialize(); const runner = new BuilderRunner(path.join(config.dataDirectory, 'design-references'), tamperReference, implementationGate, output); const execution = new RunExecutionService(store, runner, secrets); const agents = new AgentService(config, store, workspaces, execution); await agents.initialize();
  return { agents, missions: new MissionService(store, workspaces, execution, references, secrets, new InfrastructureErrorVerifier()), runner, store, workspaces };
}

async function approveCurrentDesign(missions: MissionService, missionId: string, revisionId: string): Promise<void> {
  const reference = await missions.getDesignReference(missionId, revisionId);
  await missions.approveDesignRevision(missionId, revisionId, reference.surfaces.map((surface) => surface.id));
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('Implementation admission', () => {
  it('denies before approval and admits one Builder into verifying without completing the Mission', async () => {
    const { agents, missions, runner } = await setup(false, undefined, null); const agent = await agents.createAgent({ name: 'Builder' });
    const mission = await missions.createMission({ goal: 'build approved intent', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id });
    await missions.startMission(mission.id);
    for (let index = 0; index < 200 && missions.getMission(mission.id).mission.workflow.phase !== 'awaiting_approval'; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const draft = missions.getMission(mission.id); await approveCurrentDesign(missions, mission.id, draft.designRevisions[0]!.id);
    const approved = missions.getMission(mission.id); const builderStart = await missions.startMission(mission.id); expect(builderStart.mission.workflow.phase).toBe('implementing');
    for (let index = 0; index < 200 && missions.getMission(mission.id).verificationRuns.at(-1)?.status !== 'error'; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const detail = missions.getMission(mission.id); const request = runner.requests[1]!;
    expect(request.threadId).toBeNull(); expect(request.workspacePath).toBe(detail.displayPath); expect(request.missionAttempt?.stage).toBe('implement'); expect(request.missionAttempt?.inputDesignRevisionId).toBe(approved.mission.workflow.approvedDesignRevisionId); expect(request.prompt).toContain('Approved DesignRevision:'); expect(request.prompt).toContain('Approved contract (read-only):'); expect(request.prompt).toContain(`Input Mission workspace revision: ${approved.tasks[0]?.inputWorkspaceRevisionId}`); expect(request.prompt).not.toContain('design-references');
    expect(detail.mission.status).toBe('paused'); expect(detail.mission.workflow.phase).toBe('verifying'); expect(detail.mission.workflow.currentVerificationRunId).toBe(detail.verificationRuns[0]?.id); expect(detail.verificationRuns).toHaveLength(1); expect(detail.verificationRuns[0]?.status).toBe('error'); expect(detail.tasks.at(-1)?.status).toBe('completed'); expect(detail.attempts.at(-1)?.runtimeThreadId).toBe('builder-thread'); expect(detail.attempts.at(-1)?.outputArtifactId).toBeNull(); expect(detail.mission.completedAt).toBeNull();
  });

  it('finalizes an already-completed Builder after checkpoint failure without rerunning the Agent', async () => {
    const { agents, missions, runner } = await setup(false, undefined, 'Builder completed.', '', true); const agent = await agents.createAgent({ name: 'Builder' });
    const mission = await missions.createMission({ goal: 'recover Builder finalization', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id });
    await missions.startMission(mission.id);
    for (let index = 0; index < 200 && missions.getMission(mission.id).mission.workflow.phase !== 'awaiting_approval'; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const draft = missions.getMission(mission.id); await approveCurrentDesign(missions, mission.id, draft.designRevisions[0]!.id); await missions.startMission(mission.id);
    for (let index = 0; index < 200 && !missions.getMission(mission.id).recovery.resumeImplementation.allowed; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const interrupted = missions.getMission(mission.id); const task = interrupted.tasks.find((item) => item.stage === 'implement')!;
    expect(runner.requests).toHaveLength(2);
    expect(interrupted).toMatchObject({ product: { state: 'implementation_blocked', primaryAction: { id: 'finalize_build' } }, mission: { status: 'recovered_paused', workflow: { phase: 'implementing', implementedWorkspaceRevisionId: null }, workspace: { revisionStatus: 'uncheckpointed' } } });
    expect(interrupted.attempts.at(-1)).toMatchObject({ stage: 'implement', status: 'failed', error: { category: 'infrastructure', message: 'simulated post-Builder checkpoint failure' } });
    expect(interrupted.recovery.resumeImplementation).toMatchObject({ allowed: true, taskId: task.id });

    const recovered = await missions.recover(mission.id, { requestId: crypto.randomUUID(), action: 'resume', taskId: task.id });
    expect(runner.requests).toHaveLength(2);
    expect(recovered.command.resultRevisionId).toBeTruthy();
    for (let index = 0; index < 200 && missions.getMission(mission.id).verificationRuns.at(-1)?.status !== 'error'; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const finalized = missions.getMission(mission.id);
    expect(finalized.mission).toMatchObject({ status: 'paused', workflow: { phase: 'verifying', implementedWorkspaceRevisionId: recovered.command.resultRevisionId }, workspace: { currentRevisionId: recovered.command.resultRevisionId, revisionStatus: 'clean' }, currentTaskId: null });
    expect(finalized.tasks.find((item) => item.id === task.id)).toMatchObject({ status: 'completed', outputWorkspaceRevisionId: recovered.command.resultRevisionId });
    expect(finalized.attempts.at(-1)).toMatchObject({ status: 'completed', error: null, outputWorkspaceRevisionId: recovered.command.resultRevisionId });
    expect(finalized.product).toMatchObject({ state: 'verification_error', primaryAction: { id: 'retry_verification' }, completionAuthority: 'pending' });
  });

  it('rejects a Builder result when the protected reference changes during execution', async () => {
    const { agents, missions, runner } = await setup(true); const agent = await agents.createAgent({ name: 'Builder' });
    const mission = await missions.createMission({ goal: 'protect reference', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id }); await missions.startMission(mission.id);
    for (let index = 0; index < 200 && missions.getMission(mission.id).mission.workflow.phase !== 'awaiting_approval'; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const draft = missions.getMission(mission.id); await approveCurrentDesign(missions, mission.id, draft.designRevisions[0]!.id); await missions.startMission(mission.id);
    for (let index = 0; index < 200 && missions.getMission(mission.id).attempts.at(-1)?.status === 'running'; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const detail = missions.getMission(mission.id); expect(runner.requests).toHaveLength(2); expect(detail.mission.workflow.implementedWorkspaceRevisionId).toBeNull(); expect(detail.mission.workflow.phase).toBe('implementing'); expect(detail.attempts.at(-1)?.error?.message).toBe('protected_reference_integrity_failed'); expect(detail.workspaceInspection.state).toBe('clean'); expect(detail.recovery.stopPreserving.allowed).toBe(true);
    const stopped = await missions.recover(mission.id, { requestId: crypto.randomUUID(), action: 'stop_preserve' });
    expect(stopped.detail.mission).toMatchObject({ status: 'cancelled', currentTaskId: null, workflow: { phase: 'implementing', implementedWorkspaceRevisionId: null } });
    expect(stopped.detail.tasks.find((item) => item.stage === 'implement')?.status).toBe('cancelled');
    await expect(missions.createMission({ goal: 'reuse after failed Builder', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id })).resolves.toBeTruthy();
  });

  it('uses measured Mission usage for Builder admission and does not create a Run when exhausted', async () => {
    const { agents, missions, runner } = await setup(); const agent = await agents.createAgent({ name: 'Builder' });
    const mission = await missions.createMission({ goal: 'budget gate', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id, tokenBudget: 5 }); await missions.startMission(mission.id);
    for (let index = 0; index < 200 && missions.getMission(mission.id).mission.workflow.phase !== 'awaiting_approval'; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const draft = missions.getMission(mission.id); await approveCurrentDesign(missions, mission.id, draft.designRevisions[0]!.id); await expect(missions.startMission(mission.id)).rejects.toMatchObject({ code: 'IMPLEMENTATION_ADMISSION_DENIED', details: { reason: 'budget_exhausted' } });
    const detail = missions.getMission(mission.id); expect(runner.requests).toHaveLength(1); expect(detail.mission.status).toBe('blocked'); expect(detail.events.filter((event) => event.type === 'budget_admission_denied')).toHaveLength(1);
  });

  it('restores a Builder workspace when its result becomes stale before finalization', async () => {
    let startedResolve!: () => void; const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let releaseResolve!: () => void; const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const { agents, missions, store, workspaces } = await setup(false, { started: startedResolve, release }); const agent = await agents.createAgent({ name: 'Builder' });
    const mission = await missions.createMission({ goal: 'stale result', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id }); await missions.startMission(mission.id);
    for (let index = 0; index < 200 && missions.getMission(mission.id).mission.workflow.phase !== 'awaiting_approval'; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const draft = missions.getMission(mission.id); await approveCurrentDesign(missions, mission.id, draft.designRevisions[0]!.id); await missions.startMission(mission.id); await started;
    await store.mutate((database) => { const storedMission = database.missions.find((item) => item.id === mission.id)!; const task = database.missionTasks.find((item) => item.id === storedMission.currentTaskId)!; const attempt = database.taskAttempts.find((item) => item.id === task.authoritativeAttemptId)!; task.authoritativeAttemptId = null; task.authorityVersion += 1; task.status = 'interrupted'; attempt.status = 'interrupted'; attempt.completedAt = new Date().toISOString(); storedMission.status = 'recovered_paused'; storedMission.workspace.revisionStatus = 'uncheckpointed'; });
    releaseResolve();
    for (let index = 0; index < 200 && !missions.getMission(mission.id).events.some((event) => event.type === 'attempt_result_discarded'); index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const detail = missions.getMission(mission.id); expect(await readFile(path.join(workspaces.missionWorkspacePath(mission.id), 'README.md'), 'utf8')).toContain('Builder workspace'); expect(detail.events.find((event) => event.type === 'attempt_result_discarded')?.details).toMatchObject({ workspaceRestored: true }); expect(detail.mission.workflow.implementedWorkspaceRevisionId).toBeNull();
  });

  it('redacts a bare configured provider secret from Builder output and Mission detail', async () => {
    const secret = 'bare-provider-secret-123'; const { agents, missions, store } = await setup(false, undefined, `Builder reported ${secret}`, secret); const agent = await agents.createAgent({ name: 'Builder' });
    const mission = await missions.createMission({ goal: 'secret output', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id }); await missions.startMission(mission.id);
    for (let index = 0; index < 200 && missions.getMission(mission.id).mission.workflow.phase !== 'awaiting_approval'; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const draft = missions.getMission(mission.id); await approveCurrentDesign(missions, mission.id, draft.designRevisions[0]!.id); await missions.startMission(mission.id);
    for (let index = 0; index < 200 && missions.getMission(mission.id).verificationRuns.at(-1)?.status !== 'error'; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const detail = missions.getMission(mission.id); expect(JSON.stringify(detail)).not.toContain(secret); expect(JSON.stringify(store.snapshot())).not.toContain(secret);
  });
});
