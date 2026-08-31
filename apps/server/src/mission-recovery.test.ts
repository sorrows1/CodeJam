import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentService } from './agent-service.js';
import { loadConfig } from './config.js';
import { MissionService } from './mission-service.js';
import { JsonStore } from './store.js';
import type { AgentRunner, MissionRecoveryCommand, RunnerRequest, RunnerResult } from './types.js';
import { WorkspaceManager } from './workspace.js';
import { RunExecutionService } from './run-execution.js';

class Runner implements AgentRunner { calls = 0; async run(_request: RunnerRequest): Promise<RunnerResult> { this.calls += 1; return { output: 'not dispatched', threadId: null, usage: null }; } async cancel(): Promise<boolean> { return false; } async isAvailable(): Promise<boolean> { return true; } }
class RestartInterruptedRunner extends Runner {
  private releaseFirstRun!: () => void;
  private readonly firstRun = new Promise<void>((resolve) => { this.releaseFirstRun = resolve; });
  async run(request: RunnerRequest): Promise<RunnerResult> { this.calls += 1; if (this.calls === 1) { await this.firstRun; const draft = path.join(request.workspacePath, '.conductor', 'design-draft'); await mkdir(draft, { recursive: true }); await writeFile(path.join(draft, 'index.html'), '<main>late result</main>'); await writeFile(path.join(draft, 'styles.css'), 'main{}'); await writeFile(path.join(draft, 'design-contract.json'), JSON.stringify({ schemaVersion: 1, viewport: { width: 800, height: 600 }, requiredText: ['late result'], requiredElements: [], interactions: [] })); } return { output: 'not dispatched', threadId: null, usage: null }; }
  release(): void { this.releaseFirstRun(); }
}
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(runner: Runner = new Runner()) { const root = await mkdtemp(path.join(tmpdir(), 'conductor-recovery-')); roots.push(root); const config = loadConfig({ NODE_ENV: 'test', APP_DATA_DIR: path.join(root, 'data'), AGENT_WORKSPACE_ROOT: path.join(root, 'workspaces'), CODEX_HOME: path.join(root, 'codex') }); const store = new JsonStore(path.join(root, 'data', 'db.json')); const workspaces = new WorkspaceManager(config.workspaceRoot); const execution = new RunExecutionService(store, runner); const agents = new AgentService(config, store, workspaces, execution); await agents.initialize(); return { agents, missions: new MissionService(store, workspaces, execution), runner, store }; }
async function waitFor(read: () => boolean): Promise<void> { for (let index = 0; index < 300 && !read(); index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); expect(read()).toBe(true); }

describe('Phase 07 recovery boundary', () => {
  it('keeps pending design work safe to stop and releases reservations', async () => { const { agents, missions } = await setup(); const agent = await agents.createAgent({ name: 'Designer' }); const mission = await missions.createMission({ goal: 'stop safely', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id }); const result = await missions.recover(mission.id, { requestId: crypto.randomUUID(), action: 'stop_preserve' }); expect(result.command.status).toBe('completed'); expect(result.detail.mission.status).toBe('cancelled'); expect(result.detail.tasks[0]?.status).toBe('cancelled'); await expect(missions.createMission({ goal: 'reuse', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id })).resolves.toBeTruthy(); });
  it('returns typed unavailability for all stage recovery actions without Runner calls', async () => { const { agents, missions, runner } = await setup(); const agent = await agents.createAgent({ name: 'Designer' }); const mission = await missions.createMission({ goal: 'no stage recovery', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id }); await expect(missions.recover(mission.id, { requestId: crypto.randomUUID(), action: 'resume', taskId: mission.currentTaskId! })).rejects.toMatchObject({ code: 'MISSION_STAGE_UNAVAILABLE' }); expect(runner.calls).toBe(0); });
  it('reconciles active persisted work without restarting a Runner', async () => { const { agents, missions, runner } = await setup(); const agent = await agents.createAgent({ name: 'Designer' }); const mission = await missions.createMission({ goal: 'reconcile', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id }); await missions.reconcileStartup(); expect(missions.getMission(mission.id).mission.status).toBe('pending'); expect(runner.calls).toBe(0); });
  it('finalizes a stop command left applying after Mission terminalization', async () => { const { agents, missions, store } = await setup(); const agent = await agents.createAgent({ name: 'Designer' }); const mission = await missions.createMission({ goal: 'recover command', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id }); const command: MissionRecoveryCommand = { id: crypto.randomUUID(), missionId: mission.id, kind: 'stop_preserve', taskId: null, revisionId: null, payloadHash: 'payload', status: 'applying', resultAttemptId: null, resultRevisionId: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null }; await store.mutate((database) => { const stored = database.missions.find((item) => item.id === mission.id)!; database.missionRecoveryCommands.push(command); stored.activeRecoveryCommandId = command.id; stored.status = 'cancelled'; stored.completedAt = command.createdAt; }); await missions.reconcileStartup(); const snapshot = store.snapshot(); expect(snapshot.missionRecoveryCommands[0]).toMatchObject({ status: 'completed', completedAt: expect.any(String) }); expect(snapshot.missions[0]?.activeRecoveryCommandId).toBeNull(); expect(snapshot.missionEvents.some((event) => event.type === 'recovery_completed')).toBe(true); });
  it('retries a failed current Design once with exact bindings and durable idempotent attribution', async () => { const { agents, missions, runner } = await setup(); const agent = await agents.createAgent({ name: 'Designer' }); const mission = await missions.createMission({ goal: 'retry invalid design', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id }); await missions.startMission(mission.id); await waitFor(() => missions.getMission(mission.id).attempts[0]?.status === 'failed'); const failed = missions.getMission(mission.id); expect(failed.recovery.retryCurrentDesign.allowed).toBe(true); const oldAttempt = failed.attempts[0]!; const task = failed.tasks[0]!; const request = { requestId: crypto.randomUUID(), action: 'retry_current' as const, taskId: task.id }; const first = await missions.recover(mission.id, request); expect(first.command.resultAttemptId).toBeTruthy(); const second = await missions.recover(mission.id, request); expect(second.command.id).toBe(first.command.id); expect(second.command.resultAttemptId).toBe(first.command.resultAttemptId); await waitFor(() => missions.getMission(mission.id).attempts.some((item) => item.id === first.command.resultAttemptId && item.status === 'failed')); const retried = missions.getMission(mission.id); const nextAttempt = retried.attempts.find((item) => item.id === first.command.resultAttemptId)!; expect(nextAttempt).toMatchObject({ attemptNumber: 2, taskId: task.id, inputWorkspaceRevisionId: oldAttempt.inputWorkspaceRevisionId, startedByRecoveryCommandId: request.requestId }); expect(retried.attempts.find((item) => item.id === oldAttempt.id)).toMatchObject({ status: 'failed', supersededAt: expect.any(String), supersededByAttemptId: nextAttempt.id }); expect(runner.calls).toBe(2); });
  it('exposes and safely retries a startup-interrupted Design attempt from its exact checkpoint', async () => { const interruptedRunner = new RestartInterruptedRunner(); const { agents, missions, runner } = await setup(interruptedRunner); const agent = await agents.createAgent({ name: 'Designer' }); const mission = await missions.createMission({ goal: 'retry after restart', sourceAgentId: agent.id, designerAgentId: agent.id, builderAgentId: agent.id }); await missions.startMission(mission.id); await waitFor(() => missions.getMission(mission.id).attempts[0]?.status === 'running'); const beforeRestart = missions.getMission(mission.id); const oldAttempt = beforeRestart.attempts[0]!; const task = beforeRestart.tasks[0]!; const inputRevisionId = task.inputWorkspaceRevisionId!;
    await missions.reconcileStartup();
    const recovered = missions.getMission(mission.id);
    expect(recovered.mission.status).toBe('recovered_paused');
    expect(recovered.tasks[0]).toMatchObject({ id: task.id, status: 'interrupted', authoritativeAttemptId: null, inputWorkspaceRevisionId: inputRevisionId });
    expect(recovered.attempts.find((item) => item.id === oldAttempt.id)).toMatchObject({ status: 'interrupted', inputWorkspaceRevisionId: inputRevisionId, supersededAt: expect.any(String) });
    expect(recovered.recovery.retryCurrentDesign).toMatchObject({ allowed: true, taskId: task.id, attemptId: oldAttempt.id, inputWorkspaceRevisionId: inputRevisionId });
    await expect(missions.startMission(mission.id)).rejects.toMatchObject({ code: 'MISSION_STAGE_UNAVAILABLE' });
    expect(runner.calls).toBe(1);

    const request = { requestId: crypto.randomUUID(), action: 'retry_current' as const, taskId: task.id };
    const first = await missions.recover(mission.id, request);
    const replay = await missions.recover(mission.id, request);
    expect(replay.command.id).toBe(first.command.id);
    expect(replay.command.resultAttemptId).toBe(first.command.resultAttemptId);
    await waitFor(() => missions.getMission(mission.id).attempts.some((item) => item.id === first.command.resultAttemptId && item.status === 'failed'));
    const retried = missions.getMission(mission.id);
    const nextAttempt = retried.attempts.find((item) => item.id === first.command.resultAttemptId)!;
    expect(nextAttempt).toMatchObject({ attemptNumber: 2, taskId: task.id, agentId: oldAttempt.agentId, stage: 'design', inputWorkspaceRevisionId: inputRevisionId, startedByRecoveryCommandId: request.requestId });
    expect(retried.attempts.filter((item) => item.taskId === task.id)).toHaveLength(2);
    expect(retried.attempts.find((item) => item.id === oldAttempt.id)).toMatchObject({ status: 'interrupted', supersededByAttemptId: nextAttempt.id });
    expect(retried.workspaceInspection).toMatchObject({ state: 'clean', currentRevisionId: inputRevisionId });
    expect(retried.designRevisions).toHaveLength(0);
    expect(runner.calls).toBe(2);
    interruptedRunner.release();
    await waitFor(() => missions.getMission(mission.id).events.some((event) => event.type === 'attempt_result_discarded' && event.attemptId === oldAttempt.id));
    const afterLateResult = missions.getMission(mission.id);
    expect(afterLateResult.designRevisions).toHaveLength(0);
    expect(afterLateResult.attempts.find((item) => item.id === oldAttempt.id)).toMatchObject({ status: 'interrupted', supersededByAttemptId: nextAttempt.id });
  });
});
