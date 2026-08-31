import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileDesignReferenceStore } from './file-design-reference-store.js';

const missionId = '11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';

describe('FileDesignReferenceStore', () => {
  it('publishes atomically, replays identical bytes, and detects tampering', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'design-reference-'));
    try {
      const store = new FileDesignReferenceStore(root); await store.initialize();
      const first = await store.materialize({ missionId, revisionId, packageJson: '{"package":1}', previewHtml: '<p>preview</p>', contractJson: '{"schemaVersion":1}' });
      expect(await store.materialize({ missionId, revisionId, packageJson: '{"package":1}', previewHtml: '<p>preview</p>', contractJson: '{"schemaVersion":1}' })).toEqual(first);
      await writeFile(path.join(root, missionId, revisionId, 'preview.html'), 'tampered');
      await expect(store.materialize({ missionId, revisionId, packageJson: '{"package":1}', previewHtml: '<p>preview</p>', contractJson: '{"schemaVersion":1}' })).rejects.toThrow('integrity');
      expect(await store.verify(first)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects traversal IDs and bounded reads', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'design-reference-'));
    try {
      const store = new FileDesignReferenceStore(root); await store.initialize();
      await expect(store.materialize({ missionId: '../escape', revisionId, packageJson: '', previewHtml: '', contractJson: '' })).rejects.toThrow('Invalid Mission ID');
      const descriptors = await store.materialize({ missionId, revisionId, packageJson: 'large', previewHtml: '<p>preview</p>', contractJson: '{}' });
      await expect(store.read(descriptors.package, 2)).rejects.toThrow('read bound');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
