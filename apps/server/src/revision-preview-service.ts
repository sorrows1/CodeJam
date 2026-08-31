import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JsonStore } from './store.js';
import type { DesignReferenceStore } from './design-reference-store.js';
import { resolveDesignReferenceMaterialization } from './design-reference-store.js';
import type { MissionWorkspacePort } from './workspace.js';
import { findReservingMission } from './mission-state.js';
import { parseDesignPackage } from './design-package.js';
import { loadPreviewDataContract, type PreviewDataContract } from './preview-data-contract.js';
import {
  buildPreviewContainerArgs,
  buildPreviewSecurityHeaders,
  detectPreviewProfile,
  isPreviewAssetPathAllowed,
  isAllowedPreviewRoute,
  isPreviewSourcePathAllowed,
  MAX_PREVIEW_FILE_BYTES,
  MAX_PREVIEW_FILES,
  MAX_PREVIEW_TOTAL_BYTES,
  PREVIEW_CONTAINER_LABEL,
  resolvePreviewAsset,
  rewriteStaticPreviewCss,
  rewriteStaticPreviewHtml,
  type PreviewProfile,
} from './revision-preview.js';

const TTL_MS = 5 * 60 * 1000;
const MAX_ASSET_BYTES = MAX_PREVIEW_FILE_BYTES;
const MAX_SOURCE_ENTRIES = 2_048;
const MAX_ENGINE_STDOUT_BYTES = Math.ceil(MAX_PREVIEW_TOTAL_BYTES * 4 / 3) + 256 * 1024;
const MAX_ENGINE_STDERR_BYTES = 4_096;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const containerId = /^[0-9a-f]{12,64}$/i;

export type PreviewTarget = { kind: 'design'; revisionId: string } | { kind: 'workspace'; revisionId: string; designRevisionId?: string } | { kind: 'agent'; workspaceHash: string };
export interface PreviewRuntime {
  initialize?(): Promise<void>;
  prepare(input: { sourceRoot: string; outputRoot: string; profile: Exclude<PreviewProfile, 'static-html'> }): Promise<void>;
  shutdown?(): Promise<void>;
}
export interface PreviewSessionView { id: string; missionId: string; target: PreviewTarget; profile: PreviewProfile; contentPath: string; expiresAt: string; previewDataHash: string | null; }
type Session = PreviewSessionView & { root: string; tokenHash: Buffer; allowedRoutes: string[]; previewData: PreviewDataContract | null };
type Reservation = { id: string; missionId: string };

export interface PreviewEngineProcess {
  run(args: readonly string[], options: { timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number }): Promise<{ code: number; stdout: string; stderr: string }>;
}

class SpawnPreviewEngineProcess implements PreviewEngineProcess {
  constructor(private readonly engine: string) {}
  async run(args: readonly string[], options: { timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number }): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.engine, [...args], { env: {}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (callback: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); callback(); };
      const append = (current: string, chunk: Buffer | string, maximum: number, label: string): string => {
        const next = current + String(chunk);
        if (Buffer.byteLength(next, 'utf8') > maximum) { child.kill(); throw new Error(`Preview engine ${label} exceeded the bound`); }
        return next;
      };
      child.stdout?.on('data', (chunk) => { try { stdout = append(stdout, chunk, options.maxStdoutBytes, 'output'); } catch (error) { finish(() => reject(error)); } });
      child.stderr?.on('data', (chunk) => { try { stderr = append(stderr, chunk, options.maxStderrBytes, 'error output'); } catch (error) { finish(() => reject(error)); } });
      child.once('error', (error) => finish(() => reject(error)));
      child.once('close', (code) => finish(() => resolve({ code: code ?? -1, stdout, stderr })));
      const timer = setTimeout(() => { child.kill(); finish(() => reject(new Error('Preview engine command timed out'))); }, options.timeoutMs);
    });
  }
}

type SerializedPreviewOutput = { files: Array<{ path: string; content: string }> };

export class ContainerRevisionPreviewRuntime implements PreviewRuntime {
  private readonly process: PreviewEngineProcess;
  private readonly active = new Set<string>();
  constructor(private readonly options: { engine: string; image: string; user: string; timeoutMs?: number; cpuLimit?: number; memoryLimit?: string; pidsLimit?: number; process?: PreviewEngineProcess }) {
    this.process = options.process ?? new SpawnPreviewEngineProcess(options.engine);
  }

  async initialize(): Promise<void> {
    let listed: { code: number; stdout: string; stderr: string };
    try { listed = await this.process.run(['ps', '--all', '--quiet', '--filter', `label=${PREVIEW_CONTAINER_LABEL}`], { timeoutMs: 10_000, maxStdoutBytes: 8_192, maxStderrBytes: MAX_ENGINE_STDERR_BYTES }); }
    catch { return; }
    if (listed.code !== 0) return;
    const ids = listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (!ids.every((value) => containerId.test(value))) return;
    await Promise.all(ids.map((id) => this.forceRemove(id)));
  }

  async prepare(input: { sourceRoot: string; outputRoot: string; profile: Exclude<PreviewProfile, 'static-html'> }): Promise<void> {
    const identity = `conductor-preview-${randomUUID()}`;
    const cidFile = `${input.outputRoot}.cid`;
    const args = buildPreviewContainerArgs({ sourceRoot: input.sourceRoot, cidFile, identity, image: this.options.image, user: this.options.user, ...(this.options.cpuLimit === undefined ? {} : { cpuLimit: this.options.cpuLimit }), ...(this.options.memoryLimit === undefined ? {} : { memoryLimit: this.options.memoryLimit }), ...(this.options.pidsLimit === undefined ? {} : { pidsLimit: this.options.pidsLimit }) });
    this.active.add(identity);
    let succeeded = false;
    try {
      const result = await this.process.run(args, { timeoutMs: Math.min(this.options.timeoutMs ?? 60_000, 120_000), maxStdoutBytes: MAX_ENGINE_STDOUT_BYTES, maxStderrBytes: MAX_ENGINE_STDERR_BYTES });
      if (result.code !== 0) throw new Error(`Preview preparation failed (${result.code}): ${result.stderr}`);
      await this.realizeOutput(result.stdout, input.outputRoot);
      succeeded = true;
    } finally {
      if (!succeeded) await this.forceRemove(identity);
      this.active.delete(identity);
      await rm(cidFile, { force: true }).catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    const active = [...this.active];
    this.active.clear();
    await Promise.all(active.map((identity) => this.forceRemove(identity)));
  }

  private async forceRemove(identity: string): Promise<void> {
    if (!containerId.test(identity) && !/^conductor-preview-[0-9a-f-]{36}$/i.test(identity)) return;
    await this.process.run(['rm', '--force', identity], { timeoutMs: 10_000, maxStdoutBytes: 1_024, maxStderrBytes: MAX_ENGINE_STDERR_BYTES }).catch(() => undefined);
  }

  private async realizeOutput(serialized: string, outputRoot: string): Promise<void> {
    let parsed: SerializedPreviewOutput;
    try { parsed = JSON.parse(serialized) as SerializedPreviewOutput; } catch { throw new Error('Preview preparation returned invalid output'); }
    if (!parsed || !Array.isArray(parsed.files) || parsed.files.length === 0 || parsed.files.length > MAX_PREVIEW_FILES) throw new Error('Preview preparation returned invalid output');
    await mkdir(outputRoot, { recursive: false });
    let totalBytes = 0;
    const seen = new Set<string>();
    for (const file of parsed.files) {
      if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('Preview preparation returned invalid output');
      const normalized = file.path.replaceAll('\\', '/');
      if (seen.has(normalized) || Buffer.byteLength(normalized, 'utf8') > 256 || !isPreviewAssetPathAllowed(normalized)) throw new Error('Preview preparation returned invalid output');
      const target = path.resolve(outputRoot, normalized);
      const relative = path.relative(outputRoot, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Preview preparation returned invalid output');
      const bytes = decodeBoundedBase64(file.content);
      totalBytes += bytes.byteLength;
      if (bytes.byteLength > MAX_PREVIEW_FILE_BYTES || totalBytes > MAX_PREVIEW_TOTAL_BYTES) throw new Error('Preview output exceeds bound');
      seen.add(normalized);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
  }
}

function decodeBoundedBase64(value: string): Buffer {
  if (value.length > Math.ceil(MAX_PREVIEW_FILE_BYTES * 4 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Preview output exceeds bound');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Preview preparation returned invalid output');
  return bytes;
}

export class RevisionPreviewService {
  private readonly sessions = new Map<string, Session>();
  private readonly reservations = new Map<string, Reservation>();
  constructor(
    private readonly store: JsonStore,
    private readonly workspaces: MissionWorkspacePort,
    private readonly references: DesignReferenceStore,
    private readonly runtime: PreviewRuntime,
    private readonly root: string,
    private readonly now: () => number = Date.now,
    private readonly sensitiveValues: readonly string[] = [],
  ) {}

  async initialize(): Promise<void> {
    await this.runtime.initialize?.();
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) if (entry.isDirectory() && /^(?:preview|\.tmp)-[0-9a-f-]{36}$/i.test(entry.name)) await rm(path.join(this.root, entry.name), { recursive: true, force: true });
  }

  private expire(): Promise<void> {
    const expired: Session[] = [];
    for (const [id, session] of this.sessions) if (Date.parse(session.expiresAt) <= this.now()) { this.sessions.delete(id); expired.push(session); }
    return Promise.all(expired.map((session) => rm(session.root, { recursive: true, force: true }))).then(() => undefined);
  }

  async activeForMission(missionId: string): Promise<PreviewSessionView | null> {
    if (!uuid.test(missionId)) throw new Error('Invalid preview target');
    await this.expire();
    const session = [...this.sessions.values()].find((item) => item.missionId === missionId) ?? null;
    return session ? this.view(session) : null;
  }

  async create(missionId: string, target: PreviewTarget): Promise<{ session: PreviewSessionView; token: string }> {
    if (target.kind === 'agent' || !uuid.test(missionId) || !uuid.test(target.revisionId) || (target.kind === 'workspace' && target.designRevisionId !== undefined && !uuid.test(target.designRevisionId))) throw new Error('Invalid preview target');
    await this.expire();
    if ([...this.reservations.values()].some((item) => item.missionId === missionId)) throw new Error('Preview session is already starting');
    const existing = [...this.sessions.values()].find((item) => item.missionId === missionId) ?? null;
    if (existing && existing.target.kind !== 'agent' && existing.target.kind === target.kind && existing.target.revisionId === target.revisionId && (target.kind !== 'workspace' || existing.target.kind !== 'workspace' || existing.target.designRevisionId === target.designRevisionId)) {
      const token = randomBytes(32).toString('base64url');
      existing.tokenHash = createHash('sha256').update(token).digest();
      existing.expiresAt = new Date(this.now() + TTL_MS).toISOString();
      return { session: this.view(existing), token };
    }
    if (existing) {
      this.sessions.delete(existing.id);
      await rm(existing.root, { recursive: true, force: true });
    }
    if (this.sessions.size + this.reservations.size >= 2) throw new Error('Preview session limit reached');
    const id = randomUUID();
    this.reservations.set(id, { id, missionId });
    const temporary = path.join(this.root, `.tmp-${id}`);
    const output = path.join(this.root, `preview-${id}`);
    let profile: PreviewProfile;
    let allowedRoutes: string[] = [];
    let previewData: PreviewDataContract | null = null;
    try {
      const database = this.store.snapshot();
      if (!database.missions.some((item) => item.id === missionId)) throw new Error('Mission not found');
      await mkdir(temporary, { recursive: false });
      if (target.kind === 'design') {
        const revision = database.designRevisions.find((item) => item.id === target.revisionId && item.missionId === missionId);
        if (!revision) throw new Error('DesignRevision not found');
        const materialization = resolveDesignReferenceMaterialization({ revision, artifacts: database.missionArtifacts });
        if (!materialization.ok || !await this.references.verify(materialization.materialization)) throw new Error('DesignRevision integrity failed');
        const realized = path.join(temporary, 'source');
        await mkdir(realized);
        const html = await this.references.read(materialization.materialization.preview, 256 * 1024);
        await writeFile(path.join(realized, 'index.html'), html, { flag: 'wx', mode: 0o600 });
        if (!await this.references.verify(materialization.materialization)) throw new Error('DesignRevision integrity failed');
        profile = 'static-html';
        await rename(realized, output);
      } else {
        const revision = database.missionWorkspaceRevisions.find((item) => item.id === target.revisionId && item.missionId === missionId);
        if (!revision) throw new Error('Workspace revision not found');
        if (target.designRevisionId) {
          const designRevision = database.designRevisions.find((item) => item.id === target.designRevisionId && item.missionId === missionId);
          if (!designRevision) throw new Error('DesignRevision not found');
          const exactPairExists = database.verificationRuns.some((item) => item.missionId === missionId && item.designRevisionId === designRevision.id && item.workspaceRevisionId === revision.id)
            || database.missionTasks.some((item) => item.missionId === missionId && item.inputDesignRevisionId === designRevision.id && item.outputWorkspaceRevisionId === revision.id);
          if (!exactPairExists) throw new Error('Workspace revision is not bound to the requested DesignRevision');
          const materialization = resolveDesignReferenceMaterialization({ revision: designRevision, artifacts: database.missionArtifacts });
          if (!materialization.ok || !await this.references.verify(materialization.materialization)) throw new Error('DesignRevision integrity failed');
          const packageValue = parseDesignPackage(await this.references.read(materialization.materialization.package, 768 * 1024));
          allowedRoutes = packageValue.surfaces.map((surface) => surface.route);
        }
        const source = await this.workspaces.resolveMissionRevision(missionId, revision);
        previewData = await loadPreviewDataContract(source, this.sensitiveValues);
        allowedRoutes = [...new Set([...allowedRoutes, ...(previewData?.routes ?? [])])];
        const realized = path.join(temporary, 'source');
        await mkdir(realized);
        await this.realizeWebSource(source, realized);
        profile = await detectPreviewProfile(realized);
        if (profile === 'static-html') await rename(realized, output);
        else {
          const built = path.join(temporary, 'output');
          await this.runtime.prepare({ sourceRoot: realized, outputRoot: built, profile });
          await rename(built, output);
        }
        await this.workspaces.resolveMissionRevision(missionId, revision);
      }
      if (!await stat(path.join(output, 'index.html')).then((value) => value.isFile()).catch(() => false)) throw new Error('Preview output is missing index.html');
      await rm(temporary, { recursive: true, force: true });
      const token = randomBytes(32).toString('base64url');
      const session: Session = { id, missionId, target: { ...target }, profile, contentPath: `/api/missions/${missionId}/previews/${id}/content/`, expiresAt: new Date(this.now() + TTL_MS).toISOString(), previewDataHash: previewData?.hash ?? null, root: output, tokenHash: createHash('sha256').update(token).digest(), allowedRoutes, previewData };
      this.sessions.set(id, session);
      return { session: this.view(session), token };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
      throw error;
    } finally {
      this.reservations.delete(id);
    }
  }

  async createAgent(agentId: string): Promise<{ session: PreviewSessionView; token: string }> {
    if (!uuid.test(agentId)) throw new Error('Invalid preview target');
    await this.expire();
    if ([...this.reservations.values()].some((item) => item.missionId === agentId)) throw new Error('Preview session is already starting');
    const database = this.store.snapshot();
    const agent = database.agents.find((item) => item.id === agentId);
    if (!agent) throw new Error('Agent not found');
    if (agent.status !== 'ready' || findReservingMission(database.missions, agentId)) throw new Error('Agent workspace is not ready to preview');
    if (database.playgroundImpactAdmissions.some((item) => item.agentId === agentId && ['planning', 'confirmation_required', 'staging', 'publishing', 'promoting'].includes(item.status))) throw new Error('Agent workspace is not ready to preview');
    const workspaceHash = await this.workspaces.fingerprintAgentWorkspace(agentId);
    const existing = [...this.sessions.values()].find((item) => item.missionId === agentId) ?? null;
    if (existing?.target.kind === 'agent' && existing.target.workspaceHash === workspaceHash) {
      const token = randomBytes(32).toString('base64url');
      existing.tokenHash = createHash('sha256').update(token).digest();
      existing.expiresAt = new Date(this.now() + TTL_MS).toISOString();
      return { session: this.view(existing), token };
    }
    if (existing) {
      this.sessions.delete(existing.id);
      await rm(existing.root, { recursive: true, force: true });
    }
    if (this.sessions.size + this.reservations.size >= 2) throw new Error('Preview session limit reached');
    const id = randomUUID();
    this.reservations.set(id, { id, missionId: agentId });
    const temporary = path.join(this.root, `.tmp-${id}`);
    const output = path.join(this.root, `preview-${id}`);
    try {
      await mkdir(temporary, { recursive: false });
      const source = this.workspaces.workspacePath(agentId);
      const previewData = await loadPreviewDataContract(source, this.sensitiveValues);
      const allowedRoutes = [...new Set(previewData?.routes ?? [])];
      const realized = path.join(temporary, 'source');
      await mkdir(realized);
      await this.realizeWebSource(source, realized);
      const profile = await detectPreviewProfile(realized);
      if (profile === 'static-html') await rename(realized, output);
      else {
        const built = path.join(temporary, 'output');
        await this.runtime.prepare({ sourceRoot: realized, outputRoot: built, profile });
        await rename(built, output);
      }
      if (await this.workspaces.fingerprintAgentWorkspace(agentId) !== workspaceHash) throw new Error('Agent workspace changed during preview preparation');
      if (!await stat(path.join(output, 'index.html')).then((value) => value.isFile()).catch(() => false)) throw new Error('Preview output is missing index.html');
      await rm(temporary, { recursive: true, force: true });
      const token = randomBytes(32).toString('base64url');
      const session: Session = { id, missionId: agentId, target: { kind: 'agent', workspaceHash }, profile, contentPath: `/api/agents/${agentId}/previews/${id}/content/`, expiresAt: new Date(this.now() + TTL_MS).toISOString(), previewDataHash: previewData?.hash ?? null, root: output, tokenHash: createHash('sha256').update(token).digest(), allowedRoutes, previewData };
      this.sessions.set(id, session);
      return { session: this.view(session), token };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
      throw error;
    } finally {
      this.reservations.delete(id);
    }
  }

  private async realizeWebSource(sourceRoot: string, destinationRoot: string): Promise<void> {
    let entriesSeen = 0;
    let files = 0;
    let totalBytes = 0;
    const secretValues = this.sensitiveValues.filter((value) => value.length >= 4).map((value) => value.toLowerCase());
    const visit = async (relative: string): Promise<void> => {
      const directory = relative ? path.join(sourceRoot, relative) : sourceRoot;
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
        entriesSeen += 1;
        if (entriesSeen > MAX_SOURCE_ENTRIES) throw new Error('Preview source exceeds the entry bound');
        const portable = (relative ? `${relative}/${entry.name}` : entry.name).replaceAll('\\', '/');
        if (Buffer.byteLength(portable, 'utf8') > 256 || secretValues.some((secret) => portable.toLowerCase().includes(secret))) continue;
        const source = path.join(sourceRoot, portable);
        const info = await lstat(source);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('Preview source contains an unsupported entry');
        if (info.isDirectory()) {
          const first = portable.split('/')[0]!;
          if (!isPreviewSourcePathAllowed(`${portable}/placeholder.js`) && !['src', 'public', 'assets'].includes(first)) continue;
          await visit(portable);
          continue;
        }
        if (!isPreviewSourcePathAllowed(portable)) continue;
        files += 1;
        totalBytes += info.size;
        if (files > MAX_PREVIEW_FILES || info.size > MAX_PREVIEW_FILE_BYTES || totalBytes > MAX_PREVIEW_TOTAL_BYTES) throw new Error('Preview source exceeds the content bound');
        const destination = path.join(destinationRoot, portable);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(source, destination);
      }
    };
    await visit('');
  }

  async get(missionId: string, sessionId: string): Promise<PreviewSessionView> {
    await this.expire();
    const session = this.sessions.get(sessionId);
    if (!session || session.missionId !== missionId) throw new Error('Preview session not found');
    return this.view(session);
  }

  async stop(missionId: string, sessionId: string): Promise<void> {
    await this.expire();
    const session = this.sessions.get(sessionId);
    if (!session || session.missionId !== missionId) throw new Error('Preview session not found');
    this.sessions.delete(sessionId);
    await rm(session.root, { recursive: true, force: true });
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.reservations.clear();
    await Promise.all(sessions.map((session) => rm(session.root, { recursive: true, force: true })));
    await this.runtime.shutdown?.();
  }

  async asset(missionId: string, sessionId: string, token: string, requestPath: string): Promise<{ bytes: Buffer; mediaType: string; headers: ReturnType<typeof buildPreviewSecurityHeaders>; status?: number }> {
    await this.expire();
    const session = this.sessions.get(sessionId);
    if (!session || session.missionId !== missionId) throw new Error('Preview session not found');
    const candidate = createHash('sha256').update(token).digest();
    if (candidate.length !== session.tokenHash.length || !timingSafeEqual(candidate, session.tokenHash)) throw new Error('Preview session authentication failed');
    const mockId = requestPath.match(/^__conductor_mock\/([a-z0-9][a-z0-9-]{0,63})$/)?.[1];
    const mock = mockId ? session.previewData?.mocks.find((item) => item.id === mockId) : null;
    if (mock) return { bytes: Buffer.from(mock.body, 'utf8'), mediaType: 'application/json; charset=utf-8', headers: buildPreviewSecurityHeaders(), status: mock.status };
    let file: string;
    try { file = resolvePreviewAsset(session.root, requestPath); }
    catch (error) {
      if (!isAllowedPreviewRoute(requestPath, session.allowedRoutes)) throw error;
      file = path.join(session.root, 'index.html');
    }
    let cursor = session.root;
    for (const segment of path.relative(session.root, file).split(path.sep)) { cursor = path.join(cursor, segment); if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Preview asset unavailable'); }
    const handle = await open(file, 'r');
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_ASSET_BYTES) throw new Error('Preview asset unavailable');
      bytes = Buffer.alloc(info.size);
      const read = await handle.read(bytes, 0, info.size, 0);
      if (read.bytesRead !== info.size) throw new Error('Preview asset unavailable');
    } finally { await handle.close(); }
    const extension = path.extname(file).toLowerCase();
    if (session.target.kind !== 'design') {
      if (extension === '.html') {
        let html = session.profile === 'static-html' ? rewriteStaticPreviewHtml(bytes.toString('utf8'), session.contentPath) : bytes.toString('utf8');
        if (session.previewData?.mocks.length) html = this.injectPreviewDataAdapter(html, session);
        bytes = Buffer.from(html, 'utf8');
      }
      if (session.profile === 'static-html' && extension === '.css') bytes = Buffer.from(rewriteStaticPreviewCss(bytes.toString('utf8'), session.contentPath), 'utf8');
      if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error('Preview asset unavailable');
    }
    const mediaType = extension === '.html' ? 'text/html; charset=utf-8' : extension === '.js' || extension === '.mjs' ? 'text/javascript; charset=utf-8' : extension === '.css' ? 'text/css; charset=utf-8' : extension === '.svg' ? 'image/svg+xml' : extension === '.png' ? 'image/png' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.gif' ? 'image/gif' : extension === '.webp' ? 'image/webp' : extension === '.ico' ? 'image/x-icon' : extension === '.woff' ? 'font/woff' : 'font/woff2';
    return { bytes, mediaType, headers: buildPreviewSecurityHeaders(extension === '.html' ? bytes.toString('utf8') : undefined) };
  }

  private view(session: Session): PreviewSessionView {
    const { root: _root, tokenHash: _tokenHash, allowedRoutes: _allowedRoutes, previewData: _previewData, ...view } = session;
    return structuredClone(view);
  }

  private injectPreviewDataAdapter(html: string, session: Session): string {
    const mappings = Object.fromEntries((session.previewData?.mocks ?? []).map((mock) => [mock.requestPath, `${session.contentPath}__conductor_mock/${mock.id}`]));
    const script = `(()=>{const m=${JSON.stringify(mappings)};const f=window.fetch.bind(window);window.fetch=(i,o)=>{const u=new URL(typeof i==='string'?i:i.url,location.href);const method=String(o?.method??(typeof i==='string'?'GET':i.method)).toUpperCase();const target=method==='GET'?m[u.pathname]:undefined;return target?f(target,{credentials:'include'}):f(i,o)}})();`;
    const tag = `<script>${script}</script>`;
    return /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (head) => `${head}${tag}`) : `${tag}${html}`;
  }
}
