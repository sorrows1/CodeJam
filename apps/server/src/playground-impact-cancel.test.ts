import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MissionService } from './mission-service.js';
import { PlaygroundImpactService } from './playground-impact-service.js';
import { RunExecutionService } from './run-execution.js';
import { JsonStore } from './store.js';
import type { Agent, AgentRunner, RunnerRequest, RunnerResult } from './types.js';
import { WorkspaceManager } from './workspace.js';

const roots: string[] = [];

class HardConflictRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(request);
    if (request.accessMode === 'read_only') {
      return {
        output: JSON.stringify({
          routes: ['/'],
          entrypoints: [],
          sharedLayouts: [],
          componentDependencies: [],
          predictedWritePaths: [],
          surfaces: [],
          effects: { visual: false, interaction: false, accessibility: false, display: false },
          evidence: ['Contradictory model proposal.'],
          uncertainty: 'low',
        }),
        threadId: 'proposal-thread',
        usage: null,
      };
    }
    throw new Error('A hard-conflict request must not start a writable candidate before confirmation.');
  }
  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

async function waitFor(read: () => boolean): Promise<void> {
  for (let index = 0; index < 200 && !read(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(read()).toBe(true);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Playground impact cancellation', () => {
  it('lets the user cancel a hard conflict without permitting unsafe non-UI continuation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'playground-cancel-'));
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
      codexThreadId: 'ordinary-existing-thread',
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    agent.workspacePath = workspaces.workspacePath(agent.id);
    await workspaces.create(agent);
    await store.mutate((database) => database.agents.push(agent));

    const runner = new HardConflictRunner();
    const execution = new RunExecutionService(store, runner);
    const missions = new MissionService(store, workspaces, execution);
    const impact = new PlaygroundImpactService(store, workspaces, execution, missions);

    const submitted = await impact.submit(agent.id, 'Refactor the code', randomUUID());
    await waitFor(() => impact.list(agent.id)[0]?.status === 'confirmation_required');
    const pending = impact.list(agent.id)[0]!;
    expect(pending).toMatchObject({
      id: submitted.admission.id,
      decision: 'confirmation_required',
      allowNonvisualConfirmation: false,
    });
    expect(runner.requests).toHaveLength(1);

    await expect(impact.confirm(agent.id, pending.id, 'nonvisual')).rejects.toMatchObject({ statusCode: 409 });
    const cancelled = await impact.confirm(agent.id, pending.id, 'cancel');
    expect(cancelled).toMatchObject({ status: 'failed', error: null });
    expect(cancelled.reason).toContain('cancelled');
    expect(store.snapshot().agents[0]).toMatchObject({
      status: 'ready',
      codexThreadId: 'ordinary-existing-thread',
    });
    expect(store.snapshot().missions).toHaveLength(0);
    expect(runner.requests).toHaveLength(1);
  });
});
