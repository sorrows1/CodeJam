import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileMissionEvidenceStore } from './mission-evidence-store.js';

describe('external Mission evidence store', () => {
  it('publishes immutable hash-bound bounded bytes and rejects invalid keys', async () => { const root = await mkdtemp(path.join(tmpdir(), 'evidence-')); const store = new FileMissionEvidenceStore(root); const descriptor = await store.write(Buffer.from('jpeg')); expect(await store.read(descriptor.key, descriptor.sha256, descriptor.byteLength)).toEqual(Buffer.from('jpeg')); await writeFile(path.join(root, descriptor.key), 'changed'); await expect(store.read(descriptor.key, descriptor.sha256, descriptor.byteLength)).rejects.toThrow(); await expect(store.read('../secret', descriptor.sha256, descriptor.byteLength)).rejects.toThrow('key'); });
  it('cleans only unreferenced evidence publications on startup', async () => { const root = await mkdtemp(path.join(tmpdir(), 'evidence-cleanup-')); const store = new FileMissionEvidenceStore(root); const retained = await store.write(Buffer.from('keep')); const orphan = await store.write(Buffer.from('orphan')); await writeFile(path.join(root, 'unrelated.txt'), 'keep'); await store.initialize(new Set([retained.key])); expect((await store.read(retained.key, retained.sha256, retained.byteLength)).toString()).toBe('keep'); await expect(stat(path.join(root, orphan.key))).rejects.toThrow(); expect((await stat(path.join(root, 'unrelated.txt'))).isFile()).toBe(true); });
});
