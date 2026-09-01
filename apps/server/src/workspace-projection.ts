import { createHash } from 'node:crypto';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';

export const PROPOSAL_INVENTORY_LIMIT = 2_048;
export const AUTHORITATIVE_ENTRY_LIMIT = 20_000;
export const AUTHORITATIVE_FILE_LIMIT = 10_000;
export const AUTHORITATIVE_TOTAL_BYTES = 256 * 1024 * 1024;
export const AUTHORITATIVE_FILE_BYTES = 4 * 1024 * 1024;

const controlSegments = new Set(['.git', '.codex', '.conductor', 'node_modules', 'dist']);
const frontendExtensions = /\.(?:css|scss|sass|less|html|htm|jsx|tsx|vue|svelte|astro|hbs|handlebars|ejs|pug|njk|twig)$/i;
const scriptExtensions = /\.(?:js|ts|mjs|cjs)$/i;
const testFile = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:js|ts|mjs|cjs)$/i;
const strongFrontendSegments = /(?:^|\/)(?:pages?|views?|templates?|components?|layouts?|navigation|ui|client|browser|web)(?:\/|$)/i;
const contextualFrontendSegments = /(?:^|\/)(?:app|routes?)(?:\/|$)/i;
const frontendConfig = /(?:^|\/)(?:vite|webpack|next|nuxt|svelte|astro|angular|tailwind|postcss)\.config\.(?:js|ts|mjs|cjs)$/i;
const bootstrapName = /(?:^|\/)(?:main|app|index|bootstrap|router|routes?)\.(?:js|ts|mjs|cjs|jsx|tsx)$/i;
const backendSegments = /(?:^|\/)(?:server|backend|api|db|database|migrations?|scripts?|cli|docs?|tests?|__tests__)(?:\/|$)/i;
const manifestName = /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const frameworkPackages = new Set(['react', 'react-dom', 'vue', 'svelte', 'next', 'nuxt', '@angular/core', 'solid-js', 'vite', 'astro']);

export interface RepositoryFrameworkFacts {
  frontendPackages: string[];
  frontendRoots: string[];
  nonvisualPackages: string[];
  frontendConfigs: string[];
  bootstrapPaths: string[];
  factsComplete: boolean;
}

export interface WorkspaceProjection {
  contentHash: string;
  inventoryPaths: string[];
  inventoryTruncated: boolean;
  inventoryComplete: boolean;
  entryCount: number;
  fileCount: number;
  totalBytes: number;
  files: Map<string, { sha256: string; size: number }>;
  frameworkFacts: RepositoryFrameworkFacts;
}

export interface WorkspaceProjectionDiff {
  files: Array<{ path: string; operation: 'ADDED' | 'MODIFIED' | 'DELETED' }>;
  complete: boolean;
}

export function isGovernedWorkspacePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => controlSegments.has(segment))) return false;
  const name = segments.at(-1) ?? '';
  return name !== 'AGENTS.md' && name !== '.env' && !name.startsWith('.env.') && !name.endsWith('.log');
}

function portable(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > 256 || path.posix.isAbsolute(normalized) || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('Workspace contains an invalid path');
  return normalized;
}

function packageRoot(relativePath: string): string {
  const directory = path.posix.dirname(relativePath);
  return directory === '.' ? '' : directory;
}

function withinRoot(relativePath: string, root: string): boolean {
  return !root || relativePath === root || relativePath.startsWith(`${root}/`);
}

function mostSpecificOwner(relativePath: string, roots: readonly string[]): string | undefined {
  return roots.filter((rootPath) => withinRoot(relativePath, rootPath)).sort((left, right) => right.length - left.length)[0];
}

async function readStableBoundedFile(filePath: string, relativePath: string): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Workspace contains an unsupported entry: ${relativePath}`);
    if (before.size > AUTHORITATIVE_FILE_BYTES) throw new Error(`Workspace file exceeds the authoritative inspection bound: ${relativePath}`);
    const buffer = Buffer.allocUnsafe(AUTHORITATIVE_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead > AUTHORITATIVE_FILE_BYTES) throw new Error(`Workspace file exceeds the authoritative inspection bound: ${relativePath}`);
    const after = await handle.stat();
    const pathAfter = await lstat(filePath);
    if (!pathAfter.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino || before.size !== after.size || bytesRead !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`Workspace file changed during authoritative inspection: ${relativePath}`);
    return Buffer.from(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function inspectWorkspaceProjection(root: string, inventoryLimit = PROPOSAL_INVENTORY_LIMIT): Promise<WorkspaceProjection> {
  if (!path.isAbsolute(root)) throw new Error('Workspace root must be absolute');
  const hash = createHash('sha256');
  const inventoryPaths: string[] = [];
  const files = new Map<string, { sha256: string; size: number }>();
  const frontendPackages = new Set<string>();
  const nonvisualPackages = new Set<string>();
  const frontendConfigs = new Set<string>();
  const bootstrapPaths = new Set<string>();
  let entryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;
  let inventoryTruncated = false;

  const visit = async (relative: string): Promise<void> => {
    const directory = relative ? path.join(root, relative) : root;
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = portable(relative ? `${relative}/${entry.name}` : entry.name);
      if (!isGovernedWorkspacePath(child)) continue;
      entryCount += 1;
      if (entryCount > AUTHORITATIVE_ENTRY_LIMIT) throw new Error('Workspace exceeds the authoritative inspection entry bound');
      if (inventoryPaths.length < inventoryLimit) inventoryPaths.push(child);
      else inventoryTruncated = true;
      const info = await lstat(path.join(root, child));
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(`Workspace contains an unsupported entry: ${child}`);
      if (info.isDirectory()) {
        hash.update(`dir:${child}\n`);
        await visit(child);
        continue;
      }
      fileCount += 1;
      if (fileCount > AUTHORITATIVE_FILE_LIMIT) throw new Error('Workspace exceeds the authoritative inspection file bound');
      if (info.size > AUTHORITATIVE_FILE_BYTES) throw new Error(`Workspace file exceeds the authoritative inspection bound: ${child}`);
      const bytes = await readStableBoundedFile(path.join(root, child), child);
      totalBytes += bytes.byteLength;
      if (totalBytes > AUTHORITATIVE_TOTAL_BYTES) throw new Error('Workspace exceeds the authoritative inspection byte bound');
      const fileHash = createHash('sha256').update(bytes).digest('hex');
      files.set(child, { sha256: fileHash, size: bytes.byteLength });
      hash.update(`file:${child}\n`);
      hash.update(bytes);
      if (frontendConfig.test(child)) frontendConfigs.add(child);
      if (bootstrapName.test(child)) bootstrapPaths.add(child);
      if (path.posix.basename(child) === 'package.json' && bytes.byteLength <= 64 * 1024) {
        try {
          const manifest = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
          const dependencies = { ...(manifest.dependencies as Record<string, unknown> | undefined), ...(manifest.devDependencies as Record<string, unknown> | undefined) };
          const rootPath = packageRoot(child);
          const hasFrontendFramework = Object.keys(dependencies).some((name) => frameworkPackages.has(name));
          if (hasFrontendFramework) frontendPackages.add(rootPath);
          else if (typeof manifest.bin === 'string' || (manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin))) nonvisualPackages.add(rootPath);
        } catch { /* Malformed manifests remain ambiguous during path classification. */ }
      }
    }
  };
  await visit('');
  const frontendRoots = new Set<string>(frontendPackages);
  for (const candidate of frontendConfigs) {
    const owner = mostSpecificOwner(candidate, [...frontendPackages]);
    frontendRoots.add(owner ?? packageRoot(candidate));
  }
  return {
    contentHash: hash.digest('hex'), inventoryPaths, inventoryTruncated, inventoryComplete: !inventoryTruncated,
    entryCount, fileCount, totalBytes, files,
    frameworkFacts: {
      frontendPackages: [...frontendPackages].sort(),
      frontendRoots: [...frontendRoots].sort(),
      nonvisualPackages: [...nonvisualPackages].sort(),
      frontendConfigs: [...frontendConfigs].sort(),
      bootstrapPaths: [...bootstrapPaths].sort(),
      factsComplete: true,
    },
  };
}

export function compareWorkspaceProjections(before: WorkspaceProjection, after: WorkspaceProjection): WorkspaceProjectionDiff {
  const paths = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
  const changes: WorkspaceProjectionDiff['files'] = [];
  for (const file of paths) {
    const left = before.files.get(file);
    const right = after.files.get(file);
    if (!left && right) changes.push({ path: file, operation: 'ADDED' });
    else if (left && !right) changes.push({ path: file, operation: 'DELETED' });
    else if (left?.sha256 !== right?.sha256) changes.push({ path: file, operation: 'MODIFIED' });
  }
  return { files: changes, complete: before.frameworkFacts.factsComplete && after.frameworkFacts.factsComplete };
}

export function classifyChangedPath(relativePath: string, facts: RepositoryFrameworkFacts): 'frontend' | 'nonvisual' | 'ambiguous' {
  const normalized = relativePath.replaceAll('\\', '/');
  if (frontendExtensions.test(normalized) || strongFrontendSegments.test(normalized) || frontendConfig.test(normalized)) return 'frontend';
  if (facts.frontendConfigs.includes(normalized)) return 'frontend';

  const frontendOwner = mostSpecificOwner(normalized, facts.frontendRoots);
  if (frontendOwner !== undefined && (scriptExtensions.test(normalized) || manifestName.test(normalized) || contextualFrontendSegments.test(normalized) || facts.bootstrapPaths.includes(normalized))) return 'frontend';

  const nonvisualOwner = mostSpecificOwner(normalized, facts.nonvisualPackages);
  if (nonvisualOwner !== undefined && manifestName.test(normalized)) return 'nonvisual';
  if (nonvisualOwner !== undefined && facts.bootstrapPaths.includes(normalized)) return 'nonvisual';
  if (testFile.test(normalized)) return 'nonvisual';
  if (backendSegments.test(normalized)) return 'nonvisual';
  if (scriptExtensions.test(normalized)) return 'ambiguous';
  if (/\.(?:json|yaml|yml|toml)$/i.test(normalized)) return 'ambiguous';
  return /\.(?:md|txt|sql)$/i.test(normalized) ? 'nonvisual' : 'ambiguous';
}

export function classifyWorkspaceDiff(diff: WorkspaceProjectionDiff, facts: RepositoryFrameworkFacts): { decision: 'nonvisual' | 'governed' | 'uncertain'; reason: string } {
  if (!diff.complete) return { decision: 'uncertain', reason: 'Conductor could not establish the complete workspace changes.' };
  for (const change of diff.files) {
    const classification = classifyChangedPath(change.path, facts);
    if (classification === 'frontend') return { decision: 'governed', reason: `The actual changes affect a user-facing path: ${change.path}` };
  }
  const ambiguous = diff.files.find((change) => classifyChangedPath(change.path, facts) === 'ambiguous');
  if (ambiguous) return { decision: 'uncertain', reason: `Conductor cannot prove that this changed path is non-UI work: ${ambiguous.path}` };
  return { decision: 'nonvisual', reason: 'The complete changes contain only repository-proven non-UI work.' };
}
