import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTHORITATIVE_FILE_BYTES, classifyChangedPath, inspectWorkspaceProjection } from './workspace-projection.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('bounded workspace projection', () => {
  it('truncates only the proposal inventory while retaining a complete authoritative projection', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'projection-large-')); roots.push(root);
    const inventoryLimit = 16;
    await mkdir(path.join(root, 'docs'));
    await Promise.all(Array.from({ length: inventoryLimit + 1 }, (_, index) => writeFile(path.join(root, 'docs', `entry-${String(index).padStart(4, '0')}.md`), 'x')));
    const projection = await inspectWorkspaceProjection(root, inventoryLimit);
    expect(projection.inventoryPaths).toHaveLength(inventoryLimit);
    expect(projection).toMatchObject({ inventoryTruncated: true, inventoryComplete: false, fileCount: inventoryLimit + 1 });
    expect(projection.files.size).toBe(inventoryLimit + 1);
  });

  it('uses framework facts for bootstrap, route, module, and dependency paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'projection-framework-')); roots.push(root);
    await mkdir(path.join(root, 'src', 'routing'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { react: '1', vite: '1' } }));
    await writeFile(path.join(root, 'src', 'main.js'), '');
    await writeFile(path.join(root, 'src', 'feature.mjs'), '');
    await writeFile(path.join(root, 'src', 'routing', 'routes.cjs'), '');
    const facts = (await inspectWorkspaceProjection(root)).frameworkFacts;
    expect(classifyChangedPath('src/main.js', facts)).toBe('frontend');
    expect(classifyChangedPath('src/feature.mjs', facts)).toBe('frontend');
    expect(classifyChangedPath('src/routing/routes.cjs', facts)).toBe('frontend');
    expect(classifyChangedPath('package.json', facts)).toBe('frontend');
  });

  it('fails closed before hashing a file beyond the authoritative per-file bound', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'projection-file-bound-')); roots.push(root);
    await writeFile(path.join(root, 'large.bin'), Buffer.alloc(AUTHORITATIVE_FILE_BYTES + 1));
    await expect(inspectWorkspaceProjection(root)).rejects.toThrow('authoritative inspection bound');
  });
});