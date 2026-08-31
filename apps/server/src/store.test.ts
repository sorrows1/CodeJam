import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDatabase, JsonStore, validateDatabase } from './store.js';
import type { Agent, AgentRun, Database, Mission, MissionArtifact, MissionTask, TaskAttempt } from './types.js';

const roots: string[] = [];
const time = '2026-01-01T00:00:00.000Z';
const agent = (id: string, status: Agent['status'] = 'ready'): Agent => ({ id, name: id, description: '', instructions: '', status, workspacePath: '/' + id, codexThreadId: 'thread-' + id, lastError: status === 'busy' ? 'interrupted' : null, createdAt: time, updatedAt: time });
const mission = (id: string, agentId: string, taskId: string): Mission => ({ id, goal: id, status: 'pending', participants: [{ agentId, order: 0, snapshot: { name: agentId, description: '', instructions: '', agentUpdatedAt: time } }], workflow: { phase: 'designing', designerAgentId: agentId, builderAgentId: agentId, latestDesignRevisionId: null, approvedDesignRevisionId: null, implementedWorkspaceRevisionId: null, currentVerificationRunId: null, repairCycle: 0, maxRepairCycles: 2 }, workspace: { owner: 'conductor', key: id, state: 'provisioning', source: { kind: 'agent_workspace', agentId, agentUpdatedAt: time, impactAdmissionId: null, contentHash: 'a'.repeat(64) }, currentRevisionId: null, revisionStatus: 'unversioned', nextRevisionSequence: 1 }, currentTaskId: taskId, nextEventSequence: 1, activeRecoveryCommandId: null, tokenBudget: null, createdAt: time, updatedAt: time, startedAt: null, completedAt: null });
const task = (missionId: string, id: string, agentId: string): MissionTask => ({ id, missionId, order: 0, stage: 'design', assignedAgentId: agentId, title: 'Design', instruction: 'Design', inputDesignRevisionId: null, inputVerificationRunId: null, inputWorkspaceRevisionId: null, repairCycle: null, status: 'pending', authoritativeAttemptId: null, authorityVersion: 0, inputArtifactIds: [], outputArtifactIds: [], outputWorkspaceRevisionId: null, createdAt: time, updatedAt: time, startedAt: null, completedAt: null });
const artifact = (id: string, missionId: string, taskId: string): MissionArtifact => ({ id, missionId, taskId, attemptId: null, kind: 'human_intervention', mediaType: 'text/plain', content: 'safe', storage: { kind: 'inline' }, sha256: createHash('sha256').update('safe').digest('hex'), workspaceRevisionId: null, createdBy: { kind: 'human', agentId: null }, originalByteLength: 4, truncated: false, createdAt: time });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('JsonStore v1', () => {
  it('initializes every current collection explicitly', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'conductor-v1-')); roots.push(root); const file = path.join(root, 'db.json'); const store = new JsonStore(file); await store.initialize();
    expect(store.snapshot()).toMatchObject({ version: 1, missions: [], missionTasks: [], taskAttempts: [], missionArtifacts: [], missionEvents: [], missionWorkspaceRevisions: [], missionRecoveryCommands: [], designRevisions: [], verificationRuns: [], playgroundImpactAdmissions: [], agentWorkspacePublications: [] });
  });

  it('loads an existing valid v1 database without rewriting it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'conductor-v1-reload-')); roots.push(root); const file = path.join(root, 'db.json'); const source = JSON.stringify(emptyDatabase()); await writeFile(file, source, 'utf8'); const store = new JsonStore(file); await store.initialize();
    expect(store.snapshot()).toEqual(emptyDatabase()); expect(await readFile(file, 'utf8')).toBe(source);
  });

  it('rejects incompatible input without overwriting source bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'conductor-invalid-')); roots.push(root); const file = path.join(root, 'db.json'); const raw = '{"version":5,"agents":[]}'; await writeFile(file, raw, 'utf8'); await expect(new JsonStore(file).initialize()).rejects.toThrow(/Unsupported/); expect(await readFile(file, 'utf8')).toBe(raw);
  });

  it('validates every mutation before publication', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'conductor-mutation-')); roots.push(root); const file = path.join(root, 'db.json'); const store = new JsonStore(file); await store.initialize();
    await expect(store.mutate((database) => database.agents.push(agent('a')))).resolves.toBe(1);
    await expect(store.mutate((database) => database.messages.push({ id: 'm', agentId: 'missing', runId: 'missing', role: 'user', content: 'bad', createdAt: time }))).rejects.toThrow(/references missing/);
    expect(store.snapshot().messages).toEqual([]); expect(JSON.parse(await readFile(file, 'utf8')).messages).toEqual([]);
    expect(() => validateDatabase(store.snapshot())).not.toThrow();
  });

  it('rejects cross-Mission task artifact ownership', () => {
    const database = emptyDatabase();
    database.agents.push(agent('a'), agent('b'));
    database.missions.push(mission('m1', 'a', 't1'), mission('m2', 'b', 't2'));
    database.missionTasks.push(task('m1', 't1', 'a'), task('m2', 't2', 'b'));
    database.missionArtifacts.push(artifact('artifact-2', 'm2', 't2'));
    database.missionTasks[0]!.outputArtifactIds.push('artifact-2');
    expect(() => validateDatabase(database)).toThrow(/artifact correlation mismatch/);
  });

  it('requires bidirectional TaskAttempt and Mission Run correlation and valid supersession references', () => {
    const database = emptyDatabase();
    database.agents.push(agent('a'), agent('b'));
    database.missions.push(mission('m1', 'a', 't1'));
    const missionTask = task('m1', 't1', 'a');
    missionTask.status = 'running'; missionTask.authorityVersion = 1; missionTask.authoritativeAttemptId = 'attempt-1';
    database.missionTasks.push(missionTask);
    const attempt: TaskAttempt = { id: 'attempt-1', missionId: 'm1', taskId: 't1', agentId: 'a', attemptNumber: 1, authorityVersion: 1, stage: 'design', inputDesignRevisionId: null, inputVerificationRunId: null, inputWorkspaceRevisionId: null, repairCycle: null, status: 'running', runId: 'run-1', runtimeThreadId: null, inputArtifactIds: [], outputArtifactId: null, outputWorkspaceRevisionId: null, usage: null, error: null, supersededAt: null, supersededByAttemptId: null, startedByRecoveryCommandId: null, createdAt: time, startedAt: time, completedAt: null, updatedAt: time };
    const run: AgentRun = { id: 'run-1', agentId: 'b', status: 'running', prompt: 'design', output: null, error: null, usage: null, startedAt: time, completedAt: null, createdAt: time, context: { kind: 'mission', missionId: 'm1', taskId: 't1', attemptId: 'attempt-1' } };
    database.taskAttempts.push(attempt); database.runs.push(run);
    expect(() => validateDatabase(database)).toThrow(/Run correlation mismatch|Mission correlation mismatch|superseded attempt/);
    run.agentId = 'a'; attempt.supersededByAttemptId = 'missing-attempt';
    expect(() => validateDatabase(database)).toThrow(/superseded attempt/);
  });

  it('redacts and bounds persisted event details and validates inline artifact hashes', () => {
    const database = emptyDatabase();
    database.agents.push(agent('a')); database.missions.push(mission('m1', 'a', 't1')); database.missionTasks.push(task('m1', 't1', 'a'));
    database.missions[0]!.nextEventSequence = 2;
    database.missionEvents.push({ id: 'event-1', missionId: 'm1', sequence: 1, type: 'mission_created', taskId: null, attemptId: null, agentId: null, actor: 'system', details: { API_KEY: 'secret', note: 'visible' }, createdAt: time });
    expect(() => validateDatabase(database)).not.toThrow();
    expect(database.missionEvents[0]!.details).toEqual({ API_KEY: '[REDACTED]', note: 'visible' });
    database.missionArtifacts.push(artifact('artifact-1', 'm1', 't1'));
    database.missionArtifacts[0]!.sha256 = '0'.repeat(64);
    expect(() => validateDatabase(database)).toThrow(/hash mismatch/);
  });
});
