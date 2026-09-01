import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissionService } from './mission-service.js';
import {
  decidePlaygroundImpact,
  impactProposalPrompt,
  normalizePlaygroundImpactProposal,
  parsePlaygroundImpactProposal,
  PLAYGROUND_IMPACT_PROPOSAL_EXAMPLE,
} from './playground-impact.js';
import { PlaygroundImpactService } from './playground-impact-service.js';
import { RunExecutionService } from './run-execution.js';
import { JsonStore } from './store.js';
import type {
  Agent,
  AgentRunner,
  PlaygroundImpactAdmission,
  RunnerRequest,
  RunnerResult,
} from './types.js';
import { WorkspaceManager } from './workspace.js';

const roots: string[] = [];
const proposal = (uncertainty: 'low' | 'medium' | 'high' = 'low') =>
  JSON.stringify({
    routes: [],
    entrypoints: [],
    sharedLayouts: [],
    componentDependencies: [],
    predictedWritePaths: [],
    surfaces: [],
    effects: { visual: false, interaction: false, accessibility: false, display: false },
    evidence: ['No frontend paths are involved.'],
    uncertainty,
  });

class ImpactRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];

  constructor(
    private readonly planningOutput: string,
    private readonly mutateOnPlan = false,
    private readonly failPlanning = false,
  ) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(request);
    if (request.accessMode === 'read_only') {
      if (this.mutateOnPlan) {
        await mkdir(path.join(request.workspacePath, 'src'), { recursive: true });
        await writeFile(path.join(request.workspacePath, 'src', 'App.tsx'), 'changed');
      }
      if (this.failPlanning) throw new Error('inspection shell unavailable');
      return {
        output: this.planningOutput,
        threadId: 'proposal-thread',
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    }
    return {
      output: 'ordinary result',
      threadId: request.threadId ?? 'ordinary-thread',
      usage: { inputTokens: 4, outputTokens: 3 },
    };
  }

  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

class CandidateFrontendRunner extends ImpactRunner {
  override async run(request: RunnerRequest): Promise<RunnerResult> {
    const result = await super.run(request);
    if (request.accessMode === 'write') {
      await mkdir(path.join(request.workspacePath, 'src'), { recursive: true });
      await writeFile(
        path.join(request.workspacePath, 'src', 'App.tsx'),
        'export default function App() { return <main>changed</main>; }',
      );
    }
    return result;
  }
}

class CandidateBackendRunner extends ImpactRunner {
  override async run(request: RunnerRequest): Promise<RunnerResult> {
    const result = await super.run(request);
    if (request.accessMode === 'write') {
      await mkdir(path.join(request.workspacePath, 'server'), { recursive: true });
      await writeFile(
        path.join(request.workspacePath, 'server', 'handler.test.ts'),
        'export const covered = true;',
      );
    }
    return result;
  }
}

class CandidateAmbiguousRunner extends ImpactRunner {
  override async run(request: RunnerRequest): Promise<RunnerResult> {
    const result = await super.run(request);
    if (request.accessMode === 'write') {
      await mkdir(path.join(request.workspacePath, 'src'), { recursive: true });
      await writeFile(path.join(request.workspacePath, 'src', 'helper.ts'), 'export const value = 1;');
    }
    return result;
  }
}

class SequencedBackendRunner extends ImpactRunner {
  readonly candidateSawPreviousPublication: boolean[] = [];
  private candidateCount = 0;

  override async run(request: RunnerRequest): Promise<RunnerResult> {
    const result = await super.run(request);
    if (request.accessMode === 'write') {
      const serverRoot = path.join(request.workspacePath, 'server');
      this.candidateSawPreviousPublication.push(
        await stat(path.join(serverRoot, 'first.ts')).then(() => true).catch(() => false),
      );
      await mkdir(serverRoot, { recursive: true });
      const fileName = this.candidateCount === 0 ? 'first.ts' : 'second.ts';
      await writeFile(
        path.join(serverRoot, fileName),
        `export const sequence = ${this.candidateCount + 1};`,
      );
      this.candidateCount += 1;
    }
    return result;
  }
}

async function waitFor(read: () => boolean): Promise<void> {
  for (let index = 0; index < 200 && !read(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(read()).toBe(true);
}

async function setup(runner: AgentRunner) {
  const root = await mkdtemp(path.join(tmpdir(), 'playground-impact-'));
  roots.push(root);
  const store = new JsonStore(path.join(root, 'data.json'));
  await store.initialize();
  const workspaces = new WorkspaceManager(path.join(root, 'workspaces'));
  await workspaces.initialize();
  const timestamp = new Date().toISOString();
  const agent: Agent = {
    id: randomUUID(),
    name: 'Agent',
    description: '',
    instructions: '',
    status: 'ready',
    workspacePath: '',
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  agent.workspacePath = workspaces.workspacePath(agent.id);
  await workspaces.create(agent);
  await store.mutate((database) => database.agents.push(agent));
  const execution = new RunExecutionService(store, runner);
  const missions = new MissionService(store, workspaces, execution);
  const impact = new PlaygroundImpactService(store, workspaces, execution, missions);
  return { root, store, workspaces, agent, execution, missions, impact };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Playground impact admission', () => {
  it('keeps the prompt example synchronized with the strict proposal parser', () => {
    expect(parsePlaygroundImpactProposal(JSON.stringify(PLAYGROUND_IMPACT_PROPOSAL_EXAMPLE)))
      .toEqual(PLAYGROUND_IMPACT_PROPOSAL_EXAMPLE);
    const prompt = impactProposalPrompt('Add Settings', ['src/App.tsx', 'src/Sidebar.tsx']);
    expect(prompt).toContain(JSON.stringify(PLAYGROUND_IMPACT_PROPOSAL_EXAMPLE, null, 2));
    expect(prompt).toContain('route is one string, never an array');
    expect(prompt).toContain('do not use desktopViewport');
    expect(prompt).toContain('never list them merely because they exist');
    expect(prompt).toContain('requests no workspace change');
    expect(prompt).toContain('do not fail merely because a shell is unavailable');
    expect(prompt).toContain('raise uncertainty instead of inventing affected paths');
  });

  it('fails closed on contradictory frontend facts', () => {
    const parsed = parsePlaygroundImpactProposal(JSON.stringify({
      routes: ['/'],
      entrypoints: ['src/main.tsx'],
      sharedLayouts: [],
      componentDependencies: [],
      predictedWritePaths: ['src/App.tsx'],
      surfaces: [],
      effects: { visual: false, interaction: false, accessibility: false, display: false },
      evidence: ['entrypoint'],
      uncertainty: 'low',
    }));
    expect(decidePlaygroundImpact({
      prompt: 'Refactor the code',
      proposal: parsed,
      repositoryPaths: ['src/main.tsx', 'src/App.tsx'],
    })).toMatchObject({ decision: 'confirmation_required', allowNonvisualConfirmation: false });
  });

  it('removes copied repository surfaces from non-actionable conversation', () => {
    const contaminated = {
      ...PLAYGROUND_IMPACT_PROPOSAL_EXAMPLE,
      effects: { visual: true, interaction: true, accessibility: true, display: true },
      evidence: ["The user request ('hi') contains no concrete change."],
      uncertainty: 'high' as const,
    };
    for (const message of ['hi', 'good morning', 'how are you?', 'what can you do?', 'what did we just do?']) {
      const normalized = normalizePlaygroundImpactProposal(message, contaminated);
      expect(normalized).toMatchObject({
        routes: [],
        entrypoints: [],
        sharedLayouts: [],
        componentDependencies: [],
        predictedWritePaths: [],
        surfaces: [],
        effects: { visual: false, interaction: false, accessibility: false, display: false },
        uncertainty: 'low',
      });
    }
  });

  it('admits a greeting after discarding model-invented impact from existing routes', async () => {
    const contaminated = JSON.stringify({
      ...PLAYGROUND_IMPACT_PROPOSAL_EXAMPLE,
      effects: { visual: true, interaction: true, accessibility: true, display: true },
      evidence: ["The user request ('hi') contains no concrete change."],
      uncertainty: 'high',
    });
    const runner = new ImpactRunner(contaminated);
    const fixture = await setup(runner);
    await fixture.impact.submit(fixture.agent.id, 'hi', randomUUID());
    await waitFor(() => fixture.impact.list(fixture.agent.id)[0]?.status === 'admitted');
    expect(fixture.impact.list(fixture.agent.id)[0]).toMatchObject({
      prompt: 'hi',
      decision: 'nonvisual',
      status: 'admitted',
      missionId: null,
      proposal: { routes: [], surfaces: [], uncertainty: 'low' },
    });
    expect(runner.requests.map((request) => request.accessMode)).toEqual(['read_only', 'write']);
  });

  it('uses bounded fallback evidence when read-only planning cannot start', async () => {
    const runner = new ImpactRunner(proposal(), false, true);
    const fixture = await setup(runner);
    await fixture.impact.submit(fixture.agent.id, 'Refactor server types', randomUUID());
    await waitFor(() => fixture.impact.list(fixture.agent.id)[0]?.status === 'confirmation_required');
    const admission = fixture.impact.list(fixture.agent.id)[0]!;
    expect(admission).toMatchObject({
      decision: 'confirmation_required',
      allowNonvisualConfirmation: true,
      status: 'confirmation_required',
      proposal: { uncertainty: 'high' },
    });
    expect(admission.proposal?.evidence.join(' ')).toContain('inspection shell unavailable');
    expect(runner.requests).toHaveLength(1);
  });

  it('adopts the first published ordinary candidate thread', async () => {
    const runner = new CandidateBackendRunner(proposal());
    const fixture = await setup(runner);
    await fixture.impact.submit(fixture.agent.id, 'Add backend API tests', randomUUID());
    await waitFor(() => fixture.impact.list(fixture.agent.id)[0]?.status === 'admitted');
    expect(runner.requests.map((request) => request.accessMode)).toEqual(['read_only', 'write']);
    expect(runner.requests[0]!.threadId).toBeNull();
    expect(runner.requests[1]!.threadId).toBeNull();
    expect(fixture.store.snapshot().agents[0]!.codexThreadId).toBe('ordinary-thread');
    expect(await readFile(path.join(fixture.agent.workspacePath, 'server', 'handler.test.ts'), 'utf8'))
      .toContain('covered');
  });

  it('deduplicates concurrent submissions before starting one proposal Run', async () => {
    const runner = new ImpactRunner(proposal());
    const fixture = await setup(runner);
    const requestId = randomUUID();
    const [left, right] = await Promise.all([
      fixture.impact.submit(fixture.agent.id, 'Add backend API tests', requestId),
      fixture.impact.submit(fixture.agent.id, 'Add backend API tests', requestId),
    ]);
    expect(left.admission.id).toBe(right.admission.id);
    expect(left.message.id).toBe(right.message.id);
    await waitFor(() => fixture.impact.list(fixture.agent.id)[0]?.status === 'admitted');
    expect(fixture.store.snapshot().playgroundImpactAdmissions).toHaveLength(1);
    expect(runner.requests.filter((request) => request.accessMode === 'read_only')).toHaveLength(1);
  });

  it('resumes an existing ordinary thread for accepted nonvisual work', async () => {
    const runner = new CandidateBackendRunner(proposal());
    const fixture = await setup(runner);
    await fixture.store.mutate((database) => {
      database.agents[0]!.codexThreadId = 'ordinary-existing-thread';
    });
    await fixture.impact.submit(fixture.agent.id, 'Add backend coverage', randomUUID());
    await waitFor(() => fixture.impact.list(fixture.agent.id)[0]?.status === 'admitted');
    expect(runner.requests.find((request) => request.accessMode === 'write')!.threadId)
      .toBe('ordinary-existing-thread');
    expect(fixture.store.snapshot().agents[0]!.codexThreadId).toBe('ordinary-existing-thread');
  });

  it('invalidates a resumed thread when the candidate is rejected as frontend', async () => {
    const runner = new CandidateFrontendRunner(proposal());
    const fixture = await setup(runner);
    await fixture.store.mutate((database) => {
      database.agents[0]!.codexThreadId = 'ordinary-existing-thread';
    });
    await fixture.impact.submit(fixture.agent.id, 'Improve whatever code is needed', randomUUID());
    await waitFor(() => fixture.impact.list(fixture.agent.id)[0]?.status === 'promoted');
    expect(runner.requests.find((request) => request.accessMode === 'write')!.threadId)
      .toBe('ordinary-existing-thread');
    expect(fixture.store.snapshot().agents[0]!.codexThreadId).toBeNull();
    await expect(stat(path.join(fixture.agent.workspacePath, 'src', 'App.tsx'))).rejects.toThrow();
  });

  it('invalidates a resumed thread when publication fails before authoritative mutation', async () => {
    const runner = new CandidateBackendRunner(proposal());
    const fixture = await setup(runner);
    await fixture.store.mutate((database) => {
      database.agents[0]!.codexThreadId = 'ordinary-existing-thread';
    });
    vi.spyOn(fixture.workspaces, 'publishAgentWorkspace')
      .mockRejectedValueOnce(new Error('simulated pre-swap publication failure'));

    await fixture.impact.submit(fixture.agent.id, 'Add backend coverage', randomUUID());
    await waitFor(() => fixture.impact.list(fixture.agent.id)[0]?.status === 'failed');
    await expect(stat(path.join(fixture.agent.workspacePath, 'server', 'handler.test.ts'))).rejects.toThrow();
    expect(fixture.store.snapshot().agents[0]!.codexThreadId).toBeNull();
  });

  it('adopts the candidate thread after restart recovery proves the filesystem was published', async () => {
    const runner = new CandidateBackendRunner(proposal());
    const fixture = await setup(runner);
    await fixture.store.mutate((database) => {
      database.agents[0]!.codexThreadId = 'ordinary-existing-thread';
    });
    const originalMutate = fixture.store.mutate.bind(fixture.store);
    const originalPublish = fixture.workspaces.publishAgentWorkspace.bind(fixture.workspaces);
    let failNextMutation = false;
    vi.spyOn(fixture.store, 'mutate').mockImplementation(async (mutation) => {
      if (failNextMutation) {
        failNextMutation = false;
        throw new Error('simulated post-publication persistence failure');
      }
      return originalMutate(mutation);
    });
    vi.spyOn(fixture.workspaces, 'publishAgentWorkspace').mockImplementation(async (input) => {
      const receipt = await originalPublish(input);
      failNextMutation = true;
      return receipt;
    });

    await fixture.impact.submit(fixture.agent.id, 'Add backend coverage', randomUUID());
    await waitFor(() =>
      fixture.impact.list(fixture.agent.id)[0]?.status === 'publishing' &&
      fixture.store.snapshot().agents[0]?.status === 'error',
    );
    expect(fixture.store.snapshot().agents[0]!.codexThreadId).toBe('ordinary-existing-thread');

    await fixture.impact.reconcileStartup();
    expect(fixture.impact.list(fixture.agent.id)[0]!.status).toBe('admitted');
    expect(fixture.store.snapshot().agents[0]!.codexThreadId).toBe('ordinary-existing-thread');
  });

  it('resumes the same thread and sees prior publications on the next ordinary message', async () => {
    const runner = new SequencedBackendRunner(proposal());
    const fixture = await setup(runner);

    const first = await fixture.impact.submit(fixture.agent.id, 'Prompt A', randomUUID());
    await waitFor(() =>
      fixture.impact.list(fixture.agent.id).find((item) => item.id === first.admission.id)?.status === 'admitted',
    );
    expect(fixture.store.snapshot().agents[0]!.codexThreadId).toBe('ordinary-thread');
    expect(await readFile(path.join(fixture.agent.workspacePath, 'server', 'first.ts'), 'utf8'))
      .toContain('sequence = 1');

    const second = await fixture.impact.submit(fixture.agent.id, 'Prompt B', randomUUID());
    await waitFor(() =>
      fixture.impact.list(fixture.agent.id).find((item) => item.id === second.admission.id)?.status === 'admitted',
    );
    expect(runner.candidateSawPreviousPublication).toEqual([false, true]);
    expect(runner.requests.filter((request) => request.accessMode === 'write').map((request) => request.threadId))
      .toEqual([null, 'ordinary-thread']);
    expect(fixture.store.snapshot().agents[0]!.codexThreadId).toBe('ordinary-thread');
  });

  it('holds an actually ambiguous diff for confirmation and publishes the exact candidate without rerun', async () => {
    const runner = new CandidateAmbiguousRunner(proposal());
    const fixture = await setup(runner);
    const submitted = await fixture.impact.submit(
      fixture.agent.id,
      'Refactor implementation details',
      randomUUID(),
    );
    await waitFor(() => fixture.impact.list(fixture.agent.id)[0]?.status === 'confirmation_required');
    const pending = fixture.impact.list(fixture.agent.id)[0]!;
    expect(pending).toMatchObject({
      id: submitted.admission.id,
      decision: 'confirmation_required',
      allowNonvisualConfirmation: true,
      changedFiles: [{ path: 'src/helper.ts', operation: 'ADDED' }],
    });
    expect(runner.requests.filter((request) => request.accessMode === 'write')).toHaveLength(1);

    await fixture.impact.confirm(fixture.agent.id, pending.id, 'nonvisual');
    await waitFor(() => fixture.impact.list(fixture.agent.id)[0]?.status === 'admitted');
    expect(runner.requests.filter((request) => request.accessMode === 'write')).toHaveLength(1);
    expect(await readFile(path.join(fixture.agent.workspacePath, 'src', 'helper.ts'), 'utf8'))
      .toContain('value = 1');
  });

  it('pauses proposal-time uncertainty and admits it after eligible human confirmation', async () => {
    const runner = new ImpactRunner(proposal('high'));
    const fixture = await setup(runner);
    const submitted = await fixture.impact.submit(fixture.agent.id, 'Refactor server types', randomUUID());
    await waitFor(() => fixture.impact.list(fixture.agent.id)[0]?.status === 'confirmation_required');
    expect(fixture.impact.list(fixture.agent.id)[0]!.allowNonvisualConfirmation).toBe(true);
    await fixture.impact.confirm(fixture.agent.id, submitted.admission.id, 'nonvisual');
    await waitFor(() => fixture.impact.list(fixture.agent.id)[0]?.status === 'admitted');
    expect(runner.requests.map((request) => request.accessMode)).toEqual(['read_only', 'write']);
  });

  it('rejects proposal-time source mutation and never launches a writable Run', async () => {
    const runner = new ImpactRunner(proposal(), true);
    const fixture = await setup(runner);
    await fixture.impact.submit(fixture.agent.id, 'Add backend API tests', randomUUID());
    await waitFor(() => fixture.impact.list(fixture.agent.id)[0]?.status === 'stale');
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]!.accessMode).toBe('read_only');
  });

  it('promotes one exact clean checkpoint idempotently without changing an untouched Playground thread', async () => {
    const runner = new ImpactRunner(proposal());
    const fixture = await setup(runner);
    const workspaceHash = await fixture.workspaces.fingerprintAgentWorkspace(fixture.agent.id);
    const timestamp = fixture.store.snapshot().agents[0]!.updatedAt;
    const admissionId = randomUUID();
    const proposalRunId = randomUUID();
    const admission: PlaygroundImpactAdmission = {
      id: admissionId,
      requestId: randomUUID(),
      agentId: fixture.agent.id,
      prompt: 'Build a settings page',
      status: 'confirmation_required',
      decision: 'governed',
      allowNonvisualConfirmation: false,
      reason: 'frontend impact',
      proposal: null,
      workspaceHash,
      agentUpdatedAt: timestamp,
      threadId: null,
      proposalRunId,
      admittedRunId: null,
      missionId: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };
    await fixture.store.mutate((database) => {
      database.runs.push({
        id: proposalRunId,
        agentId: fixture.agent.id,
        status: 'completed',
        prompt: 'proposal',
        output: proposal(),
        error: null,
        usage: null,
        startedAt: timestamp,
        completedAt: timestamp,
        createdAt: timestamp,
        context: { kind: 'playground_impact', admissionId },
      });
      database.playgroundImpactAdmissions.push(admission);
    });
    const [left, right] = await Promise.all([
      fixture.missions.promotePlaygroundImpact(admissionId),
      fixture.missions.promotePlaygroundImpact(admissionId),
    ]);
    expect(left.id).toBe(right.id);
    expect(fixture.store.snapshot().missions).toHaveLength(1);
    expect(fixture.impact.list(fixture.agent.id)[0]).toMatchObject({
      status: 'promoted',
      missionId: left.id,
      workspaceHash,
      threadId: null,
    });
  });
});
