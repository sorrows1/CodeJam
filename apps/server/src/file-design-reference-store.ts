import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DesignReferenceDescriptor, DesignReferenceKind, DesignReferenceMaterialization, DesignReferenceStore } from './design-reference-store.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const names: Record<DesignReferenceKind, { file: string; mediaType: string }> = { package: { file: 'package.json', mediaType: 'application/json' }, preview: { file: 'preview.html', mediaType: 'text/html' }, contract: { file: 'design-contract.json', mediaType: 'application/json' } };

function assertId(value: string, label: string): void { if (!uuid.test(value)) throw new Error(`Invalid ${label}`); }
function descriptor(missionId: string, revisionId: string, kind: DesignReferenceKind, content: string): DesignReferenceDescriptor { return { missionId, revisionId, kind, key: `design-reference-${missionId}-${revisionId}-${kind}`, sha256: sha256(content), byteLength: Buffer.byteLength(content, 'utf8'), mediaType: names[kind].mediaType }; }

export class FileDesignReferenceStore implements DesignReferenceStore {
  constructor(private readonly root: string) {}
  async initialize(): Promise<void> { await mkdir(this.root, { recursive: true }); }

  private directory(missionId: string, revisionId: string): string { assertId(missionId, 'Mission ID'); assertId(revisionId, 'DesignRevision ID'); return path.join(this.root, missionId, revisionId); }
  private filePath(directory: string, kind: DesignReferenceKind): string { return path.join(directory, names[kind].file); }

  async materialize(input: { missionId: string; revisionId: string; packageJson: string; previewHtml: string; contractJson: string }): Promise<DesignReferenceMaterialization> {
    const directory = this.directory(input.missionId, input.revisionId);
    const contents: Record<DesignReferenceKind, string> = { package: input.packageJson, preview: input.previewHtml, contract: input.contractJson };
    const result = { package: descriptor(input.missionId, input.revisionId, 'package', input.packageJson), preview: descriptor(input.missionId, input.revisionId, 'preview', input.previewHtml), contract: descriptor(input.missionId, input.revisionId, 'contract', input.contractJson) };
    try {
      const existingDirectory = await stat(directory);
      if (!existingDirectory.isDirectory()) throw new Error('Design reference integrity conflict');
      for (const kind of Object.keys(names) as DesignReferenceKind[]) {
        let existing: string;
        try { existing = await readFile(this.filePath(directory, kind), 'utf8'); } catch { throw new Error('Design reference integrity conflict'); }
        if (existing !== contents[kind] || sha256(existing) !== result[kind].sha256) throw new Error('Design reference integrity conflict');
      }
      const entries = await readdir(directory);
      if (entries.some((entry) => !Object.values(names).some((item) => item.file === entry))) throw new Error('Design reference integrity conflict');
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === 'Design reference integrity conflict') throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(path.dirname(directory), { recursive: true });
    const temporary = path.join(path.dirname(directory), `.${input.revisionId}.tmp-${randomUUID()}`);
    try {
      await mkdir(temporary);
      for (const kind of Object.keys(names) as DesignReferenceKind[]) await writeFile(this.filePath(temporary, kind), contents[kind], { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, directory);
      return result;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return this.materialize(input);
      }
      throw error;
    }
  }

  async verify(materialization: DesignReferenceMaterialization): Promise<boolean> {
    for (const kind of Object.keys(names) as DesignReferenceKind[]) {
      const item = materialization[kind];
      assertId(item.missionId, 'Mission ID'); assertId(item.revisionId, 'DesignRevision ID');
      if (item.kind !== kind || item.key !== `design-reference-${item.missionId}-${item.revisionId}-${kind}`) return false;
      try {
        const content = await readFile(this.filePath(this.directory(item.missionId, item.revisionId), kind), 'utf8');
        if (Buffer.byteLength(content, 'utf8') !== item.byteLength || sha256(content) !== item.sha256) return false;
      } catch { return false; }
    }
    return true;
  }

  verifySync(materialization: DesignReferenceMaterialization): boolean {
    for (const kind of Object.keys(names) as DesignReferenceKind[]) {
      const item = materialization[kind];
      assertId(item.missionId, 'Mission ID'); assertId(item.revisionId, 'DesignRevision ID');
      if (item.kind !== kind || item.key !== `design-reference-${item.missionId}-${item.revisionId}-${kind}`) return false;
      try {
        const content = readFileSync(this.filePath(this.directory(item.missionId, item.revisionId), kind), 'utf8');
        if (Buffer.byteLength(content, 'utf8') !== item.byteLength || sha256(content) !== item.sha256) return false;
      } catch { return false; }
    }
    return true;
  }

  async read(item: DesignReferenceDescriptor, maxBytes: number): Promise<string> {
    assertId(item.missionId, 'Mission ID'); assertId(item.revisionId, 'DesignRevision ID');
    if (item.key !== `design-reference-${item.missionId}-${item.revisionId}-${item.kind}` || !names[item.kind]) throw new Error('Invalid Design reference descriptor');
    const content = await readFile(this.filePath(this.directory(item.missionId, item.revisionId), item.kind), 'utf8');
    if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new Error('Design reference exceeds read bound');
    if (sha256(content) !== item.sha256) throw new Error('Design reference integrity mismatch');
    return content;
  }
}
