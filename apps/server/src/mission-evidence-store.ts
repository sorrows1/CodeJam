import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const keyPattern = /^evidence-[0-9a-f-]{36}\.jpg$/i;
export interface MissionEvidenceStore { write(bytes: Buffer): Promise<{ key: string; sha256: string; byteLength: number }>; read(key: string, sha256: string, byteLength: number): Promise<Buffer>; remove(key: string): Promise<void>; }

export class FileMissionEvidenceStore implements MissionEvidenceStore {
  constructor(private readonly root: string) {}
  private target(key: string): string { if (!keyPattern.test(key)) throw new Error('Invalid evidence key'); return path.join(this.root, key); }
  async initialize(referencedKeys: ReadonlySet<string>): Promise<void> { await mkdir(this.root, { recursive: true }); for (const entry of await readdir(this.root, { withFileTypes: true })) { if (!entry.isFile()) continue; if (/^evidence-[0-9a-f-]{36}\.jpg\.tmp-[0-9a-f-]{36}$/i.test(entry.name) || keyPattern.test(entry.name) && !referencedKeys.has(entry.name)) await rm(path.join(this.root, entry.name), { force: true }); } }
  async write(bytes: Buffer): Promise<{ key: string; sha256: string; byteLength: number }> {
    if (!bytes.length || bytes.byteLength > 512 * 1024) throw new Error('Evidence image exceeds the hard bound');
    await mkdir(this.root, { recursive: true });
    const key = `evidence-${randomUUID()}.jpg`; const target = this.target(key); const temporary = `${target}.tmp-${randomUUID()}`;
    try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
    return { key, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength };
  }
  async read(key: string, expectedHash: string, expectedLength: number): Promise<Buffer> {
    const bytes = await readFile(this.target(key)); if (bytes.byteLength !== expectedLength) throw new Error('Evidence length mismatch');
    const actual = Buffer.from(createHash('sha256').update(bytes).digest('hex')); const expected = Buffer.from(expectedHash.toLowerCase());
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Evidence hash mismatch');
    return bytes;
  }
  async remove(key: string): Promise<void> { await rm(this.target(key), { force: true }); }
}
