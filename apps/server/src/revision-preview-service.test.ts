import { mkdtemp, mkdir, lstat, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContainerRevisionPreviewRuntime, RevisionPreviewService, type PreviewEngineProcess, type PreviewRuntime } from './revision-preview-service.js';
import type { JsonStore } from './store.js';
import type { MissionWorkspacePort } from './workspace.js';
import type { DesignReferenceStore } from './design-reference-store.js';

const missionId = '00000000-0000-4000-8000-000000000001';
const revisionId = '00000000-0000-4000-8000-000000000002';
const agentId = '00000000-0000-4000-8000-000000000009';
const database = { missions: [{ id: missionId }], missionWorkspaceRevisions: [{ id: revisionId, missionId }], designRevisions: [], missionArtifacts: [] };
const store = { snapshot: () => structuredClone(database) } as unknown as JsonStore;
const references = {} as DesignReferenceStore;

describe('RevisionPreviewService', () => {
  it('previews a stable ready Agent workspace without granting source writes', async () => {
    const source = await mkdtemp(path.join(tmpdir(), 'agent-preview-source-')); await writeFile(path.join(source, 'index.html'), '<main>current app</main>');
    const root = await mkdtemp(path.join(tmpdir(), 'agent-preview-root-'));
    const localStore = { snapshot: () => ({ agents: [{ id: agentId, status: 'ready' }], missions: [], playgroundImpactAdmissions: [] }) } as unknown as JsonStore;
    const workspaces = { workspacePath: (id: string) => { if (id !== agentId) throw new Error('wrong Agent'); return source; }, fingerprintAgentWorkspace: async () => 'a'.repeat(64) } as MissionWorkspacePort;
    const service = new RevisionPreviewService(localStore, workspaces, references, { async prepare() { throw new Error('not used'); } }, root); await service.initialize();
    const created = await service.createAgent(agentId);
    expect(created.session.target).toEqual({ kind: 'agent', workspaceHash: 'a'.repeat(64) });
    expect(created.session.contentPath).toContain(`/api/agents/${agentId}/previews/`);
    expect((await service.asset(agentId, created.session.id, created.token, 'index.html')).bytes.toString()).toContain('current app');
    await service.stop(agentId, created.session.id);
  });

  it('serves only an exact immutable static checkpoint with scoped authentication and stop', async () => {
    const source = await mkdtemp(path.join(tmpdir(), 'preview-source-')); await writeFile(path.join(source, 'index.html'), '<main>safe</main>');
    const root = await mkdtemp(path.join(tmpdir(), 'preview-root-'));
    const workspaces = { async resolveMissionRevision(mission: string, revision: { id: string }) { if (mission !== missionId || revision.id !== revisionId) throw new Error('integrity'); return source; } } as MissionWorkspacePort;
    const service = new RevisionPreviewService(store, workspaces, references, { async prepare() { throw new Error('not used'); } }, root); await service.initialize();
    const created = await service.create(missionId, { kind: 'workspace', revisionId }); expect(created.session.profile).toBe('static-html');
    await expect(service.asset(missionId, created.session.id, 'wrong', 'index.html')).rejects.toThrow('authentication');
    const asset = await service.asset(missionId, created.session.id, created.token, 'index.html'); expect(asset.bytes.toString()).toContain('safe'); expect(asset.headers['content-security-policy']).toContain("connect-src 'none'");
    await expect(service.asset(missionId, created.session.id, created.token, '../secret')).rejects.toThrow('Invalid');
    await service.stop(missionId, created.session.id); await expect(service.get(missionId, created.session.id)).rejects.toThrow('not found');
  });

  it('recovers an exact same-Mission preview, rotates authentication, keeps two-global bound, TTL and startup cleanup', async () => {
    const source = await mkdtemp(path.join(tmpdir(), 'preview-source-')); await writeFile(path.join(source, 'index.html'), 'x'); const root = await mkdtemp(path.join(tmpdir(), 'preview-root-')); await mkdir(path.join(root, 'preview-00000000-0000-4000-8000-000000000099')); let clock = 0;
    const service = new RevisionPreviewService(store, { async resolveMissionRevision() { return source; } } as MissionWorkspacePort, references, { async prepare() {} }, root, () => clock); await service.initialize(); await expect(stat(path.join(root, 'preview-00000000-0000-4000-8000-000000000099'))).rejects.toThrow();
    const first = await service.create(missionId, { kind: 'workspace', revisionId }); const recovered = await service.create(missionId, { kind: 'workspace', revisionId }); expect(recovered.session.id).toBe(first.session.id); expect(recovered.token).not.toBe(first.token); await expect(service.asset(missionId, first.session.id, first.token, 'index.html')).rejects.toThrow('authentication'); await expect(service.asset(missionId, recovered.session.id, recovered.token, 'index.html')).resolves.toBeTruthy(); clock = 300_001; await expect(service.get(missionId, first.session.id)).rejects.toThrow('not found'); await expect(stat(path.join(root, `preview-${first.session.id}`))).rejects.toThrow();
  });

  it('enforces the two-session global bound', async () => { const source = await mkdtemp(path.join(tmpdir(), 'preview-source-')); await writeFile(path.join(source, 'index.html'), 'x'); const root = await mkdtemp(path.join(tmpdir(), 'preview-root-')); const ids = [1, 2, 3].map((value) => `00000000-0000-4000-8000-00000000000${value}`); const revisionIds = [4, 5, 6].map((value) => `00000000-0000-4000-8000-00000000000${value}`); const localStore = { snapshot: () => ({ missions: ids.map((id) => ({ id })), missionWorkspaceRevisions: revisionIds.map((id, index) => ({ id, missionId: ids[index] })), designRevisions: [], missionArtifacts: [] }) } as unknown as JsonStore; const service = new RevisionPreviewService(localStore, { async resolveMissionRevision() { return source; } } as MissionWorkspacePort, references, { async prepare() {} }, root); await service.initialize(); await service.create(ids[0]!, { kind: 'workspace', revisionId: revisionIds[0]! }); await service.create(ids[1]!, { kind: 'workspace', revisionId: revisionIds[1]! }); await expect(service.create(ids[2]!, { kind: 'workspace', revisionId: revisionIds[2]! })).rejects.toThrow('limit'); });

  it('rejects an unrelated same-Mission DesignRevision and workspace revision pair', async () => {
    const designRevisionId = '00000000-0000-4000-8000-000000000003';
    const otherWorkspaceRevisionId = '00000000-0000-4000-8000-000000000004';
    const localStore = { snapshot: () => ({
      missions: [{ id: missionId }],
      missionWorkspaceRevisions: [{ id: revisionId, missionId }, { id: otherWorkspaceRevisionId, missionId }],
      designRevisions: [{ id: designRevisionId, missionId }],
      missionArtifacts: [],
      verificationRuns: [{ missionId, designRevisionId, workspaceRevisionId: otherWorkspaceRevisionId }],
      missionTasks: [],
    }) } as unknown as JsonStore;
    const root = await mkdtemp(path.join(tmpdir(), 'preview-binding-root-'));
    const service = new RevisionPreviewService(localStore, {} as MissionWorkspacePort, references, { async prepare() {} }, root); await service.initialize();
    await expect(service.create(missionId, { kind: 'workspace', revisionId, designRevisionId })).rejects.toThrow('not bound');
  });

  it('uses container preparation only for an accepted Vite profile and rejects symlink assets', async () => {
    const source = await mkdtemp(path.join(tmpdir(), 'preview-vite-')); await mkdir(path.join(source, 'src')); await writeFile(path.join(source, 'index.html'), '<div/>'); await writeFile(path.join(source, 'src', 'main.js'), ''); await writeFile(path.join(source, 'package.json'), JSON.stringify({ scripts: { preview: 'evil' }, dependencies: { vite: '1' } })); const root = await mkdtemp(path.join(tmpdir(), 'preview-root-')); let calls = 0;
    const runtime: PreviewRuntime = { async prepare({ outputRoot }) { calls += 1; await mkdir(outputRoot); await writeFile(path.join(outputRoot, 'index.html'), '<main>built</main>'); } };
    const service = new RevisionPreviewService(store, { async resolveMissionRevision() { return source; } } as MissionWorkspacePort, references, runtime, root); await service.initialize(); const created = await service.create(missionId, { kind: 'workspace', revisionId }); expect(created.session.profile).toBe('vite-vanilla'); expect(calls).toBe(1);
    const link = path.join(root, `preview-${created.session.id}`, 'link.js'); await symlink(path.join(root, 'secret'), link).catch(() => undefined); if (await lstat(link).then(() => true).catch(() => false)) await expect(service.asset(missionId, created.session.id, created.token, 'link.js')).rejects.toThrow('unavailable');
  });
  it('materializes protected DesignRevision HTML only after exact descriptor verification', async () => { const hash = 'a'.repeat(64); const taskId = '00000000-0000-4000-8000-000000000007'; const attemptId = '00000000-0000-4000-8000-000000000008'; const kinds = [{ key: 'packageArtifactId', id: '00000000-0000-4000-8000-000000000011', kind: 'design_package', suffix: 'package', mediaType: 'application/json' }, { key: 'previewArtifactId', id: '00000000-0000-4000-8000-000000000012', kind: 'design_preview', suffix: 'preview', mediaType: 'text/html' }, { key: 'contractArtifactId', id: '00000000-0000-4000-8000-000000000013', kind: 'design_contract', suffix: 'contract', mediaType: 'application/json' }] as const; const designStore = { snapshot: () => ({ missions: [{ id: missionId }], missionWorkspaceRevisions: [], designRevisions: [{ id: revisionId, missionId, sourceTaskId: taskId, sourceAttemptId: attemptId, packageArtifactId: kinds[0].id, previewArtifactId: kinds[1].id, contractArtifactId: kinds[2].id, packageHash: hash, previewHash: hash, contractHash: hash }], missionArtifacts: kinds.map((item) => ({ id: item.id, missionId, taskId, attemptId, kind: item.kind, storage: { kind: 'external', key: `design-reference-${missionId}-${revisionId}-${item.suffix}` }, content: null, mediaType: item.mediaType, originalByteLength: 10, sha256: hash })) }) } as unknown as JsonStore; let verified = false; const designReferences = { async verify() { return verified; }, async read() { return '<main>protected</main>'; } } as DesignReferenceStore; const root = await mkdtemp(path.join(tmpdir(), 'preview-design-')); const service = new RevisionPreviewService(designStore, {} as MissionWorkspacePort, designReferences, { async prepare() {} }, root); await service.initialize(); await expect(service.create(missionId, { kind: 'design', revisionId })).rejects.toThrow('integrity'); verified = true; const created = await service.create(missionId, { kind: 'design', revisionId }); expect(created.session.profile).toBe('static-html'); expect((await service.asset(missionId, created.session.id, created.token, 'index.html')).bytes.toString()).toContain('protected'); });

  it('reserves same-Mission and global slots before asynchronous materialization', async () => {
    const source = await mkdtemp(path.join(tmpdir(), 'preview-race-source-')); await writeFile(path.join(source, 'index.html'), 'x'); const root = await mkdtemp(path.join(tmpdir(), 'preview-race-root-'));
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const ids = [1, 2, 3].map((value) => `00000000-0000-4000-8000-00000000000${value}`); const revisions = [4, 5, 6].map((value) => `00000000-0000-4000-8000-00000000000${value}`);
    const localStore = { snapshot: () => ({ missions: ids.map((id) => ({ id })), missionWorkspaceRevisions: revisions.map((id, index) => ({ id, missionId: ids[index] })), designRevisions: [], missionArtifacts: [] }) } as unknown as JsonStore;
    const service = new RevisionPreviewService(localStore, { async resolveMissionRevision() { await gate; return source; } } as MissionWorkspacePort, references, { async prepare() {} }, root); await service.initialize();
    const same = [service.create(ids[0]!, { kind: 'workspace', revisionId: revisions[0]! }), service.create(ids[0]!, { kind: 'workspace', revisionId: revisions[0]! })];
    const secondMission = service.create(ids[1]!, { kind: 'workspace', revisionId: revisions[1]! });
    const thirdMission = service.create(ids[2]!, { kind: 'workspace', revisionId: revisions[2]! });
    release();
    const settled = await Promise.allSettled([...same, secondMission, thirdMission]);
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(2);
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(2);
  });

  it('releases a reserved slot and cleans temporary output on every failure', async () => {
    const source = await mkdtemp(path.join(tmpdir(), 'preview-failure-source-')); await writeFile(path.join(source, 'index.html'), '<main/>'); await writeFile(path.join(source, 'package.json'), JSON.stringify({ dependencies: { vite: '1' } })); await mkdir(path.join(source, 'src')); await writeFile(path.join(source, 'src', 'main.js'), ''); const root = await mkdtemp(path.join(tmpdir(), 'preview-failure-root-')); let fail = true;
    const workspaces = { async resolveMissionRevision() { return source; } } as MissionWorkspacePort;
    const runtime: PreviewRuntime = { async prepare({ outputRoot }) { if (fail) { fail = false; throw new Error('bounded runtime failed'); } await mkdir(outputRoot); await writeFile(path.join(outputRoot, 'index.html'), '<main/>'); } };
    const service = new RevisionPreviewService(store, workspaces, references, runtime, root); await service.initialize();
    await expect(service.create(missionId, { kind: 'workspace', revisionId })).rejects.toThrow('bounded runtime failed');
    await expect(service.create(missionId, { kind: 'workspace', revisionId })).resolves.toBeTruthy();
    expect((await readdir(root)).every((entry) => !entry.startsWith('.tmp-'))).toBe(true);
  });

  it('bounds source files and trees, drops control paths, and disables workspace config discovery', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'preview-bounds-root-'));
    const large = await mkdtemp(path.join(tmpdir(), 'preview-large-file-')); await writeFile(path.join(large, 'index.html'), '<main/>'); await mkdir(path.join(large, 'assets')); await writeFile(path.join(large, 'assets', 'large.png'), Buffer.alloc(2 * 1024 * 1024 + 1));
    const service = new RevisionPreviewService(store, { async resolveMissionRevision() { return large; } } as MissionWorkspacePort, references, { async prepare() {} }, root); await service.initialize();
    await expect(service.create(missionId, { kind: 'workspace', revisionId })).rejects.toThrow('content bound');

    const tree = await mkdtemp(path.join(tmpdir(), 'preview-large-tree-')); await writeFile(path.join(tree, 'index.html'), '<main/>'); await mkdir(path.join(tree, 'assets')); await Promise.all(Array.from({ length: 513 }, (_, index) => writeFile(path.join(tree, 'assets', `${index}.png`), 'x')));
    const treeService = new RevisionPreviewService(store, { async resolveMissionRevision() { return tree; } } as MissionWorkspacePort, references, { async prepare() {} }, await mkdtemp(path.join(tmpdir(), 'preview-tree-root-'))); await treeService.initialize();
    await expect(treeService.create(missionId, { kind: 'workspace', revisionId })).rejects.toThrow('content bound');

    const vite = await mkdtemp(path.join(tmpdir(), 'preview-config-')); await writeFile(path.join(vite, 'index.html'), '<div/>'); await writeFile(path.join(vite, 'package.json'), JSON.stringify({ dependencies: { vite: '1' } })); await mkdir(path.join(vite, 'src')); await writeFile(path.join(vite, 'src', 'main.js'), ''); await writeFile(path.join(vite, 'vite.config.js'), 'throw new Error("discovered")'); await writeFile(path.join(vite, 'postcss.config.js'), 'throw new Error("discovered")'); await writeFile(path.join(vite, 'AGENTS.md'), 'control'); await writeFile(path.join(vite, '.npmrc'), 'token=secret'); await mkdir(path.join(vite, '.conductor')); await writeFile(path.join(vite, '.conductor', 'secret.js'), 'secret');
    const runtime: PreviewRuntime = { async prepare({ sourceRoot, outputRoot }) { await expect(stat(path.join(sourceRoot, 'vite.config.js'))).rejects.toThrow(); await expect(stat(path.join(sourceRoot, 'postcss.config.js'))).rejects.toThrow(); await expect(stat(path.join(sourceRoot, 'AGENTS.md'))).rejects.toThrow(); await expect(stat(path.join(sourceRoot, '.npmrc'))).rejects.toThrow(); await mkdir(outputRoot); await writeFile(path.join(outputRoot, 'index.html'), '<main>safe</main>'); } };
    const configService = new RevisionPreviewService(store, { async resolveMissionRevision() { return vite; } } as MissionWorkspacePort, references, runtime, await mkdtemp(path.join(tmpdir(), 'preview-config-root-'))); await configService.initialize();
    const created = await configService.create(missionId, { kind: 'workspace', revisionId });
    await expect(configService.asset(missionId, created.session.id, created.token, 'AGENTS.md')).rejects.toThrow('Invalid');
  });

  it('revalidates the exact immutable checkpoint after materialization and removes raced output', async () => {
    const source = await mkdtemp(path.join(tmpdir(), 'preview-hash-race-')); await writeFile(path.join(source, 'index.html'), '<main/>'); const root = await mkdtemp(path.join(tmpdir(), 'preview-hash-root-')); let calls = 0;
    const service = new RevisionPreviewService(store, { async resolveMissionRevision() { calls += 1; if (calls === 2) throw new Error('integrity failed'); return source; } } as MissionWorkspacePort, references, { async prepare() {} }, root); await service.initialize();
    await expect(service.create(missionId, { kind: 'workspace', revisionId })).rejects.toThrow('integrity failed');
    expect(await readdir(root)).toEqual([]);
  });

  it('uses labeled identities, reconciles only labeled containers, and force-removes failures and shutdown work', async () => {
    const calls: string[][] = [];
    let releaseBuild!: (value: { code: number; stdout: string; stderr: string }) => void;
    const build = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => { releaseBuild = resolve; });
    const process: PreviewEngineProcess = { async run(args) { calls.push([...args]); if (args[0] === 'ps') return { code: 0, stdout: 'abcdef123456\n', stderr: '' }; if (args[0] === 'run') return build; return { code: 0, stdout: '', stderr: '' }; } };
    const runtime = new ContainerRevisionPreviewRuntime({ engine: 'docker', image: 'preview:test', user: '1000:1000', process });
    await runtime.initialize();
    expect(calls[0]).toEqual(['ps', '--all', '--quiet', '--filter', 'label=io.conductor.preview=true']);
    expect(calls[1]).toEqual(['rm', '--force', 'abcdef123456']);
    const source = await mkdtemp(path.join(tmpdir(), 'preview-runtime-source-')); const output = path.join(await mkdtemp(path.join(tmpdir(), 'preview-runtime-output-')), 'built');
    const preparing = runtime.prepare({ sourceRoot: source, outputRoot: output, profile: 'vite-vanilla' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const runArgs = calls.find((args) => args[0] === 'run')!; const name = runArgs[runArgs.indexOf('--name') + 1]!;
    expect(name).toMatch(/^conductor-preview-[0-9a-f-]{36}$/); expect(runArgs).toEqual(expect.arrayContaining(['--label', 'io.conductor.preview=true', '--cidfile', `${output}.cid`, '--tmpfs', '/output:rw,nosuid,nodev,noexec,size=10m'])); expect(runArgs.join(' ')).not.toContain('target=/output');
    await runtime.shutdown(); expect(calls).toContainEqual(['rm', '--force', name]);
    releaseBuild({ code: 1, stdout: '', stderr: 'failed' });
    await expect(preparing).rejects.toThrow('failed');
    expect(calls.filter((args) => args[0] === 'rm' && args[2] === name).length).toBeGreaterThanOrEqual(1);
  });

  it('force-removes the exact named preview container after an engine timeout', async () => {
    const calls: string[][] = [];
    const process: PreviewEngineProcess = { async run(args) { calls.push([...args]); if (args[0] === 'run') throw new Error('Preview engine command timed out'); return { code: 0, stdout: '', stderr: '' }; } };
    const runtime = new ContainerRevisionPreviewRuntime({ engine: 'docker', image: 'preview:test', user: '1000:1000', process }); const source = await mkdtemp(path.join(tmpdir(), 'preview-timeout-source-')); const output = path.join(await mkdtemp(path.join(tmpdir(), 'preview-timeout-output-')), 'built');
    await expect(runtime.prepare({ sourceRoot: source, outputRoot: output, profile: 'vite-vanilla' })).rejects.toThrow('timed out');
    const runArgs = calls.find((args) => args[0] === 'run')!; const identity = runArgs[runArgs.indexOf('--name') + 1]!;
    expect(calls).toContainEqual(['rm', '--force', identity]);
  });
});
