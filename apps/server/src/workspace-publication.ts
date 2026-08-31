import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { inspectWorkspaceProjection, isGovernedWorkspacePath, type WorkspaceProjection } from './workspace-projection.js';

const transactionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const preservedAgentNames = new Set(['.git', '.codex', '.conductor', 'AGENTS.md']);

export interface WorkspacePublicationReceipt {
  transactionId: string;
  previousHash: string;
  publishedHash: string;
}

export interface WorkspacePublicationRecovery {
  state: 'published' | 'original' | 'ambiguous';
  contentHash: string | null;
}

async function exists(directory: string): Promise<boolean> {
  return stat(directory).then((value) => value.isDirectory()).catch(() => false);
}

async function copyGovernedTree(sourceRoot: string, destinationRoot: string, relative = ''): Promise<void> {
  const directory = relative ? path.join(sourceRoot, relative) : sourceRoot;
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = (relative ? `${relative}/${entry.name}` : entry.name).replaceAll('\\', '/');
    if (!isGovernedWorkspacePath(child)) continue;
    const source = path.join(sourceRoot, child);
    const destination = path.join(destinationRoot, child);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`Workspace publication source contains an unsupported entry: ${child}`);
    if (entry.isDirectory()) {
      await mkdir(destination, { recursive: false });
      await copyGovernedTree(sourceRoot, destinationRoot, child);
    } else {
      await cp(source, destination, { force: false, errorOnExist: true });
    }
  }
}

async function copyAgentControlState(agentRoot: string, destinationRoot: string): Promise<void> {
  for (const entry of await readdir(agentRoot, { withFileTypes: true })) {
    const preserved = preservedAgentNames.has(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.');
    if (!preserved) continue;
    const source = path.join(agentRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    await cp(source, destination, { recursive: entry.isDirectory(), verbatimSymlinks: true, force: false, errorOnExist: true });
  }
}

export class WorkspacePublisher {
  constructor(private readonly workspaceRoot: string) {}

  private candidateRoot(admissionId: string): string {
    if (!transactionIdPattern.test(admissionId)) throw new Error('Invalid workspace candidate ID');
    return path.join(this.workspaceRoot, '.playground-candidates', admissionId);
  }

  candidatePathFor(admissionId: string): string { return this.candidateRoot(admissionId); }

  private transactionRoot(transactionId: string): string {
    if (!transactionIdPattern.test(transactionId)) throw new Error('Invalid workspace publication ID');
    return path.join(this.workspaceRoot, '.workspace-publications', transactionId);
  }

  async createCandidate(agentRoot: string, admissionId: string, expectedHash: string): Promise<{ path: string; projection: WorkspaceProjection }> {
    const original = await inspectWorkspaceProjection(agentRoot);
    if (original.contentHash !== expectedHash) throw new Error('Agent workspace changed before candidate staging');
    const candidate = this.candidateRoot(admissionId);
    await rm(candidate, { recursive: true, force: true });
    await mkdir(candidate, { recursive: true });
    try {
      await copyGovernedTree(agentRoot, candidate);
      const agentsFile = path.join(agentRoot, 'AGENTS.md');
      if (await stat(agentsFile).then((value) => value.isFile()).catch(() => false)) await cp(agentsFile, path.join(candidate, 'AGENTS.md'), { force: false, errorOnExist: true });
      const finalOriginal = await inspectWorkspaceProjection(agentRoot);
      const projection = await inspectWorkspaceProjection(candidate);
      if (finalOriginal.contentHash !== expectedHash || projection.contentHash !== expectedHash) throw new Error('Agent workspace changed during candidate staging');
      return { path: candidate, projection };
    } catch (error) {
      await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async inspectCandidate(admissionId: string): Promise<WorkspaceProjection> {
    return inspectWorkspaceProjection(this.candidateRoot(admissionId));
  }

  async discardCandidate(admissionId: string): Promise<void> {
    await rm(this.candidateRoot(admissionId), { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
  }

  async publish(input: { transactionId: string; sourceRoot: string; agentRoot: string; expectedAgentHash: string; expectedSourceHash: string }): Promise<WorkspacePublicationReceipt> {
    const transaction = this.transactionRoot(input.transactionId);
    const prepared = path.join(transaction, 'prepared');
    const backup = path.join(transaction, 'backup');
    await mkdir(transaction, { recursive: true });

    const current = await inspectWorkspaceProjection(input.agentRoot);
    if (current.contentHash !== input.expectedAgentHash) throw new Error('Agent workspace changed before publication');
    const source = await inspectWorkspaceProjection(input.sourceRoot);
    if (source.contentHash !== input.expectedSourceHash) throw new Error('Workspace publication source does not match its authoritative revision');

    if (!await exists(prepared)) {
      await mkdir(prepared, { recursive: false });
      try {
        await copyGovernedTree(input.sourceRoot, prepared);
        await copyAgentControlState(input.agentRoot, prepared);
      } catch (error) {
        await rm(prepared, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }
    const finalSource = await inspectWorkspaceProjection(input.sourceRoot);
    if (finalSource.contentHash !== input.expectedSourceHash) throw new Error('Workspace publication source changed during preparation');
    const preparedProjection = await inspectWorkspaceProjection(prepared);
    if (preparedProjection.contentHash !== input.expectedSourceHash) throw new Error('Prepared workspace publication failed integrity validation');
    if ((await inspectWorkspaceProjection(input.agentRoot)).contentHash !== input.expectedAgentHash) throw new Error('Agent workspace changed during publication preparation');

    let oldMoved = false;
    try {
      if (!await exists(backup)) {
        await rename(input.agentRoot, backup);
        oldMoved = true;
      }
      await rename(prepared, input.agentRoot);
      const published = await inspectWorkspaceProjection(input.agentRoot);
      if (published.contentHash !== input.expectedSourceHash) throw new Error('Published Agent workspace failed integrity validation');
      return { transactionId: input.transactionId, previousHash: input.expectedAgentHash, publishedHash: published.contentHash };
    } catch (error) {
      if (!await exists(input.agentRoot) && await exists(backup)) await rename(backup, input.agentRoot).catch(() => undefined);
      else if (oldMoved && await exists(input.agentRoot) && await exists(backup)) {
        const live = await inspectWorkspaceProjection(input.agentRoot).catch(() => null);
        if (live?.contentHash !== input.expectedSourceHash) {
          await rm(input.agentRoot, { recursive: true, force: true }).catch(() => undefined);
          await rename(backup, input.agentRoot).catch(() => undefined);
        }
      }
      throw error;
    }
  }

  async finalize(transactionId: string): Promise<void> {
    await rm(this.transactionRoot(transactionId), { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
  }

  async recover(input: { transactionId: string; agentRoot: string; expectedAgentHash: string; expectedPublishedHash: string }): Promise<WorkspacePublicationRecovery> {
    const transaction = this.transactionRoot(input.transactionId);
    const backup = path.join(transaction, 'backup');
    const live = await inspectWorkspaceProjection(input.agentRoot).catch(() => null);
    if (live?.contentHash === input.expectedPublishedHash) return { state: 'published', contentHash: live.contentHash };
    if (live?.contentHash === input.expectedAgentHash) return { state: 'original', contentHash: live.contentHash };
    if (!live && await exists(backup)) {
      const saved = await inspectWorkspaceProjection(backup).catch(() => null);
      if (saved?.contentHash === input.expectedAgentHash) {
        await rename(backup, input.agentRoot);
        return { state: 'original', contentHash: saved.contentHash };
      }
    }
    return { state: 'ambiguous', contentHash: live?.contentHash ?? null };
  }
}
