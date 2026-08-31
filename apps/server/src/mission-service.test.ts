import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentService } from './agent-service.js';
import { loadConfig } from './config.js';
import { MissionService } from './mission-service.js';
import { JsonStore } from './store.js';
import type { AgentRunner, RunnerPreflightRequest, RunnerReadinessResult, RunnerRequest, RunnerResult } from './types.js';
import { WorkspaceManager } from './workspace.js';
import { RunExecutionService } from './run-execution.js';

class NoCallRunner implements AgentRunner {
  calls = 0;
  requests: RunnerRequest[] = [];
  readiness: RunnerReadinessResult = { ok: true };
  async run(request: RunnerRequest): Promise<RunnerResult> { this.calls += 1; this.requests.push(request); return { output: 'unexpected', threadId: 'unexpected', usage: null }; }
  async preflight(_request: RunnerPreflightRequest): Promise<RunnerReadinessResult> { return this.readiness; }
  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}
class FailingProvisionWorkspace extends WorkspaceManager { override async createMissionWorkspace(): Promise<string> { throw Object.assign(new Error('host path must stay private'), { code: 'EACCES' }); } }
class FailingCleanupWorkspace extends FailingProvisionWorkspace { override async cleanupMissionProvisioning(): Promise<void> { throw new Error('cleanup failed'); } }
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(options: { workspace?: 'normal' | 'fail_provision' | 'fail_cleanup' } = {}) { const root = await mkdtemp(path.join(tmpdir(), 'conductor-mission-')); roots.push(root); const config = loadConfig({ NODE_ENV: 'test', APP_DATA_DIR: path.join(root, 'data'), AGENT_WORKSPACE_ROOT: path.join(root, 'workspaces'), CODEX_HOME: path.join(root, 'codex'), MODEL_API_KEY: 'test', MODEL_NAME: 'test' }); const store = new JsonStore(path.join(root, 'data', 'db.json')); const workspaces = options.workspace === 'fail_provision' ? new FailingProvisionWorkspace(config.workspaceRoot) : options.workspace === 'fail_cleanup' ? new FailingCleanupWorkspace(config.workspaceRoot) : new WorkspaceManager(config.workspaceRoot); const runner = new NoCallRunner(); const execution = new RunExecutionService(store, runner); const agents = new AgentService(config, store, workspaces, execution); await agents.initialize(); return { agents, missions: new MissionService(store, workspaces, execution), runner, workspaces, store, root, execution, config }; }

describe('Phase 07 Mission creation', () => {
  it('creates one role-deduplicated participant, one Design task, and a checkpoint without dispatch', async () => {
    const { agents, missions, runner, workspaces } = await setup(); const source = await agents.createAgent({ name: 'Source' }); const builder = await agents.createAgent({ name: 'Builder' });
    const mission = await missions.createMission({ goal: 'Build the requested interface', sourceAgentId: source.id, designerAgentId: source.id, builderAgentId: builder.id }); const detail = missions.getMission(mission.id);
    expect(mission.status).toBe('pending'); expect(mission.workflow.phase).toBe('designing'); expect(mission.participants.map((item) => item.agentId)).toEqual([source.id, builder.id]); expect(detail.tasks).toHaveLength(1); expect(detail.tasks[0]).toMatchObject({ stage: 'design', assignedAgentId: source.id, inputWorkspaceRevisionId: mission.workspace.currentRevisionId }); expect(detail.designRevisions).toEqual([]); expect(detail.verificationRuns).toEqual([]); expect(runner.calls).toBe(0); expect(await readFile(path.join(workspaces.missionWorkspacePath(mission.id), 'AGENTS.md'), 'utf8')).toContain('Conductor');
  });

  it('reserves every selected role and releases all reservations on safe cancellation', async () => {
    const { agents, missions } = await setup(); const source = await agents.createAgent({ name: 'Source' }); const designer = await agents.createAgent({ name: 'Designer' }); const builder = await agents.createAgent({ name: 'Builder' }); const mission = await missions.createMission({ goal: 'Reserve roles', sourceAgentId: source.id, designerAgentId: designer.id, builderAgentId: builder.id });
    await expect(agents.sendMessage(source.id, 'ordinary')).rejects.toMatchObject({ statusCode: 409 }); await missions.recover(mission.id, { requestId: crypto.randomUUID(), action: 'stop_preserve' }); expect(missions.getMission(mission.id).mission.status).toBe('cancelled');
    await expect(missions.createMission({ goal: 'reuse', sourceAgentId: source.id, designerAgentId: source.id, builderAgentId: source.id })).resolves.toBeTruthy();
  });

  it('requires an explicit start before spending model work', async () => {
    const { agents, missions, runner } = await setup(); const agent = await agents.createAgent({ name: 'Agent' }); const mission = await missions.createMission({ goal: 'No automatic start', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id });
    expect(runner.calls).toBe(0); expect(missions.getMission(mission.id).attempts).toHaveLength(0);
    await missions.startMission(mission.id); for (let index = 0; index < 100 && runner.calls === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); for (let index = 0; index < 100 && missions.getMission(mission.id).attempts[0]?.status === 'running'; index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); expect(runner.calls).toBe(1); expect(agents.getAgent(agent.id).codexThreadId).toBeNull();
  });

  it('duplicates intent through normal creation with a new identity, workspace, and history', async () => { const { agents, missions } = await setup(); const agent = await agents.createAgent({ name: 'Agent' }); const source = await missions.createMission({ goal: 'Reusable intent', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id, tokenBudget: 100 }); await missions.recover(source.id, { requestId: crypto.randomUUID(), action: 'stop_preserve' }); const before = missions.getMission(source.id); const duplicate = await missions.createMission({ goal: before.mission.goal, sourceAgentId: before.mission.workspace.source.agentId, designerAgentId: before.mission.workflow.designerAgentId, builderAgentId: before.mission.workflow.builderAgentId, tokenBudget: before.mission.tokenBudget }); const after = missions.getMission(source.id); const fresh = missions.getMission(duplicate.id); expect(duplicate.id).not.toBe(source.id); expect(duplicate.workspace.key).not.toBe(source.workspace.key); expect(after.events).toEqual(before.events); expect(fresh.tasks).toHaveLength(1); expect(fresh.attempts).toHaveLength(0); expect(fresh.designRevisions).toHaveLength(0); expect(fresh.events.every((event) => event.missionId === duplicate.id)).toBe(true); });

  it('compensates a provisioning failure without a ghost Mission or reservation', async () => {
    const { agents, missions, store } = await setup({ workspace: 'fail_provision' }); const agent = await agents.createAgent({ name: 'Reusable Agent' });
    await expect(missions.createMission({ goal: 'Will fail safely', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id })).rejects.toMatchObject({ statusCode: 500, message: expect.stringContaining('EACCES') });
    expect(store.snapshot().missions).toEqual([]); expect(store.snapshot().missionTasks).toEqual([]); expect(store.snapshot().missionEvents).toEqual([]);
    expect(missions.listAgentAvailability()).toContainEqual({ agentId: agent.id, availableForMission: true, reservingMissionId: null, reservingMissionGoal: null, reason: 'available' });
  });

  it('keeps an explicit unavailable tombstone when provisioning cleanup fails', async () => {
    const { agents, missions } = await setup({ workspace: 'fail_cleanup' }); const agent = await agents.createAgent({ name: 'Released Agent' });
    await expect(missions.createMission({ goal: 'Cleanup failure', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id })).rejects.toThrow('cleanup is incomplete');
    expect(missions.listMissions()[0]).toMatchObject({ status: 'failed', workspace: { state: 'unavailable' } });
    expect(missions.listAgentAvailability()[0]).toMatchObject({ availableForMission: true });
  });

  it('reconciles abandoned provisioning records but never removes a ready Mission', async () => {
    const failed = await setup({ workspace: 'fail_cleanup' }); const agent = await failed.agents.createAgent({ name: 'Agent' });
    await expect(failed.missions.createMission({ goal: 'Abandoned create', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id })).rejects.toBeTruthy();
    const reconciler = new MissionService(failed.store, new WorkspaceManager(failed.config.workspaceRoot), failed.execution); await reconciler.reconcileStartup(); expect(failed.store.snapshot().missions).toEqual([]);
    const healthy = await setup(); const readyAgent = await healthy.agents.createAgent({ name: 'Ready' }); const ready = await healthy.missions.createMission({ goal: 'Keep me', sourceAgentId: readyAgent.id, designerAgentId: readyAgent.id, builderAgentId: readyAgent.id }); await healthy.missions.reconcileStartup(); expect(healthy.missions.getMission(ready.id).mission.workspace.state).toBe('ready');
  });

  it('denies Runtime-unready Design before creating an attempt or spending a retry', async () => {
    const { agents, missions, runner } = await setup(); const agent = await agents.createAgent({ name: 'Agent' }); const mission = await missions.createMission({ goal: 'Preflight first', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id }); runner.readiness = { ok: false, category: 'runtime_config_unavailable', message: 'Runtime config unavailable' };
    await expect(missions.startMission(mission.id)).rejects.toMatchObject({ statusCode: 503, code: 'MISSION_RUNTIME_UNAVAILABLE' }); const detail = missions.getMission(mission.id); expect(detail.attempts).toHaveLength(0); expect(detail.tasks[0]).toMatchObject({ status: 'pending', authorityVersion: 0 }); expect(runner.calls).toBe(0);
  });

  it('records the current Design protocol exactly once while preserving stale task history', async () => {
    const { agents, missions, runner, store } = await setup(); const agent = await agents.createAgent({ name: 'Agent' }); const mission = await missions.createMission({ goal: 'Prompt lifecycle', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id }); const taskId = mission.currentTaskId!; const stale = 'Old durable Design instruction'; await store.mutate((database) => { database.missionTasks.find((task) => task.id === taskId)!.instruction = stale; });
    await missions.startMission(mission.id); for (let index = 0; index < 100 && runner.requests.length === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); const prompt = runner.requests[0]!.prompt; expect(prompt).toContain(stale); expect(prompt.match(/surface contract property as exact DesignContractV1 JSON embedded in design-bundle\.json/g)).toHaveLength(1); expect(prompt).toContain('Do not write a separate design-contract.json file'); expect(store.snapshot().missionTasks.find((task) => task.id === taskId)!.instruction).toBe(stale); expect(store.snapshot().runs.find((run) => run.context.kind === 'mission')!.prompt).toBe(prompt); for (let index = 0; index < 100 && missions.getMission(mission.id).attempts[0]?.status === 'running'; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it('copies source files but excludes generated, control, secret, and log paths', async () => {
    const { agents, missions, workspaces } = await setup(); const agent = await agents.createAgent({ name: 'Source' }); const source = workspaces.workspacePath(agent.id); await writeFile(path.join(source, 'package.json'), '{}'); await writeFile(path.join(source, 'package-lock.json'), '{}'); await mkdir(path.join(source, 'src')); await writeFile(path.join(source, 'src', 'index.ts'), 'export {};');
    for (const directory of ['node_modules', 'dist', '.git', '.codex', '.conductor']) { await mkdir(path.join(source, directory), { recursive: true }); await writeFile(path.join(source, directory, 'private.txt'), 'private'); } await writeFile(path.join(source, '.env'), 'SECRET=value'); await writeFile(path.join(source, '.env.local'), 'SECRET=value'); await writeFile(path.join(source, 'debug.log'), 'private');
    const mission = await missions.createMission({ goal: 'Seed safely', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id }); const target = workspaces.missionWorkspacePath(mission.id); await expect(access(path.join(target, 'src', 'index.ts'))).resolves.toBeUndefined(); await expect(access(path.join(target, 'package-lock.json'))).resolves.toBeUndefined();
    for (const relative of ['node_modules', 'dist', '.git', '.codex', '.conductor/private.txt', '.env', '.env.local', 'debug.log']) await expect(access(path.join(target, relative))).rejects.toBeTruthy(); expect(await readFile(path.join(target, 'AGENTS.md'), 'utf8')).toContain('Conductor Mission workspace');
  });
});
