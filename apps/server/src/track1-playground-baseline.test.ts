import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MissionService } from './mission-service.js';
import { PlaygroundImpactService } from './playground-impact-service.js';
import { RunExecutionService } from './run-execution.js';
import { JsonStore } from './store.js';
import type { Agent, AgentRunner, RunnerRequest, RunnerResult } from './types.js';
import { WorkspaceManager } from './workspace.js';

const TRACK_PROMPT = 'Create a TypeScript hello-world CLI, add a test, run it, and summarize the files you created.';
const roots: string[] = [];
const planningOutput = JSON.stringify({
  routes: [],
  entrypoints: [],
  sharedLayouts: [],
  componentDependencies: [],
  predictedWritePaths: [],
  surfaces: [],
  effects: { visual: false, interaction: false, accessibility: false, display: false },
  evidence: ['The request is a command-line program with no user-facing application surface.'],
  uncertainty: 'low',
});

class TrackBaselineRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];
  readonly sawPublishedCliBeforeFollowup: boolean[] = [];
  private writeCount = 0;

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(request);
    if (request.accessMode === 'read_only') {
      return {
        output: planningOutput,
        threadId: `proposal-${this.requests.length}`,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }

    const src = path.join(request.workspacePath, 'src');
    await mkdir(src, { recursive: true });
    if (this.writeCount === 0) {
      await writeFile(
        path.join(request.workspacePath, 'package.json'),
        JSON.stringify({
          name: 'hello-cli',
          private: true,
          type: 'module',
          bin: { hello: './dist/index.js' },
          scripts: { test: 'node --test dist/index.test.js' },
          devDependencies: { typescript: '^5.9.3' },
        }, null, 2),
      );
      await writeFile(path.join(src, 'index.ts'), "export const greeting = 'hello world';\nconsole.log(greeting);\n");
      await writeFile(
        path.join(src, 'index.test.ts'),
        "import { strict as assert } from 'node:assert';\nimport { greeting } from './index.js';\nassert.equal(greeting, 'hello world');\n",
      );
    } else {
      this.sawPublishedCliBeforeFollowup.push(
        await stat(path.join(src, 'index.ts')).then(() => true).catch(() => false),
      );
      await writeFile(
        path.join(src, 'index.ts'),
        "export const greeting = 'hello world again';\nconsole.log(greeting);\n",
      );
    }
    this.writeCount += 1;

    return {
      output: this.writeCount === 1 ? 'Created the TypeScript CLI and test.' : 'Updated the CLI in the same session.',
      threadId: request.threadId ?? 'track-codex-session',
      usage: { inputTokens: 2, outputTokens: 2 },
    };
  }

  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

async function waitFor(read: () => boolean): Promise<void> {
  for (let index = 0; index < 300 && !read(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(read()).toBe(true);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Track 1 ordinary Playground baseline', () => {
  it('publishes the exact CLI prompt, continues the same Codex session, and keeps the workspace after reopening state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'track1-playground-'));
    roots.push(root);
    const dataPath = path.join(root, 'data.json');
    const workspaceRoot = path.join(root, 'workspaces');
    const store = new JsonStore(dataPath);
    await store.initialize();
    const workspaces = new WorkspaceManager(workspaceRoot);
    await workspaces.initialize();

    const timestamp = new Date().toISOString();
    const agent: Agent = {
      id: randomUUID(),
      name: 'Track Baseline',
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

    const runner = new TrackBaselineRunner();
    const execution = new RunExecutionService(store, runner);
    const missions = new MissionService(store, workspaces, execution);
    const impact = new PlaygroundImpactService(store, workspaces, execution, missions);

    const first = await impact.submit(agent.id, TRACK_PROMPT, randomUUID());
    await waitFor(() => impact.list(agent.id).find((item) => item.id === first.admission.id)?.status === 'admitted');

    const firstAdmission = impact.list(agent.id).find((item) => item.id === first.admission.id)!;
    expect(firstAdmission).toMatchObject({ decision: 'nonvisual', missionId: null, status: 'admitted' });
    expect(firstAdmission.changedFiles?.map((item) => item.path).sort()).toEqual([
      'package.json',
      'src/index.test.ts',
      'src/index.ts',
    ]);
    expect(store.snapshot().agents[0]!.codexThreadId).toBe('track-codex-session');
    expect(await readFile(path.join(agent.workspacePath, 'src', 'index.ts'), 'utf8')).toContain('hello world');
    expect(store.snapshot().missions).toHaveLength(0);

    const followup = await impact.submit(
      agent.id,
      'Update the CLI greeting while keeping the existing test structure.',
      randomUUID(),
    );
    await waitFor(() => impact.list(agent.id).find((item) => item.id === followup.admission.id)?.status === 'admitted');

    const writeRequests = runner.requests.filter((request) => request.accessMode === 'write');
    expect(writeRequests).toHaveLength(2);
    expect(writeRequests[0]!.threadId).toBeNull();
    expect(writeRequests[1]!.threadId).toBe('track-codex-session');
    expect(runner.sawPublishedCliBeforeFollowup).toEqual([true]);
    expect(store.snapshot().agents[0]!.codexThreadId).toBe('track-codex-session');
    expect(store.snapshot().missions).toHaveLength(0);

    const reopenedStore = new JsonStore(dataPath);
    await reopenedStore.initialize();
    const reopenedWorkspaces = new WorkspaceManager(workspaceRoot);
    await reopenedWorkspaces.initialize();
    expect(reopenedStore.snapshot().agents.find((item) => item.id === agent.id)?.codexThreadId)
      .toBe('track-codex-session');
    expect(await readFile(path.join(reopenedWorkspaces.workspacePath(agent.id), 'src', 'index.ts'), 'utf8'))
      .toContain('hello world again');
    expect(await readFile(path.join(reopenedWorkspaces.workspacePath(agent.id), 'src', 'index.test.ts'), 'utf8'))
      .toContain('assert.equal');
  });
});
