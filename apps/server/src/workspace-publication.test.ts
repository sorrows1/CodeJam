import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishMissionWorkspaceDirectory } from './workspace.js';
import { WorkspacePublisher } from './workspace-publication.js';
import { inspectWorkspaceProjection } from './workspace-projection.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function filesystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: publication failed`), { code });
}

describe('Windows Mission workspace publication', () => {
  it('atomically replaces governed source while preserving Agent-only control and secret files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workspace-publisher-')); roots.push(root);
    const agentRoot = path.join(root, 'agents', 'agent'); const missionRoot = path.join(root, 'mission');
    await mkdir(path.join(agentRoot, '.conductor'), { recursive: true }); await mkdir(missionRoot, { recursive: true });
    await writeFile(path.join(agentRoot, 'old.txt'), 'old'); await writeFile(path.join(agentRoot, '.env'), 'SECRET=preserved'); await writeFile(path.join(agentRoot, 'AGENTS.md'), 'agent control'); await writeFile(path.join(agentRoot, '.conductor', 'state'), 'control');
    await writeFile(path.join(missionRoot, 'new.txt'), 'new'); await writeFile(path.join(missionRoot, 'AGENTS.md'), 'mission control');
    const expectedAgentHash = (await inspectWorkspaceProjection(agentRoot)).contentHash;
    const expectedPublishedHash = (await inspectWorkspaceProjection(missionRoot)).contentHash;
    const publisher = new WorkspacePublisher(path.join(root, 'agents'));
    const transactionId = '00000000-0000-4000-8000-000000000001';
    const receipt = await publisher.publish({ transactionId, sourceRoot: missionRoot, agentRoot, expectedAgentHash, expectedSourceHash: expectedPublishedHash });
    expect(receipt).toMatchObject({ previousHash: expectedAgentHash, publishedHash: expectedPublishedHash });
    expect(await readFile(path.join(agentRoot, 'new.txt'), 'utf8')).toBe('new');
    await expect(stat(path.join(agentRoot, 'old.txt'))).rejects.toThrow();
    expect(await readFile(path.join(agentRoot, '.env'), 'utf8')).toBe('SECRET=preserved');
    expect(await readFile(path.join(agentRoot, 'AGENTS.md'), 'utf8')).toBe('agent control');
    expect(await publisher.recover({ transactionId, agentRoot, expectedAgentHash, expectedPublishedHash })).toMatchObject({ state: 'published' });
    await publisher.finalize(transactionId);
  });

  it('rejects a source that no longer matches the authoritative revision before replacing the Agent workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workspace-publisher-source-')); roots.push(root);
    const agentRoot = path.join(root, 'agents', 'agent'); const missionRoot = path.join(root, 'mission');
    await mkdir(agentRoot, { recursive: true }); await mkdir(missionRoot, { recursive: true });
    await writeFile(path.join(agentRoot, 'old.txt'), 'old'); await writeFile(path.join(missionRoot, 'new.txt'), 'new');
    const expectedAgentHash = (await inspectWorkspaceProjection(agentRoot)).contentHash;
    const expectedSourceHash = (await inspectWorkspaceProjection(missionRoot)).contentHash;
    await writeFile(path.join(missionRoot, 'new.txt'), 'mutated after verification');

    const publisher = new WorkspacePublisher(path.join(root, 'agents'));
    await expect(publisher.publish({ transactionId: '00000000-0000-4000-8000-000000000002', sourceRoot: missionRoot, agentRoot, expectedAgentHash, expectedSourceHash })).rejects.toThrow('authoritative revision');
    expect(await readFile(path.join(agentRoot, 'old.txt'), 'utf8')).toBe('old');
    await expect(stat(path.join(agentRoot, 'new.txt'))).rejects.toThrow();
  });
  it('retries transient seeded-directory rename failures with bounded delays', async () => {
    const renameDirectory = vi.fn()
      .mockRejectedValueOnce(filesystemError('EPERM'))
      .mockRejectedValueOnce(filesystemError('EBUSY'))
      .mockResolvedValue(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);

    await publishMissionWorkspaceDirectory('mission.tmp', 'mission', { platform: 'win32', renameDirectory, wait });

    expect(renameDirectory).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[25], [50]]);
  });

  it('does not retry non-Windows or non-transient publication failures', async () => {
    const windowsRename = vi.fn().mockRejectedValue(filesystemError('ENOENT'));
    await expect(publishMissionWorkspaceDirectory('mission.tmp', 'mission', { platform: 'win32', renameDirectory: windowsRename })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(windowsRename).toHaveBeenCalledTimes(1);

    const linuxRename = vi.fn().mockRejectedValue(filesystemError('EPERM'));
    await expect(publishMissionWorkspaceDirectory('mission.tmp', 'mission', { platform: 'linux', renameDirectory: linuxRename })).rejects.toMatchObject({ code: 'EPERM' });
    expect(linuxRename).toHaveBeenCalledTimes(1);
  });

  it('stops after the bounded Windows retry budget and preserves the filesystem error', async () => {
    const error = filesystemError('EPERM');
    const renameDirectory = vi.fn().mockRejectedValue(error);
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(publishMissionWorkspaceDirectory('mission.tmp', 'mission', { platform: 'win32', renameDirectory, wait })).rejects.toBe(error);

    expect(renameDirectory).toHaveBeenCalledTimes(7);
    expect(wait.mock.calls.flat()).toEqual([25, 50, 100, 200, 400, 800]);
  });

  it('uses one verified-copy fallback only after the bounded Windows rename budget', async () => {
    const renameDirectory = vi.fn().mockRejectedValue(filesystemError('EPERM'));
    const wait = vi.fn().mockResolvedValue(undefined);
    const fallbackPublish = vi.fn().mockResolvedValue(undefined);

    await publishMissionWorkspaceDirectory('mission.tmp', 'mission', { platform: 'win32', renameDirectory, wait, fallbackPublish });

    expect(renameDirectory).toHaveBeenCalledTimes(7);
    expect(fallbackPublish).toHaveBeenCalledTimes(1);
  });
});
