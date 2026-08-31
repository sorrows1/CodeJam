import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPreviewDataContract } from './preview-data-contract.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('preview data contract', () => {
  it('loads exact revision-owned routes and sanitized GET fixtures', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'preview-data-')); roots.push(root);
    await mkdir(path.join(root, 'preview-fixtures'));
    await writeFile(path.join(root, 'preview-fixtures', 'missions.json'), JSON.stringify([{ id: 'demo', title: 'Demo mission' }]));
    await writeFile(path.join(root, 'conductor.preview.json'), JSON.stringify({ schemaVersion: 1, routes: ['/missions'], mocks: [{ id: 'missions', method: 'GET', path: '/api/missions', status: 200, fixture: 'preview-fixtures/missions.json' }] }));
    const contract = await loadPreviewDataContract(root);
    expect(contract).toMatchObject({ routes: ['/missions'], mocks: [{ id: 'missions', method: 'GET', requestPath: '/api/missions', status: 200 }] });
    expect(contract?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects traversal, unsupported methods, and configured sensitive values', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'preview-data-invalid-')); roots.push(root);
    await mkdir(path.join(root, 'preview-fixtures'));
    await writeFile(path.join(root, 'preview-fixtures', 'secret.json'), JSON.stringify({ token: 'known-secret' }));
    await writeFile(path.join(root, 'conductor.preview.json'), JSON.stringify({ schemaVersion: 1, routes: [], mocks: [{ id: 'secret', method: 'GET', path: '/api/data', status: 200, fixture: 'preview-fixtures/secret.json' }] }));
    await expect(loadPreviewDataContract(root, ['known-secret'])).rejects.toThrow('sensitive');
  });
});
