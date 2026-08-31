import { access, copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Agent, MissionWorkspaceRevision } from "./types.js";
import { inspectWorkspaceProjection, type WorkspaceProjection } from './workspace-projection.js';
import { WorkspacePublisher, type WorkspacePublicationReceipt, type WorkspacePublicationRecovery } from './workspace-publication.js';

export interface MissionWorkspaceInspection { state: "clean" | "changed" | "unavailable" | "unchecked_running"; contentHash: string | null; displayPath: string; }
export interface DesignDraftInspection { unauthorizedPaths: string[]; invalidPaths: string[]; files: { indexHtml: string | null; stylesCss: string | null; contractJson: string | null; bundleJson: string | null } | null; baselineMatches: boolean; }
export interface RevisionComparison { files: Array<{ path: string; operation: 'ADDED' | 'MODIFIED' | 'DELETED' }>; truncated: boolean; }
export interface MissionWorkspacePort {
  missionWorkspacePath(missionId: string): string;
  createMissionWorkspace(missionId: string, sourceAgentId?: string, expectedSourceHash?: string): Promise<string>;
  cleanupMissionProvisioning(missionId: string): Promise<void>;
  missionWorkspaceExists(missionId: string): Promise<boolean>;
  inspectMissionWorkspace(missionId: string, currentHash: string | null, running: boolean): Promise<MissionWorkspaceInspection>;
  captureMissionRevision(input: { missionId: string; revision: Omit<MissionWorkspaceRevision, "snapshotKey" | "contentHash"> }): Promise<MissionWorkspaceRevision>;
  discardMissionRevision(missionId: string, revision: MissionWorkspaceRevision): Promise<void>;
  resolveMissionRevision(missionId: string, revision: MissionWorkspaceRevision): Promise<string>;
  compareRevisions(missionId: string, before: MissionWorkspaceRevision, after: MissionWorkspaceRevision, sensitiveValues?: readonly string[]): Promise<RevisionComparison>;
  restoreMissionRevision(missionId: string, revision: MissionWorkspaceRevision): Promise<void>;
  recoverInterruptedRestore(missionId: string): Promise<void>;
  prepareDesignDraft(missionId: string, seed?: { indexHtml: string; stylesCss: string; contractJson: string; bundleJson?: string }): Promise<void>;
  inspectDesignDraft(missionId: string, revision: MissionWorkspaceRevision): Promise<DesignDraftInspection>;
}

const excludedMissionSeedSegments = new Set(['.codex', '.conductor', '.git', 'node_modules', 'dist']);
const transientMissionRuntimeDirectories = ['node_modules', 'dist'] as const;
const MAX_COMPARISON_ENTRIES = 1_024;
const MAX_COMPARISON_FILES = 512;
const MAX_COMPARISON_FILE_BYTES = 2 * 1024 * 1024;
const MAX_COMPARISON_TOTAL_BYTES = 8 * 1024 * 1024;

export function isMissionSeedPathExcluded(relativePath: string): boolean {
  const segments = relativePath.replaceAll('\\', '/').split('/').filter(Boolean);
  if (segments.some((segment) => excludedMissionSeedSegments.has(segment))) return true;
  const name = segments.at(-1) ?? '';
  return name === 'AGENTS.md' || name === '.env' || name.startsWith('.env.') || name.endsWith('.log');
}

const windowsPublicationRetryDelaysMs = [25, 50, 100, 200, 400, 800] as const;

function isWindowsDirectorySwapError(error: unknown, platform = process.platform): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
}

export async function publishMissionWorkspaceDirectory(
  temporary: string,
  workspace: string,
  options: {
    fallbackPublish?: () => Promise<void>;
    platform?: NodeJS.Platform;
    renameDirectory?: typeof rename;
    wait?: (milliseconds: number) => Promise<unknown>;
  } = {},
): Promise<void> {
  const renameDirectory = options.renameDirectory ?? rename;
  const wait = options.wait ?? delay;
  const platform = options.platform ?? process.platform;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameDirectory(temporary, workspace);
      return;
    } catch (error) {
      const retryDelay = windowsPublicationRetryDelaysMs[attempt];
      if (!isWindowsDirectorySwapError(error, platform)) throw error;
      if (retryDelay === undefined) {
        if (options.fallbackPublish) return options.fallbackPublish();
        throw error;
      }
      await wait(retryDelay);
    }
  }
}

export class WorkspaceManager implements MissionWorkspacePort {
  private readonly publisher: WorkspacePublisher;
  constructor(private readonly root: string) { this.publisher = new WorkspacePublisher(root); }

  workspacePath(agentId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId)) throw new Error("Invalid Agent ID");
    return path.join(this.root, agentId);
  }

  missionWorkspacePath(missionId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(missionId)) throw new Error("Invalid Mission ID");
    return path.join(this.root, ".missions", missionId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
    await mkdir(path.join(this.root, ".missions"), { recursive: true });
  }

  async fingerprintAgentWorkspace(agentId: string): Promise<string> {
    return (await this.inspectAgentWorkspace(agentId)).contentHash;
  }

  async inspectAgentWorkspace(agentId: string): Promise<WorkspaceProjection> {
    return inspectWorkspaceProjection(this.workspacePath(agentId));
  }

  async listAgentWorkspacePaths(agentId: string): Promise<string[]> {
    return (await this.inspectAgentWorkspace(agentId)).inventoryPaths;
  }

  async createPlaygroundCandidate(agentId: string, admissionId: string, expectedHash: string): Promise<{ path: string; projection: WorkspaceProjection }> {
    return this.publisher.createCandidate(this.workspacePath(agentId), admissionId, expectedHash);
  }

  async inspectPlaygroundCandidate(admissionId: string): Promise<WorkspaceProjection> { return this.publisher.inspectCandidate(admissionId); }
  playgroundCandidatePath(admissionId: string): string { return this.publisher.candidatePathFor(admissionId); }
  async discardPlaygroundCandidate(admissionId: string): Promise<void> { await this.publisher.discardCandidate(admissionId); }

  async publishAgentWorkspace(input: { transactionId: string; agentId: string; sourceRoot: string; expectedAgentHash: string; expectedSourceHash: string }): Promise<WorkspacePublicationReceipt> {
    return this.publisher.publish({ transactionId: input.transactionId, sourceRoot: input.sourceRoot, agentRoot: this.workspacePath(input.agentId), expectedAgentHash: input.expectedAgentHash, expectedSourceHash: input.expectedSourceHash });
  }

  async finalizeAgentWorkspacePublication(transactionId: string): Promise<void> { await this.publisher.finalize(transactionId); }
  async recoverAgentWorkspacePublication(input: { transactionId: string; agentId: string; expectedAgentHash: string; expectedPublishedHash: string }): Promise<WorkspacePublicationRecovery> {
    return this.publisher.recover({ transactionId: input.transactionId, agentRoot: this.workspacePath(input.agentId), expectedAgentHash: input.expectedAgentHash, expectedPublishedHash: input.expectedPublishedHash });
  }

  async createMissionWorkspace(missionId: string, sourceAgentId?: string, expectedSourceHash?: string): Promise<string> {
    const workspace = this.missionWorkspacePath(missionId);
    const temporary = path.join(path.dirname(workspace), `${missionId}.tmp-${randomUUID()}`);
    try {
      await mkdir(temporary, { recursive: false });
      if (sourceAgentId) {
        if (!/^[0-9a-f-]{36}$/i.test(sourceAgentId)) throw new Error("Invalid Agent ID");
        const source = this.workspacePath(sourceAgentId);
        if (expectedSourceHash && await this.hashMissionSeedDirectory(source) !== expectedSourceHash) throw new Error("Agent workspace changed after impact proposal");
        await this.copyMissionSeed(source, temporary);
        if (expectedSourceHash && await this.hashMissionSeedDirectory(source) !== expectedSourceHash) throw new Error("Agent workspace changed during Mission promotion");
      }
      await writeFile(path.join(temporary, "AGENTS.md"), [
        "# Conductor Mission workspace", "", "Conductor owns this shared Mission workspace.",
        "All participating Agents work only within this workspace and preserve existing files.",
        "Mission state is shared through the workspace and durable Conductor handoffs.",
        "Do not print credentials, environment variables, or secret values.", "",
      ].join("\n"), "utf8");
      await publishMissionWorkspaceDirectory(temporary, workspace, {
        fallbackPublish: () => this.copyDirectorySnapshot(temporary, workspace),
      });
      await rm(temporary, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
      return workspace;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }).catch(() => undefined);
      throw error;
    }
  }

  private async hashMissionSeedDirectory(sourceRoot: string): Promise<string> {
    return (await inspectWorkspaceProjection(sourceRoot)).contentHash;
  }

  private async copyMissionSeed(sourceRoot: string, destinationRoot: string, relative = ''): Promise<void> {
    const current = relative ? path.join(sourceRoot, relative) : sourceRoot;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const portableRelative = childRelative.replaceAll('\\', '/');
      if (isMissionSeedPathExcluded(portableRelative)) continue;
      const source = path.join(sourceRoot, childRelative);
      const destination = path.join(destinationRoot, childRelative);
      if (entry.isSymbolicLink()) throw new Error(`Mission source contains an unsupported symbolic link: ${portableRelative}`);
      if (entry.isDirectory()) {
        await mkdir(destination);
        await this.copyMissionSeed(sourceRoot, destinationRoot, childRelative);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Mission source contains an unsupported entry: ${portableRelative}`);
      await copyFile(source, destination);
    }
  }

  async cleanupMissionProvisioning(missionId: string): Promise<void> {
    const workspace = this.missionWorkspacePath(missionId);
    const workspaceParent = path.dirname(workspace);
    const entries = await readdir(workspaceParent, { withFileTypes: true }).catch(() => []);
    const temporaryPaths = entries
      .filter((entry) => entry.name.startsWith(`${missionId}.tmp-`))
      .map((entry) => path.join(workspaceParent, entry.name));
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(path.join(this.root, '.mission-checkpoints', missionId), { recursive: true, force: true }),
      ...temporaryPaths.map((temporary) => rm(temporary, { recursive: true, force: true })),
    ]);
  }

  async missionWorkspaceExists(missionId: string): Promise<boolean> {
    try { await access(path.join(this.missionWorkspacePath(missionId), "AGENTS.md")); return true; } catch { return false; }
  }

  private checkpointPath(missionId: string, snapshotKey: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(missionId) || !/^revision-[0-9a-f-]{36}$/i.test(snapshotKey)) throw new Error("Invalid Mission revision path");
    return path.join(this.root, ".mission-checkpoints", missionId, snapshotKey);
  }

  private async hashDirectory(directory: string): Promise<string> {
    const hash = createHash("sha256");
    const visit = async (current: string, relative: string): Promise<void> => {
      const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const child = path.join(current, entry.name);
        const childRelative = path.join(relative, entry.name).replaceAll("\\", "/");
        if (entry.isDirectory()) { hash.update(`dir:${childRelative}\n`); await visit(child, childRelative); }
        else if (entry.isFile()) { hash.update(`file:${childRelative}\n`); hash.update(await readFile(child)); }
        else throw new Error(`Workspace contains a non-regular entry: ${childRelative}`);
      }
    };
    await visit(directory, "");
    return hash.digest("hex");
  }

  async inspectMissionWorkspace(missionId: string, currentHash: string | null, running: boolean): Promise<MissionWorkspaceInspection> {
    const displayPath = this.missionWorkspacePath(missionId);
    if (running) return { state: "unchecked_running", contentHash: null, displayPath };
    try { await stat(displayPath); } catch { return { state: "unavailable", contentHash: null, displayPath }; }
    try { const contentHash = await this.hashDirectory(displayPath); return { state: currentHash && contentHash === currentHash ? "clean" : "changed", contentHash, displayPath }; } catch { return { state: "unavailable", contentHash: null, displayPath }; }
  }

  inspectMissionWorkspaceSync(missionId: string, currentHash: string | null, running: boolean): MissionWorkspaceInspection {
    const displayPath = this.missionWorkspacePath(missionId); if (running) return { state: "unchecked_running", contentHash: null, displayPath };
    try { statSync(displayPath); } catch { return { state: "unavailable", contentHash: null, displayPath }; }
    try { const hash = createHash("sha256"); const visit = (directory: string, relative: string): void => { for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) { const child = path.join(directory, entry.name); const childRelative = path.join(relative, entry.name).replaceAll("\\", "/"); if (entry.isDirectory()) { hash.update(`dir:${childRelative}\n`); visit(child, childRelative); } else if (entry.isFile()) { hash.update(`file:${childRelative}\n`); hash.update(readFileSync(child)); } else throw new Error(`Workspace contains a non-regular entry: ${childRelative}`); } }; visit(displayPath, ""); const contentHash = hash.digest("hex"); return { state: currentHash && contentHash === currentHash ? "clean" : "changed", contentHash, displayPath }; } catch { return { state: "unavailable", contentHash: null, displayPath }; }
  }

  private async pruneMissionRuntimeState(missionId: string): Promise<void> {
    const workspace = this.missionWorkspacePath(missionId);
    await Promise.all(transientMissionRuntimeDirectories.map((directory) => rm(path.join(workspace, directory), { recursive: true, force: true, maxRetries: 6, retryDelay: 50 })));
  }

  async captureMissionRevision(input: { missionId: string; revision: Omit<MissionWorkspaceRevision, "snapshotKey" | "contentHash"> }): Promise<MissionWorkspaceRevision> {
    const snapshotKey = `revision-${input.revision.id}`;
    const destination = this.checkpointPath(input.missionId, snapshotKey);
    const workspace = this.missionWorkspacePath(input.missionId);
    await mkdir(path.dirname(destination), { recursive: true });
    await this.pruneMissionRuntimeState(input.missionId);
    const sourceHash = await this.hashDirectory(workspace);
    try {
      await cp(workspace, destination, { recursive: true, verbatimSymlinks: true });
      const checkpointHash = await this.hashDirectory(destination);
      const finalSourceHash = await this.hashDirectory(workspace);
      if (checkpointHash !== sourceHash || finalSourceHash !== sourceHash) throw new Error("Workspace changed during checkpoint capture");
      return { ...structuredClone(input.revision), snapshotKey, contentHash: checkpointHash };
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async discardMissionRevision(missionId: string, revision: MissionWorkspaceRevision): Promise<void> {
    if (revision.missionId !== missionId) throw new Error('Mission workspace revision ownership mismatch');
    await rm(this.checkpointPath(missionId, revision.snapshotKey), { recursive: true, force: true });
  }

  async resolveMissionRevision(missionId: string, revision: MissionWorkspaceRevision): Promise<string> {
    if (revision.missionId !== missionId) throw new Error('Mission workspace revision ownership mismatch');
    const checkpoint = this.checkpointPath(missionId, revision.snapshotKey);
    if (!(await stat(checkpoint)).isDirectory() || await this.hashDirectory(checkpoint) !== revision.contentHash) throw new Error('Mission workspace revision integrity failed');
    return checkpoint;
  }

  async compareRevisions(missionId: string, before: MissionWorkspaceRevision, after: MissionWorkspaceRevision, sensitiveValues: readonly string[] = []): Promise<RevisionComparison> {
    if (before.missionId !== missionId || after.missionId !== missionId) throw new Error('Mission workspace revision ownership mismatch');
    const beforeRoot = this.checkpointPath(missionId, before.snapshotKey);
    const afterRoot = this.checkpointPath(missionId, after.snapshotKey);
    const secrets = sensitiveValues.filter((value) => value.length >= 4).map((value) => value.toLowerCase());
    const excluded = (relative: string): boolean => {
      const segments = relative.split('/');
      const name = segments.at(-1) ?? '';
      const lower = relative.toLowerCase();
      return segments.some((segment) => ['.git', '.codex', '.conductor', 'node_modules', 'dist'].includes(segment)) || name === 'AGENTS.md' || name === '.npmrc' || name.startsWith('.env') || name.endsWith('.log') || /(?:secret|credential|password|token|private[-_.]?key)/i.test(name) || secrets.some((secret) => lower.includes(secret));
    };
    const scan = async (root: string): Promise<{ contentHash: string; files: Map<string, string> }> => {
      if (!await stat(root).then((value) => value.isDirectory()).catch(() => false)) throw new Error('Workspace comparison is unavailable');
      const contentHash = createHash('sha256');
      const result = new Map<string, string>();
      let entriesSeen = 0;
      let fileCount = 0;
      let totalBytes = 0;
      const visit = async (directory: string, relative: string): Promise<void> => {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
          entriesSeen += 1;
          if (entriesSeen > MAX_COMPARISON_ENTRIES) throw new Error('Workspace comparison exceeds its entry bound');
          const childRelative = (relative ? `${relative}/${entry.name}` : entry.name).replaceAll('\\', '/');
          if (Buffer.byteLength(childRelative, 'utf8') > 256 || childRelative.includes('..') || path.isAbsolute(childRelative)) throw new Error('Workspace comparison contains an invalid path');
          if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('Workspace comparison rejects a non-regular entry');
          const child = path.join(directory, entry.name);
          if (entry.isDirectory()) { contentHash.update(`dir:${childRelative}\n`); await visit(child, childRelative); }
          else {
            fileCount += 1;
            const info = await stat(child);
            totalBytes += info.size;
            if (fileCount > MAX_COMPARISON_FILES || info.size > MAX_COMPARISON_FILE_BYTES || totalBytes > MAX_COMPARISON_TOTAL_BYTES) throw new Error('Workspace comparison exceeds its content bound');
            contentHash.update(`file:${childRelative}\n`);
            const visibleHash = excluded(childRelative) ? null : createHash('sha256');
            let streamed = 0;
            for await (const chunk of createReadStream(child)) {
              const bytes = chunk as Buffer;
              streamed += bytes.byteLength;
              if (streamed > MAX_COMPARISON_FILE_BYTES || totalBytes - info.size + streamed > MAX_COMPARISON_TOTAL_BYTES) throw new Error('Workspace comparison exceeds its content bound');
              contentHash.update(bytes);
              visibleHash?.update(bytes);
            }
            if (streamed !== info.size) throw new Error('Workspace comparison source changed during hashing');
            if (visibleHash) result.set(childRelative, visibleHash.digest('hex'));
          }
        }
      };
      await visit(root, '');
      return { contentHash: contentHash.digest('hex'), files: result };
    };
    const [left, right] = await Promise.all([scan(beforeRoot), scan(afterRoot)]);
    if (left.contentHash !== before.contentHash || right.contentHash !== after.contentHash) throw new Error('Mission workspace revision integrity failed');
    const all = [...new Set([...left.files.keys(), ...right.files.keys()])].sort();
    const changed = all.flatMap((relative) => left.files.get(relative) === right.files.get(relative) ? [] : [{ path: relative, operation: !left.files.has(relative) ? 'ADDED' as const : !right.files.has(relative) ? 'DELETED' as const : 'MODIFIED' as const }]);
    return { files: changed.slice(0, 128), truncated: changed.length > 128 };
  }

  async restoreMissionRevision(missionId: string, revision: MissionWorkspaceRevision): Promise<void> {
    const source = this.checkpointPath(missionId, revision.snapshotKey);
    const workspace = this.missionWorkspacePath(missionId);
    const temporary = `${workspace}.restore-${randomUUID()}`;
    const backup = `${workspace}.backup-${randomUUID()}`;
    const checkpointHash = await this.hashDirectory(source);
    if (checkpointHash !== revision.contentHash) throw new Error("Workspace checkpoint hash does not match revision");
    await cp(source, temporary, { recursive: true, verbatimSymlinks: true });
    if (await this.hashDirectory(temporary) !== revision.contentHash) {
      await rm(temporary, { recursive: true, force: true });
      throw new Error("Workspace checkpoint copy hash does not match revision");
    }
    let backupWasRenamed = false;
    try {
      try {
        await rename(workspace, backup);
        backupWasRenamed = true;
      } catch (error) {
        if (!isWindowsDirectorySwapError(error)) throw error;
        await this.copyDirectorySnapshot(workspace, backup);
        await this.replaceDirectoryContents(workspace, temporary);
      }
      if (!backupWasRenamed) {
        if (await this.hashDirectory(workspace) !== revision.contentHash) throw new Error("Restored workspace hash does not match revision");
        await rm(temporary, { recursive: true, force: true });
        await rm(backup, { recursive: true, force: true });
        return;
      }
      await rename(temporary, workspace);
      if (await this.hashDirectory(workspace) !== revision.contentHash) throw new Error("Restored workspace hash does not match revision");
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      if (await stat(backup).then(() => true).catch(() => false)) {
        if (backupWasRenamed) {
          await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
          await rename(backup, workspace).catch(async (renameError) => {
            if (isWindowsDirectorySwapError(renameError)) await this.replaceDirectoryContents(workspace, backup).catch(() => undefined);
          });
        } else {
          await this.replaceDirectoryContents(workspace, backup).catch(() => undefined);
        }
      }
      throw error;
    }
  }

  private async copyDirectorySnapshot(source: string, destination: string): Promise<void> {
    const sourceHash = await this.hashDirectory(source);
    try {
      await cp(source, destination, { recursive: true, verbatimSymlinks: true });
      const [copiedHash, finalSourceHash] = await Promise.all([this.hashDirectory(destination), this.hashDirectory(source)]);
      if (copiedHash === sourceHash && finalSourceHash === sourceHash) return;
      throw new Error("Workspace changed during verified directory copy");
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async replaceDirectoryContents(destination: string, source: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    const existing = await readdir(destination, { withFileTypes: true });
    await Promise.all(existing.map((entry) => rm(path.join(destination, entry.name), { recursive: true, force: true })));
    for (const entry of await readdir(source, { withFileTypes: true })) {
      await cp(path.join(source, entry.name), path.join(destination, entry.name), { recursive: true, verbatimSymlinks: true });
    }
  }

  async recoverInterruptedRestore(missionId: string): Promise<void> {
    const workspace = this.missionWorkspacePath(missionId);
    const parent = path.dirname(workspace);
    const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
    const backups = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(`${missionId}.backup-`)).map((entry) => path.join(parent, entry.name));
    const temporaries = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(`${missionId}.restore-`)).map((entry) => path.join(parent, entry.name));
    await Promise.all(temporaries.map((temporary) => rm(temporary, { recursive: true, force: true })));
    if (backups.length) {
      await rm(workspace, { recursive: true, force: true });
      await rename(backups[0]!, workspace).catch(async (error) => {
        if (!isWindowsDirectorySwapError(error)) throw error;
        await this.replaceDirectoryContents(workspace, backups[0]!);
        await rm(backups[0]!, { recursive: true, force: true });
      });
    }
    await Promise.all(backups.slice(1).map((backup) => rm(backup, { recursive: true, force: true })));
  }

  async prepareDesignDraft(missionId: string, seed?: { indexHtml: string; stylesCss: string; contractJson: string; bundleJson?: string }): Promise<void> {
    const workspace = this.missionWorkspacePath(missionId);
    const conductor = path.join(workspace, '.conductor');
    const draft = path.join(conductor, 'design-draft');
    await rm(draft, { recursive: true, force: true });
    await mkdir(draft, { recursive: true });
    if (seed) {
      await writeFile(path.join(draft, 'index.html'), seed.indexHtml, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await writeFile(path.join(draft, 'styles.css'), seed.stylesCss, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await writeFile(path.join(draft, 'design-contract.json'), seed.contractJson, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      if (seed.bundleJson) await writeFile(path.join(draft, 'design-bundle.json'), seed.bundleJson, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
  }

  private async collectPaths(directory: string, maxPaths = 100_000): Promise<Map<string, { kind: 'file' | 'directory' | 'symlink'; content?: string }>> {
    const result = new Map<string, { kind: 'file' | 'directory' | 'symlink'; content?: string }>();
    const visit = async (current: string, relative: string): Promise<void> => {
      const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const child = path.join(current, entry.name);
        const childRelative = path.join(relative, entry.name).replaceAll('\\', '/');
        if (result.size >= maxPaths) throw new Error('Workspace path bound exceeded');
        if (entry.isSymbolicLink()) { result.set(childRelative, { kind: 'symlink' }); continue; }
        if (entry.isDirectory()) { result.set(childRelative, { kind: 'directory' }); await visit(child, childRelative); continue; }
        if (entry.isFile()) result.set(childRelative, { kind: 'file', content: await readFile(child, 'utf8') });
        else result.set(childRelative, { kind: 'symlink' });
      }
    };
    await visit(directory, '');
    return result;
  }

  async inspectDesignDraft(missionId: string, revision: MissionWorkspaceRevision): Promise<DesignDraftInspection> {
    const workspace = this.missionWorkspacePath(missionId);
    const checkpoint = this.checkpointPath(missionId, revision.snapshotKey);
    const unauthorizedPaths: string[] = [];
    const invalidPaths: string[] = [];
    let current: Map<string, { kind: 'file' | 'directory' | 'symlink'; content?: string }>;
    let baseline: Map<string, { kind: 'file' | 'directory' | 'symlink'; content?: string }>;
    try { current = await this.collectPaths(workspace); baseline = await this.collectPaths(checkpoint); } catch { return { unauthorizedPaths: ['[workspace listing unavailable]'], invalidPaths: [], files: null, baselineMatches: false }; }
    const allPaths = new Set([...current.keys(), ...baseline.keys()]);
    for (const entry of allPaths) {
      const allowed = entry === '.conductor' || entry === '.conductor/design-draft' || ['.conductor/design-draft/index.html', '.conductor/design-draft/styles.css', '.conductor/design-draft/design-contract.json', '.conductor/design-draft/design-bundle.json'].includes(entry);
      const left = current.get(entry); const right = baseline.get(entry);
      if (!allowed && (left?.kind !== right?.kind || left?.content !== right?.content)) unauthorizedPaths.push(entry);
      if (left?.kind === 'symlink' || right?.kind === 'symlink') invalidPaths.push(entry);
    }
    const draftPrefix = '.conductor/design-draft/';
    for (const entry of current.keys()) if (entry.startsWith(draftPrefix) && entry !== '.conductor/design-draft' && !['.conductor/design-draft/index.html', '.conductor/design-draft/styles.css', '.conductor/design-draft/design-contract.json', '.conductor/design-draft/design-bundle.json'].includes(entry)) invalidPaths.push(entry);
    const files = {
      indexHtml: current.get(`${draftPrefix}index.html`)?.content,
      stylesCss: current.get(`${draftPrefix}styles.css`)?.content,
      contractJson: current.get(`${draftPrefix}design-contract.json`)?.content,
      bundleJson: current.get(`${draftPrefix}design-bundle.json`)?.content,
    };
    const hasBundle = typeof files.bundleJson === 'string';
    if (!hasBundle && typeof files.indexHtml !== 'string') invalidPaths.push(`${draftPrefix}index.html`);
    if (typeof files.stylesCss === 'string' && Buffer.byteLength(files.stylesCss, 'utf8') > 256 * 1024) invalidPaths.push(`${draftPrefix}styles.css`);
    if (!hasBundle && typeof files.contractJson !== 'string') invalidPaths.push(`${draftPrefix}design-contract.json`);
    if (typeof files.indexHtml === 'string' && Buffer.byteLength(files.indexHtml, 'utf8') > 256 * 1024) invalidPaths.push(`${draftPrefix}index.html`);
    if (!hasBundle && typeof files.stylesCss !== 'string') invalidPaths.push(`${draftPrefix}styles.css`);
    if (typeof files.contractJson === 'string' && Buffer.byteLength(files.contractJson, 'utf8') > 64 * 1024) invalidPaths.push(`${draftPrefix}design-contract.json`);
    if (typeof files.bundleJson === 'string' && Buffer.byteLength(files.bundleJson, 'utf8') > 768 * 1024) invalidPaths.push(`${draftPrefix}design-bundle.json`);
    const baselineMatches = await this.hashDirectory(checkpoint).then((hash) => hash === revision.contentHash).catch(() => false);
    return { unauthorizedPaths: [...new Set(unauthorizedPaths)].slice(0, 32), invalidPaths: [...new Set(invalidPaths)].slice(0, 32), files: invalidPaths.length ? null : { indexHtml: files.indexHtml ?? null, stylesCss: files.stylesCss ?? null, contractJson: files.contractJson ?? null, bundleJson: files.bundleJson ?? null }, baselineMatches };
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async writeInstructions(agent: Agent): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }
}
