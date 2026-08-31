import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentService } from './agent-service.js';
import { loadConfig } from './config.js';
import { FileDesignReferenceStore } from './file-design-reference-store.js';
import { MissionService } from './mission-service.js';
import { JsonStore } from './store.js';
import { RunExecutionService } from './run-execution.js';
import type { AgentRunner, RunnerRequest, RunnerResult } from './types.js';
import { WorkspaceManager } from './workspace.js';

const contract = JSON.stringify({ schemaVersion: 1, viewport: { width: 800, height: 600 }, requiredText: ['Hello'], requiredElements: [], interactions: [] });
class DesignerRunner implements AgentRunner {
  calls = 0;
  constructor(private readonly output: string | null = 'draft ready') {}
  async run(request: RunnerRequest): Promise<RunnerResult> { this.calls += 1; const draft = path.join(request.workspacePath, '.conductor', 'design-draft'); await mkdir(draft, { recursive: true }); await writeFile(path.join(draft, 'index.html'), '<main>Hello</main>'); await writeFile(path.join(draft, 'styles.css'), 'main { color: red; }'); await writeFile(path.join(draft, 'design-contract.json'), contract); return { output: this.output, threadId: 'mission-thread', usage: { outputTokens: 3 } }; }
  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

async function approveCurrentDesign(missions: MissionService, missionId: string, revisionId: string): Promise<void> {
  const reference = await missions.getDesignReference(missionId, revisionId);
  await missions.approveDesignRevision(missionId, revisionId, reference.surfaces.map((surface) => surface.id));
}

describe('DesignGovernanceService', () => {
  it('runs a Designer through the shared seam, restores the baseline, and pauses for approval', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'design-governance-'));
    try {
      const config = loadConfig({ NODE_ENV: 'test', APP_DATA_DIR: path.join(root, 'data'), AGENT_WORKSPACE_ROOT: path.join(root, 'workspaces'), CODEX_HOME: path.join(root, 'codex') }); const store = new JsonStore(path.join(root, 'data', 'db.json')); const workspaces = new WorkspaceManager(config.workspaceRoot); const runner = new DesignerRunner(null); const execution = new RunExecutionService(store, runner); const agents = new AgentService(config, store, workspaces, execution); await agents.initialize(); const references = new FileDesignReferenceStore(path.join(config.dataDirectory, 'design-references')); await references.initialize(); const missions = new MissionService(store, workspaces, execution, references); const designer = await agents.createAgent({ name: 'Designer' }); const mission = await missions.createMission({ goal: 'design', sourceAgentId: designer.id, designerAgentId: designer.id, builderAgentId: designer.id });
      await missions.startMission(mission.id);
      for (let index = 0; index < 400; index += 1) { if (missions.getMission(mission.id).mission.workflow.phase === 'awaiting_approval') break; await new Promise((resolve) => setTimeout(resolve, 5)); }
      const detail = missions.getMission(mission.id); expect(runner.calls).toBe(1); expect(detail.mission.workflow.phase).toBe('awaiting_approval'); expect(detail.mission.status).toBe('paused'); expect(detail.designRevisions).toHaveLength(1); expect(detail.attempts[0]?.runtimeThreadId).toBe('mission-thread'); expect(detail.mission.workflow.latestDesignRevisionId).toBe(detail.designRevisions[0]?.id); expect(store.snapshot().runs[0]?.output).toBeNull();
      await expect(missions.approveDesignRevision(mission.id, detail.designRevisions[0]!.id, undefined as never)).rejects.toMatchObject({ statusCode: 400 });
      await approveCurrentDesign(missions, mission.id, detail.designRevisions[0]!.id); const approved = missions.getMission(mission.id); expect(approved.designRevisions[0]?.status).toBe('approved'); expect(approved.mission.workflow.phase).toBe('implementing'); expect(approved.tasks.at(-1)?.stage).toBe('implement'); expect(approved.tasks.at(-1)?.status).toBe('pending'); expect(approved.attempts).toHaveLength(1); expect(runner.calls).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects an application write and restores the exact baseline', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'design-policy-'));
    try {
      const config = loadConfig({ NODE_ENV: 'test', APP_DATA_DIR: path.join(root, 'data'), AGENT_WORKSPACE_ROOT: path.join(root, 'workspaces'), CODEX_HOME: path.join(root, 'codex') }); const store = new JsonStore(path.join(root, 'data', 'db.json')); const workspaces = new WorkspaceManager(config.workspaceRoot); const runner: AgentRunner = { async run(request) { await writeFile(path.join(request.workspacePath, 'README.md'), 'tampered'); await writeFile(path.join(request.workspacePath, '.conductor', 'forbidden'), 'tampered'); return { output: '', threadId: null, usage: null }; }, async cancel() { return false; }, async isAvailable() { return true; } }; const execution = new RunExecutionService(store, runner); const agents = new AgentService(config, store, workspaces, execution); await agents.initialize(); const references = new FileDesignReferenceStore(path.join(config.dataDirectory, 'design-references')); const missions = new MissionService(store, workspaces, execution, references); const designer = await agents.createAgent({ name: 'Designer' }); const mission = await missions.createMission({ goal: 'policy', sourceAgentId: designer.id, designerAgentId: designer.id, builderAgentId: designer.id }); await missions.startMission(mission.id); for (let index = 0; index < 100 && missions.getMission(mission.id).attempts[0]?.status === 'running'; index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); const detail = missions.getMission(mission.id); expect(detail.designRevisions).toHaveLength(0); expect(detail.attempts[0]?.error?.message).toContain('design_write_policy_violation'); expect(await readFile(path.join(workspaces.missionWorkspacePath(mission.id), 'README.md'), 'utf8')).toContain('Designer workspace');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('creates an append-only feedback path and denies stale approval', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'design-feedback-'));
    try {
      const config = loadConfig({ NODE_ENV: 'test', APP_DATA_DIR: path.join(root, 'data'), AGENT_WORKSPACE_ROOT: path.join(root, 'workspaces'), CODEX_HOME: path.join(root, 'codex') }); const store = new JsonStore(path.join(root, 'data', 'db.json')); const workspaces = new WorkspaceManager(config.workspaceRoot); const runner: AgentRunner & { calls: number } = { calls: 0, async run(request) { runner.calls += 1; const draft = path.join(request.workspacePath, '.conductor', 'design-draft'); await mkdir(draft, { recursive: true }); await writeFile(path.join(draft, 'index.html'), '<main>Hello</main>'); await writeFile(path.join(draft, 'styles.css'), 'main{}'); await writeFile(path.join(draft, 'design-contract.json'), contract); return { output: '', threadId: null, usage: null }; }, async cancel() { return false; }, async isAvailable() { return true; } }; const execution = new RunExecutionService(store, runner); const agents = new AgentService(config, store, workspaces, execution); await agents.initialize(); const references = new FileDesignReferenceStore(path.join(config.dataDirectory, 'design-references')); const missions = new MissionService(store, workspaces, execution, references); const designer = await agents.createAgent({ name: 'Designer' }); const mission = await missions.createMission({ goal: 'feedback', sourceAgentId: designer.id, designerAgentId: designer.id, builderAgentId: designer.id }); await missions.startMission(mission.id); for (let index = 0; index < 100 && missions.getMission(mission.id).mission.workflow.phase !== 'awaiting_approval'; index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); const first = missions.getMission(mission.id); const firstId = first.designRevisions[0]!.id; await missions.submitDesignFeedback(mission.id, firstId, 'Make the heading clearer'); const revised = missions.getMission(mission.id); expect(revised.designRevisions[0]?.status).toBe('superseded'); expect(revised.mission.workflow.phase).toBe('designing'); expect(revised.tasks.at(-1)?.status).toBe('pending'); expect(revised.attempts).toHaveLength(1); await expect(missions.approveDesignRevision(mission.id, firstId, ['primary'])).rejects.toMatchObject({ statusCode: 409 }); await missions.startMission(mission.id); for (let index = 0; index < 100 && missions.getMission(mission.id).mission.workflow.phase !== 'awaiting_approval'; index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); const second = missions.getMission(mission.id); expect(second.designRevisions).toHaveLength(2); expect(second.designRevisions[1]?.parentRevisionId).toBe(firstId); expect(second.designRevisions[1]?.feedbackArtifactId).toBeTruthy(); expect(runner.calls).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
