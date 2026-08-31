import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceManager } from './workspace.js';
import type { MissionWorkspaceRevision } from './types.js';

describe('immutable revision comparison', () => {
  it('returns bounded path-only changes and redacts transient or secret paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'conductor-diff-'));
    const manager = new WorkspaceManager(root); await manager.initialize();
    const missionId = '00000000-0000-4000-8000-000000000001'; await manager.createMissionWorkspace(missionId);
    const revision = (id: string, sequence: number): Omit<MissionWorkspaceRevision, 'snapshotKey' | 'contentHash'> => ({ id, missionId, sequence, parentRevisionId: null, restoredFromRevisionId: null, origin: 'task_success', boundaries: [], taskId: null, attemptId: null, interventionArtifactId: null, createdBy: 'agent', createdAt: new Date(sequence).toISOString() });
    const first = await manager.captureMissionRevision({ missionId, revision: revision('00000000-0000-4000-8000-000000000011', 1) });
    const workspace = manager.missionWorkspacePath(missionId); await writeFile(path.join(workspace, 'index.html'), 'hello'); await writeFile(path.join(workspace, '.env'), 'SECRET=x'); await mkdir(path.join(workspace, 'dist')); await writeFile(path.join(workspace, 'dist', 'bundle.js'), 'ignored');
    const second = await manager.captureMissionRevision({ missionId, revision: revision('00000000-0000-4000-8000-000000000012', 2) });
    expect(await manager.compareRevisions(missionId, first, second)).toEqual({ files: [{ path: 'index.html', operation: 'ADDED' }], truncated: false });
    await expect(manager.compareRevisions('00000000-0000-4000-8000-000000000099', first, second)).rejects.toThrow('ownership');
  });

  it('streams within hard file/tree bounds and fails closed before unbounded history reads', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'conductor-diff-bounds-')); const manager = new WorkspaceManager(root); await manager.initialize(); const missionId = '00000000-0000-4000-8000-000000000021'; await manager.createMissionWorkspace(missionId);
    const revision = (id: string, sequence: number): Omit<MissionWorkspaceRevision, 'snapshotKey' | 'contentHash'> => ({ id, missionId, sequence, parentRevisionId: null, restoredFromRevisionId: null, origin: 'task_success', boundaries: [], taskId: null, attemptId: null, interventionArtifactId: null, createdBy: 'agent', createdAt: new Date(sequence).toISOString() });
    const first = await manager.captureMissionRevision({ missionId, revision: revision('00000000-0000-4000-8000-000000000022', 1) }); const workspace = manager.missionWorkspacePath(missionId);
    await writeFile(path.join(workspace, 'large.bin'), Buffer.alloc(2 * 1024 * 1024 + 1)); const large = await manager.captureMissionRevision({ missionId, revision: revision('00000000-0000-4000-8000-000000000023', 2) });
    await expect(manager.compareRevisions(missionId, first, large)).rejects.toThrow('content bound');
    await writeFile(path.join(workspace, 'large.bin'), 'small'); await mkdir(path.join(workspace, 'many')); await Promise.all(Array.from({ length: 513 }, (_, index) => writeFile(path.join(workspace, 'many', `${index}.txt`), 'x'))); const tree = await manager.captureMissionRevision({ missionId, revision: revision('00000000-0000-4000-8000-000000000024', 3) });
    await expect(manager.compareRevisions(missionId, first, tree)).rejects.toThrow('content bound');
  });

  it('drops sensitive configured filenames and reports path truncation truthfully', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'conductor-diff-redaction-')); const manager = new WorkspaceManager(root); await manager.initialize(); const missionId = '00000000-0000-4000-8000-000000000031'; await manager.createMissionWorkspace(missionId);
    const revision = (id: string, sequence: number): Omit<MissionWorkspaceRevision, 'snapshotKey' | 'contentHash'> => ({ id, missionId, sequence, parentRevisionId: null, restoredFromRevisionId: null, origin: 'task_success', boundaries: [], taskId: null, attemptId: null, interventionArtifactId: null, createdBy: 'agent', createdAt: new Date(sequence).toISOString() });
    const first = await manager.captureMissionRevision({ missionId, revision: revision('00000000-0000-4000-8000-000000000032', 1) }); const workspace = manager.missionWorkspacePath(missionId); await mkdir(path.join(workspace, 'src')); const configuredSecret = 'opaque-demo-credential';
    await writeFile(path.join(workspace, 'src', `${configuredSecret}.ts`), 'private'); await writeFile(path.join(workspace, '.npmrc'), 'private'); await mkdir(path.join(workspace, '.conductor')); await writeFile(path.join(workspace, '.conductor', 'control.json'), 'private'); await Promise.all(Array.from({ length: 129 }, (_, index) => writeFile(path.join(workspace, 'src', `safe-${String(index).padStart(3, '0')}.ts`), 'x')));
    const second = await manager.captureMissionRevision({ missionId, revision: revision('00000000-0000-4000-8000-000000000033', 2) }); const comparison = await manager.compareRevisions(missionId, first, second, [configuredSecret]);
    expect(comparison.files).toHaveLength(128); expect(comparison.truncated).toBe(true); expect(JSON.stringify(comparison)).not.toContain(configuredSecret); expect(JSON.stringify(comparison)).not.toContain('.npmrc'); expect(JSON.stringify(comparison)).not.toContain('.conductor');
  });
});
