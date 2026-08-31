import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceManager } from './workspace.js';

const roots: string[] = [];
const missionId = '00000000-0000-4000-8000-000000000001';
const revisionId = '00000000-0000-4000-8000-000000000002';

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('Mission workspace checkpoint integrity', () => {
  it('rejects symlinks during immutable capture', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workspace-integrity-')); roots.push(root); const workspaces = new WorkspaceManager(root); await workspaces.initialize(); await workspaces.createMissionWorkspace(missionId);
    try { await symlink('AGENTS.md', path.join(workspaces.missionWorkspacePath(missionId), 'linked-agents.md')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; }
    await expect(workspaces.captureMissionRevision({ missionId, revision: { id: revisionId, missionId, sequence: 1, parentRevisionId: null, restoredFromRevisionId: null, origin: 'mission_start', boundaries: [{ kind: 'before_task', taskId: null }], taskId: null, attemptId: null, interventionArtifactId: null, createdBy: 'system', createdAt: new Date().toISOString() } })).rejects.toThrow('non-regular');
  });

  it('prunes runtime dependency trees but preserves source lockfiles during immutable capture', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workspace-integrity-')); roots.push(root); const workspaces = new WorkspaceManager(root); await workspaces.initialize(); await workspaces.createMissionWorkspace(missionId);
    const workspace = workspaces.missionWorkspacePath(missionId);
    await writeFile(path.join(workspace, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');
    await mkdir(path.join(workspace, 'node_modules', '.bin'), { recursive: true });
    try { await symlink('../esbuild/bin/esbuild', path.join(workspace, 'node_modules', '.bin', 'esbuild')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') await writeFile(path.join(workspace, 'node_modules', '.bin', 'esbuild'), 'runtime shim', 'utf8'); else throw error; }
    await mkdir(path.join(workspace, 'dist'), { recursive: true });
    await writeFile(path.join(workspace, 'dist', 'bundle.js'), 'generated output', 'utf8');

    const revision = await workspaces.captureMissionRevision({ missionId, revision: { id: revisionId, missionId, sequence: 1, parentRevisionId: null, restoredFromRevisionId: null, origin: 'task_success', boundaries: [{ kind: 'after_task', taskId: null }], taskId: null, attemptId: null, interventionArtifactId: null, createdBy: 'agent', createdAt: new Date().toISOString() } });
    const checkpoint = await workspaces.resolveMissionRevision(missionId, revision);

    expect(await readFile(path.join(checkpoint, 'package-lock.json'), 'utf8')).toContain('lockfileVersion');
    await expect(access(path.join(workspace, 'node_modules'))).rejects.toThrow();
    await expect(access(path.join(checkpoint, 'node_modules'))).rejects.toThrow();
    await expect(access(path.join(checkpoint, 'dist'))).rejects.toThrow();
  });

  it('binds restore to the immutable checkpoint hash rather than a mutable copy', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workspace-integrity-')); roots.push(root); const workspaces = new WorkspaceManager(root); await workspaces.initialize(); await workspaces.createMissionWorkspace(missionId);
    const revision = await workspaces.captureMissionRevision({ missionId, revision: { id: revisionId, missionId, sequence: 1, parentRevisionId: null, restoredFromRevisionId: null, origin: 'mission_start', boundaries: [{ kind: 'before_task', taskId: null }], taskId: null, attemptId: null, interventionArtifactId: null, createdBy: 'system', createdAt: new Date().toISOString() } });
    const checkpointFile = path.join(root, '.mission-checkpoints', missionId, revision.snapshotKey, 'AGENTS.md'); await writeFile(checkpointFile, `${await readFile(checkpointFile, 'utf8')}tampered`, 'utf8');
    await expect(workspaces.restoreMissionRevision(missionId, revision)).rejects.toThrow('checkpoint hash');
  });
});