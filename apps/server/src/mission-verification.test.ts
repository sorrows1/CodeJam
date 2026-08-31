import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentService } from './agent-service.js';
import { loadConfig } from './config.js';
import { FileDesignReferenceStore } from './file-design-reference-store.js';
import { MissionService } from './mission-service.js';
import { RunExecutionService } from './run-execution.js';
import { JsonStore } from './store.js';
import type { AgentRunner, RunnerRequest, RunnerResult } from './types.js';
import type { Verifier as VerifierPort } from './verification.js';
import { MAX_SCREENSHOT_BYTES, PlaywrightVerifier, buildContainerVerifierArgs, validateVerifierResultBoundary, type VerifierRequest, type VerifierResult } from './verification.js';
import { WorkspaceManager } from './workspace.js';

const contract = JSON.stringify({ schemaVersion: 1, viewport: { width: 800, height: 600 }, requiredText: ['Hello'], requiredElements: [], interactions: [] });
const roots: string[] = [];

class FixtureRunner implements AgentRunner {
  requests: RunnerRequest[] = [];
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(request);
    if (request.missionAttempt?.stage === 'design') {
      const draft = path.join(request.workspacePath, '.conductor', 'design-draft'); await mkdir(draft, { recursive: true });
      await writeFile(path.join(draft, 'index.html'), '<main>Hello</main>'); await writeFile(path.join(draft, 'styles.css'), 'main { color: red; }'); await writeFile(path.join(draft, 'design-contract.json'), contract);
    } else {
      await writeFile(path.join(request.workspacePath, 'README.md'), request.missionAttempt?.stage === 'repair' ? '# Repaired' : '# Implemented');
    }
    return { output: 'done', threadId: request.missionAttempt?.stage === 'design' ? 'designer-thread' : 'builder-thread', usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

class MultiSurfaceRunner extends FixtureRunner {
  override async run(request: RunnerRequest): Promise<RunnerResult> {
    if (request.missionAttempt?.stage !== 'design') return super.run(request);
    this.requests.push(request);
    const draft = path.join(request.workspacePath, '.conductor', 'design-draft'); await mkdir(draft, { recursive: true });
    const bundle = { schemaVersion: 1, primarySurfaceId: 'home', surfaces: [
      { id: 'home', title: 'Home', route: '/', entrypoint: 'src/main.tsx', sourcePaths: ['src/Home.tsx'], sharedDependencies: ['src/Layout.tsx'], states: ['default'], indexHtml: '<main>Hello</main>', stylesCss: 'main { color: red; }', contract: JSON.parse(contract) },
      { id: 'settings', title: 'Settings', route: '/settings', entrypoint: 'src/main.tsx', sourcePaths: ['src/Settings.tsx'], sharedDependencies: ['src/Layout.tsx'], states: ['default'], indexHtml: '<main>Settings</main>', stylesCss: 'main { color: blue; }', contract: { ...JSON.parse(contract), requiredText: ['Settings'] } },
    ] };
    await writeFile(path.join(draft, 'design-bundle.json'), JSON.stringify(bundle));
    return { output: 'done', threadId: 'designer-thread', usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

class UnexpectedSurfaceRunner extends MultiSurfaceRunner {
  override async run(request: RunnerRequest): Promise<RunnerResult> {
    const result = await super.run(request);
    if (request.missionAttempt?.stage === 'implement') { await mkdir(path.join(request.workspacePath, 'src'), { recursive: true }); await writeFile(path.join(request.workspacePath, 'src', 'Unexpected.tsx'), 'export default function Unexpected() { return null; }'); }
    return result;
  }
}

class FakeVerifier implements VerifierPort {
  readonly requests: VerifierRequest[] = [];
  constructor(private readonly results: Array<Omit<VerifierResult, 'correlationId'>>) {}
  async verify(request: VerifierRequest): Promise<VerifierResult> {
    this.requests.push(request);
    const result = this.results.shift();
    if (!result) throw new Error('FakeVerifier result queue exhausted');
    return { ...result, correlationId: request.correlationId };
  }
}

async function setup(results: Array<Omit<VerifierResult, 'correlationId'>>, suppliedVerifier?: VerifierPort, suppliedRunner?: FixtureRunner) {
  const root = await mkdtemp(path.join(tmpdir(), 'mission-verification-')); roots.push(root);
  const config = loadConfig({ NODE_ENV: 'test', APP_DATA_DIR: path.join(root, 'data'), AGENT_WORKSPACE_ROOT: path.join(root, 'workspaces'), CODEX_HOME: path.join(root, 'codex') });
  const store = new JsonStore(path.join(root, 'data', 'db.json')); const workspaces = new WorkspaceManager(config.workspaceRoot); const references = new FileDesignReferenceStore(path.join(config.dataDirectory, 'design-references')); await references.initialize();
  const runner = suppliedRunner ?? new FixtureRunner(); const execution = new RunExecutionService(store, runner); const agents = new AgentService(config, store, workspaces, execution); await agents.initialize(); const verifier = suppliedVerifier ?? new FakeVerifier(results); const missions = new MissionService(store, workspaces, execution, references, [], verifier); return { agents, missions, verifier, runner, store, workspaces };
}

const jpeg = (width = 800, height = 600): Buffer => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
const passed = (): Omit<VerifierResult, 'correlationId'> => { const screenshot = jpeg(); return { status: 'passed', checks: [{ id: 'text-1', kind: 'text', label: 'Hello', passed: true, details: 'present' }], consoleErrors: [], pageErrors: [], url: 'http://127.0.0.1:41000/', durationMs: 4, screenshotBase64: screenshot.toString('base64'), screenshotMediaType: 'image/jpeg', screenshotWidth: 800, screenshotHeight: 600, screenshotByteLength: screenshot.byteLength, screenshotSha256: createHash('sha256').update(screenshot).digest('hex'), screenshotQuality: 86, error: null }; };
const failed = (): Omit<VerifierResult, 'correlationId'> => ({ ...passed(), status: 'failed', checks: [{ id: 'text-1', kind: 'text', label: 'Hello', passed: false, details: 'missing' }] });
const errored = (): Omit<VerifierResult, 'correlationId'> => ({ ...passed(), status: 'error', checks: [], screenshotBase64: null, error: { category: 'infrastructure', message: 'browser unavailable' } });

async function waitFor(read: () => boolean): Promise<void> { for (let index = 0; index < 400 && !read(); index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); expect(read()).toBe(true); }
async function approveCurrentDesign(missions: MissionService, missionId: string, revisionId: string): Promise<void> {
  const reference = await missions.getDesignReference(missionId, revisionId);
  await missions.approveDesignRevision(missionId, revisionId, reference.surfaces.map((surface) => surface.id));
}
async function buildApprovedImplementation(missions: MissionService, agents: AgentService) {
  const agent = await agents.createAgent({ name: 'Builder' });
  const mission = await missions.createMission({ goal: 'verify intent', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id });
  await missions.startMission(mission.id);
  await waitFor(() => missions.getMission(mission.id).mission.workflow.phase === 'awaiting_approval');
  const draft = missions.getMission(mission.id);
  await approveCurrentDesign(missions, mission.id, draft.designRevisions[0]!.id);
  await missions.startMission(mission.id);
  await waitFor(() => missions.getMission(mission.id).mission.workflow.implementedWorkspaceRevisionId !== null);
  return mission.id;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('Independent verification authority', () => {
  it('keeps container stdin attached while preserving verifier isolation', () => {
    const request: VerifierRequest = { missionId: 'mission-1', designRevisionId: 'design-1', workspaceRevisionId: 'workspace-1', correlationId: 'correlation-1', workspacePath: path.resolve('test-fixtures/verification-pass'), contract: { schemaVersion: 1, viewport: { width: 800, height: 600 }, requiredText: [], requiredElements: [], interactions: [] } };
    const args = buildContainerVerifierArgs(request, { engine: 'docker', image: 'conductor-verifier:test' });
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '-i']); expect(args).toContain('--network'); expect(args[args.indexOf('--network') + 1]).toBe('none'); expect(args).toContain('--read-only'); expect(args).toContain('--cap-drop'); expect(args).toContain('no-new-privileges'); expect(args.at(-1)).toBe('conductor-verifier:test');
  });

  it('prechecks automatically, requires human acceptance, then completes only from a second final PASS', async () => {
    const fixture = await setup([passed(), passed()]);
    const missionId = await buildApprovedImplementation(fixture.missions, fixture.agents);
    await waitFor(() => fixture.missions.getMission(missionId).product.state === 'implementation_review');
    const review = fixture.missions.getMission(missionId);
    expect(review.mission.status).toBe('paused');
    expect(review.mission.completedAt).toBeNull();
    expect(review.product).toMatchObject({ completionAuthority: 'pending', primaryAction: { id: 'accept_implementation' }, implementationReview: { accepted: false } });
    expect(review.events.some((event) => event.type === 'implementation_precheck_passed')).toBe(true);
    expect(review.verificationRuns).toHaveLength(1);
    await fixture.missions.reviewImplementation(missionId, { decision: 'accept' });
    await waitFor(() => fixture.missions.getMission(missionId).mission.status === 'completed');
    const completed = fixture.missions.getMission(missionId);
    expect(completed.verificationRuns.map((run) => run.status)).toEqual(['passed', 'passed']);
    expect(completed.events).toContainEqual(expect.objectContaining({ type: 'implementation_review_accepted', actor: 'human', details: expect.objectContaining({ precheckVerificationRunId: review.verificationRuns[0]!.id, designRevisionId: review.mission.workflow.approvedDesignRevisionId, workspaceRevisionId: review.mission.workflow.implementedWorkspaceRevisionId }) }));
    expect(completed.verificationRuns[1]).toMatchObject({ designRevisionId: review.mission.workflow.approvedDesignRevisionId, workspaceRevisionId: review.mission.workflow.implementedWorkspaceRevisionId });
    expect(completed.events.some((event) => event.type === 'participants_released')).toBe(true);
    expect(completed.product.completionAuthority).toBe('authorized');
    expect(completed.publication).toMatchObject({ status: 'published', threadDisposition: 'reset', designRevisionId: completed.mission.workflow.approvedDesignRevisionId, workspaceRevisionId: completed.mission.workflow.implementedWorkspaceRevisionId, verificationRunId: completed.verificationRuns[1]!.id });
    const sourceAgent = fixture.store.snapshot().agents.find((agent) => agent.id === completed.mission.workspace.source.agentId)!;
    expect(sourceAgent.codexThreadId).toBeNull();
    expect(await readFile(path.join(sourceAgent.workspacePath, 'README.md'), 'utf8')).toBe('# Implemented');
    expect(completed.events.map((event) => event.type)).toEqual(expect.arrayContaining(['workspace_publication_started', 'workspace_published', 'intent_workflow_completed']));
    const durableHistory = await fixture.missions.getMissionWithHistory(missionId);
    const designHistory = durableHistory.history.find((entry) => entry.kind === 'attempt' && entry.stage === 'design');
    expect(designHistory).toMatchObject({ kind: 'attempt', filesAvailable: true, files: [{ operation: 'WRITE', path: '.conductor/design-draft/design-bundle.json' }] });
    expect(fixture.runner.requests.filter((request) => request.missionAttempt?.stage === 'implement')).toHaveLength(1);
    expect(fixture.runner.requests.filter((request) => request.missionAttempt?.stage === 'repair')).toHaveLength(0);
  });

  it('verifies every route in one approved atomic surface bundle', async () => {
    const verifier = new FakeVerifier([passed(), passed(), passed(), passed()]);
    const fixture = await setup([], verifier, new MultiSurfaceRunner());
    const missionId = await buildApprovedImplementation(fixture.missions, fixture.agents);
    await waitFor(() => fixture.missions.getMission(missionId).product.state === 'implementation_review');
    expect(verifier.requests.map((request) => request.route)).toEqual(['/', '/settings']);
    expect(fixture.missions.getMission(missionId).verificationRuns[0]!.checks.every((check) => check.id.startsWith('home:') || check.id.startsWith('settings:'))).toBe(true);
    await fixture.missions.reviewImplementation(missionId, { decision: 'accept' });
    await waitFor(() => fixture.missions.getMission(missionId).mission.status === 'completed');
    expect(verifier.requests.map((request) => request.route)).toEqual(['/', '/settings', '/', '/settings']);
  });

  it('keeps participants reserved when verified publication fails and retries without rerunning the Agent', async () => {
    const fixture = await setup([passed(), passed()]);
    const missionId = await buildApprovedImplementation(fixture.missions, fixture.agents);
    await waitFor(() => fixture.missions.getMission(missionId).product.state === 'implementation_review');
    const publication = vi.spyOn(fixture.workspaces, 'publishAgentWorkspace').mockRejectedValueOnce(new Error('simulated publication failure'));
    await fixture.missions.reviewImplementation(missionId, { decision: 'accept' });
    await waitFor(() => fixture.missions.getMission(missionId).publication?.status === 'failed');
    const failedPublication = fixture.missions.getMission(missionId);
    expect(failedPublication.mission.status).toBe('recovered_paused');
    expect(failedPublication.publication?.error).toContain('simulated publication failure');
    expect(fixture.missions.listAgentAvailability().find((item) => item.agentId === failedPublication.mission.workspace.source.agentId)).toMatchObject({ availableForMission: false, reservingMissionId: missionId });
    const runCount = fixture.runner.requests.length;
    publication.mockRestore();
    await fixture.missions.retryWorkspacePublication(missionId);
    expect(fixture.missions.getMission(missionId).mission.status).toBe('completed');
    expect(fixture.runner.requests).toHaveLength(runCount);
  });

  it('restores and requires a new whole-bundle design when implementation expands frontend scope', async () => {
    const verifier = new FakeVerifier([]); const fixture = await setup([], verifier, new UnexpectedSurfaceRunner());
    const agent = await fixture.agents.createAgent({ name: 'Builder' });
    const mission = await fixture.missions.createMission({ goal: 'Build the approved pages', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id });
    await fixture.missions.startMission(mission.id); await waitFor(() => fixture.missions.getMission(mission.id).mission.workflow.phase === 'awaiting_approval');
    const draft = fixture.missions.getMission(mission.id); await approveCurrentDesign(fixture.missions, mission.id, draft.designRevisions[0]!.id); await fixture.missions.startMission(mission.id);
    await waitFor(() => fixture.missions.getMission(mission.id).attempts.some((attempt) => attempt.stage === 'implement' && attempt.status === 'failed'));
    const redesigned = fixture.missions.getMission(mission.id);
    expect(redesigned.mission.workflow).toMatchObject({ approvedDesignRevisionId: null, implementedWorkspaceRevisionId: null, currentVerificationRunId: null });
    expect(redesigned.tasks.at(-1)).toMatchObject({ stage: 'design', status: 'pending' });
    expect(redesigned.attempts.at(-1)).toMatchObject({ stage: 'implement', status: 'failed', error: { category: 'agent' } });
    expect(redesigned.events).toContainEqual(expect.objectContaining({ type: 'downstream_marked_stale', details: expect.objectContaining({ reason: 'unexpected_frontend_scope' }) }));
    expect(verifier.requests).toHaveLength(0);
  });

  it('denies completion on final semantic FAIL without authorizing Repair', async () => {
    const fixture = await setup([passed(), failed()]);
    const missionId = await buildApprovedImplementation(fixture.missions, fixture.agents);
    await waitFor(() => fixture.missions.getMission(missionId).product.state === 'implementation_review');
    await fixture.missions.reviewImplementation(missionId, { decision: 'accept' });
    await waitFor(() => fixture.missions.getMission(missionId).mission.status === 'blocked');
    const denied = fixture.missions.getMission(missionId);
    expect(denied.mission).toMatchObject({ status: 'blocked', completedAt: null, workflow: { phase: 'awaiting_intervention', repairCycle: 0 } });
    expect(denied.product).toMatchObject({ state: 'verification_failed', currentStage: 'verify', completionAuthority: 'denied', primaryAction: null, implementationReview: { accepted: true, canRequestChanges: false } });
    expect(denied.events).toContainEqual(expect.objectContaining({ type: 'verification_failed', details: expect.objectContaining({ mode: 'final' }) }));
    expect(denied.events.filter((event) => event.type === 'repair_scheduled')).toHaveLength(0);
    expect(fixture.runner.requests.filter((request) => request.missionAttempt?.stage === 'repair')).toHaveLength(0);
    await expect(fixture.missions.reviewImplementation(missionId, { decision: 'request_changes', feedback: 'Repair after final failure.' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('allows one human Repair after the single automatic Repair still fails, then denies a third cycle', async () => {
    const fixture = await setup([failed(), failed(), failed()]);
    const missionId = await buildApprovedImplementation(fixture.missions, fixture.agents);
    await waitFor(() => fixture.missions.getMission(missionId).mission.status === 'blocked');
    const blocked = fixture.missions.getMission(missionId);
    expect(blocked.mission.workflow.phase).toBe('awaiting_intervention');
    expect(blocked.mission.workflow.repairCycle).toBe(1);
    expect(blocked.verificationRuns.map((run) => run.status)).toEqual(['failed', 'failed']);
    expect(blocked.events.filter((event) => event.type === 'repair_scheduled' && event.details.trigger === 'automatic_precheck')).toHaveLength(1);
    expect(fixture.runner.requests.filter((request) => request.missionAttempt?.stage === 'repair')).toHaveLength(1);
    expect(fixture.runner.requests.filter((request) => request.missionAttempt?.stage === 'repair').every((request) => request.threadId === null)).toBe(true);
    expect(blocked.mission.completedAt).toBeNull();
    expect(blocked.product).toMatchObject({ completionAuthority: 'denied', primaryAction: null, implementationReview: { canRequestChanges: true } });
    await expect(fixture.missions.reviewImplementation(missionId, { decision: 'accept' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(fixture.missions.reviewImplementation(missionId, { decision: 'request_changes', feedback: '   ' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(fixture.missions.verifyMission(missionId)).rejects.toMatchObject({ code: 'VERIFICATION_ADMISSION_DENIED', details: { reason: 'semantic_failure_blocked' } });
    const failedWorkspace = blocked.mission.workflow.implementedWorkspaceRevisionId;
    const failedRun = blocked.mission.workflow.currentVerificationRunId;
    await fixture.missions.reviewImplementation(missionId, { decision: 'request_changes', feedback: 'Restore the approved interaction without changing the design.' });
    await waitFor(() => { const current = fixture.missions.getMission(missionId); return current.mission.status === 'blocked' && current.mission.workflow.repairCycle === 2; });
    const exhausted = fixture.missions.getMission(missionId);
    expect(exhausted.events.filter((event) => event.type === 'repair_scheduled' && event.details.trigger === 'automatic_precheck')).toHaveLength(1);
    expect(exhausted.events.filter((event) => event.type === 'repair_scheduled' && event.details.trigger === 'human_review')).toHaveLength(1);
    expect(exhausted.events).toContainEqual(expect.objectContaining({ type: 'implementation_changes_requested', actor: 'human', details: expect.objectContaining({ verificationRunId: failedRun, workspaceRevisionId: failedWorkspace, repairCycle: 2 }) }));
    expect(exhausted.mission.workflow.repairCycle).toBe(2);
    expect(exhausted.product).toMatchObject({ completionAuthority: 'denied', primaryAction: null, implementationReview: { canRequestChanges: false } });
    expect(fixture.runner.requests.filter((request) => request.missionAttempt?.stage === 'repair')).toHaveLength(2);
    expect(fixture.runner.requests.filter((request) => request.missionAttempt?.stage === 'repair').every((request) => request.threadId === null)).toBe(true);
    await expect(fixture.missions.reviewImplementation(missionId, { decision: 'request_changes', feedback: 'Try a third Repair.' })).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.runner.requests.filter((request) => request.missionAttempt?.stage === 'repair')).toHaveLength(2);
  });

  it('lets human review request one bounded Repair without changing the approved DesignRevision', async () => {
    const fixture = await setup([passed(), passed(), passed()]);
    const missionId = await buildApprovedImplementation(fixture.missions, fixture.agents);
    await waitFor(() => fixture.missions.getMission(missionId).product.state === 'implementation_review');
    const before = fixture.missions.getMission(missionId);
    const approvedDesign = before.mission.workflow.approvedDesignRevisionId;
    const firstWorkspace = before.mission.workflow.implementedWorkspaceRevisionId;
    await fixture.missions.reviewImplementation(missionId, { decision: 'request_changes', feedback: 'Match the approved hero spacing more closely.' });
    await waitFor(() => { const current = fixture.missions.getMission(missionId); return current.product.state === 'implementation_review' && current.mission.workflow.implementedWorkspaceRevisionId !== firstWorkspace; });
    const reviewedAgain = fixture.missions.getMission(missionId);
    expect(reviewedAgain.mission.workflow.approvedDesignRevisionId).toBe(approvedDesign);
    expect(reviewedAgain.mission.workflow.repairCycle).toBe(1);
    expect(reviewedAgain.events.some((event) => event.type === 'implementation_changes_requested' && event.actor === 'human')).toBe(true);
    expect(fixture.runner.requests.filter((request) => request.missionAttempt?.stage === 'repair')).toHaveLength(1);
    expect(reviewedAgain.product.implementationReview.canRequestChanges).toBe(false);
    await expect(fixture.missions.reviewImplementation(missionId, { decision: 'request_changes', feedback: 'Request a second human Repair.' })).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.runner.requests.filter((request) => request.missionAttempt?.stage === 'repair')).toHaveLength(1);
    await fixture.missions.reviewImplementation(missionId, { decision: 'accept' });
    await waitFor(() => fixture.missions.getMission(missionId).mission.status === 'completed');
    expect(fixture.missions.getMission(missionId).verificationRuns).toHaveLength(3);
  });

  it('keeps infrastructure ERROR retryable against the same revision without rerunning Builder or Repair', async () => {
    const fixture = await setup([errored(), passed(), passed()]);
    const missionId = await buildApprovedImplementation(fixture.missions, fixture.agents);
    await waitFor(() => fixture.missions.getMission(missionId).verificationRuns[0]?.status === 'error');
    const afterError = fixture.missions.getMission(missionId);
    const implementationRevision = afterError.mission.workflow.implementedWorkspaceRevisionId;
    const approvedDesign = afterError.mission.workflow.approvedDesignRevisionId;
    expect(afterError.recovery.retryVerification).toMatchObject({ allowed: true, designRevisionId: approvedDesign, workspaceRevisionId: implementationRevision });
    await fixture.missions.verifyMission(missionId);
    await waitFor(() => fixture.missions.getMission(missionId).product.state === 'implementation_review');
    await fixture.missions.reviewImplementation(missionId, { decision: 'accept' });
    await waitFor(() => fixture.missions.getMission(missionId).mission.status === 'completed');
    const detail = fixture.missions.getMission(missionId);
    expect(fixture.verifier.requests).toHaveLength(3);
    expect(fixture.verifier.requests.every((request) => request.workspaceRevisionId === implementationRevision)).toBe(true);
    expect(fixture.verifier.requests.every((request) => request.designRevisionId === approvedDesign)).toBe(true);
    expect(fixture.runner.requests.filter((request) => request.missionAttempt?.stage === 'implement')).toHaveLength(1);
    expect(fixture.runner.requests.filter((request) => request.missionAttempt?.stage === 'repair')).toHaveLength(0);
    expect(detail.verificationRuns.map((run) => run.status)).toEqual(['error', 'passed', 'passed']);
  });

  it('records a late precheck result without allowing stale verification to advance the Mission', async () => {
    let release!: (result: VerifierResult) => void;
    const pending = new Promise<VerifierResult>((resolve) => { release = resolve; });
    const delayedVerifier: VerifierPort = { async verify(request) { return pending.then((result) => ({ ...result, correlationId: request.correlationId })); } };
    const fixture = await setup([], delayedVerifier);
    const missionId = await buildApprovedImplementation(fixture.missions, fixture.agents);
    await waitFor(() => fixture.missions.getMission(missionId).verificationRuns[0]?.status === 'running');
    const run = fixture.missions.getMission(missionId).verificationRuns[0]!;
    await fixture.store.mutate((database) => { const mission = database.missions.find((item) => item.id === missionId)!; mission.workflow.currentVerificationRunId = null; mission.status = 'paused'; });
    release({ ...passed(), correlationId: run.correlationId });
    await waitFor(() => fixture.missions.getMission(missionId).verificationRuns[0]?.status === 'passed');
    const detail = fixture.missions.getMission(missionId);
    expect(detail.mission.status).toBe('paused');
    expect(detail.mission.workflow.phase).toBe('verifying');
    expect(detail.events.some((event) => event.type === 'verification_result_discarded')).toBe(true);
    expect(detail.events.some((event) => event.type === 'implementation_precheck_passed')).toBe(false);
  });

  it.each([
    ['missing metadata', (result: VerifierResult) => { delete result.screenshotWidth; }],
    ['forged dimensions', (result: VerifierResult) => { result.screenshotWidth = 801; }],
    ['forged hash', (result: VerifierResult) => { result.screenshotSha256 = '0'.repeat(64); }],
    ['non-JPEG bytes', (result: VerifierResult) => { const bytes = Buffer.from('not-jpeg'); result.screenshotBase64 = bytes.toString('base64'); result.screenshotByteLength = bytes.byteLength; result.screenshotSha256 = createHash('sha256').update(bytes).digest('hex'); }],
    ['oversized capture', (result: VerifierResult) => { const bytes = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1, 1); result.screenshotBase64 = bytes.toString('base64'); result.screenshotByteLength = bytes.byteLength; result.screenshotSha256 = createHash('sha256').update(bytes).digest('hex'); }],
  ])('rejects %s at the complete external verifier boundary', (_label, mutate) => {
    const result = { ...passed(), correlationId: 'correlation' } as VerifierResult;
    mutate(result);
    expect(() => validateVerifierResultBoundary(result, 'correlation')).toThrow(/screenshot/i);
  });

  it('turns a malformed legacy capture into durable retryable ERROR without rerunning Builder', async () => {
    const malformed = passed() as Omit<VerifierResult, 'correlationId'>;
    delete malformed.screenshotWidth;
    const fixture = await setup([malformed, passed(), passed()]);
    const missionId = await buildApprovedImplementation(fixture.missions, fixture.agents);
    await waitFor(() => fixture.missions.getMission(missionId).verificationRuns[0]?.status === 'error');
    const afterError = fixture.missions.getMission(missionId);
    const designRevisionId = afterError.mission.workflow.approvedDesignRevisionId;
    const workspaceRevisionId = afterError.mission.workflow.implementedWorkspaceRevisionId;
    expect(afterError.verificationRuns[0]).toMatchObject({ status: 'error', actualScreenshotArtifactId: null, referenceScreenshotArtifactId: null, designRevisionId, workspaceRevisionId });
    expect(afterError.verificationRuns[0]?.error?.message).toMatch(/screenshot/i);
    expect(afterError.recovery.retryVerification).toMatchObject({ allowed: true, designRevisionId, workspaceRevisionId });
    await fixture.missions.verifyMission(missionId);
    await waitFor(() => fixture.missions.getMission(missionId).product.state === 'implementation_review');
    await fixture.missions.reviewImplementation(missionId, { decision: 'accept' });
    await waitFor(() => fixture.missions.getMission(missionId).mission.status === 'completed');
    expect(fixture.verifier.requests.every((request) => request.designRevisionId === designRevisionId && request.workspaceRevisionId === workspaceRevisionId)).toBe(true);
    expect(fixture.runner.requests.filter((request) => request.missionAttempt?.stage === 'implement')).toHaveLength(1);
    expect(fixture.runner.requests.filter((request) => request.missionAttempt?.stage === 'repair')).toHaveLength(0);
  });

  it('executes real Vite PASS and FAIL fixtures with Playwright', async () => {
    const verifier = new PlaywrightVerifier({ timeoutMs: 15_000 });
    const contract = { schemaVersion: 1 as const, viewport: { width: 800, height: 600 }, requiredText: ['Intent complete'], requiredElements: [{ role: 'button' as const, name: 'Reveal result' }], interactions: [{ id: 'reveal', action: 'click' as const, target: { role: 'button' as const, name: 'Reveal result' }, expected: { requiredText: ['Verified'], requiredElements: [] } }] };
    const base = { missionId: '00000000-0000-4000-8000-000000000001', designRevisionId: '00000000-0000-4000-8000-000000000002', workspaceRevisionId: '00000000-0000-4000-8000-000000000003', correlationId: 'real-fixture', contract };
    const passResult = await verifier.verify({ ...base, workspacePath: path.resolve('test-fixtures/verification-pass') }); expect(passResult.status, passResult.error?.message).toBe('passed'); expect(passResult.screenshotBase64).toBeTruthy(); expect(passResult.checks.every((item) => item.passed)).toBe(true);
    const seededFixtureResult = await verifier.verify({ ...base, workspacePath: path.resolve('../../demo/intent-verification') }); expect(seededFixtureResult.status, seededFixtureResult.error?.message).toBe('passed'); expect(seededFixtureResult.screenshotBase64).toBeTruthy(); expect(seededFixtureResult.checks.every((item) => item.passed)).toBe(true);
    const failResult = await verifier.verify({ ...base, workspacePath: path.resolve('test-fixtures/verification-fail') }); expect(failResult.status).toBe('failed'); expect(failResult.screenshotBase64).toBeTruthy(); expect(failResult.checks.some((item) => !item.passed)).toBe(true);
  }, 30_000);
});
