import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import { addEvent, safeMissionText } from './mission-evidence.js';
import { acceptVerificationOutcome, guardVerificationAdmission, startVerification } from './intent-workflow-state.js';
import { currentImplementationAcceptance } from './mission-implementation-review.js';
import { createRepairTask } from './mission-repair.js';
import { createSurfacePreviewHtml, parseDesignPackage } from './design-package.js';
import type { DesignReferenceStore } from './design-reference-store.js';
import type { MissionEvidenceStore } from './mission-evidence-store.js';
import { resolveDesignReferenceMaterialization } from './design-reference-store.js';
import { JsonStore } from './store.js';
import type { MissionArtifact, VerificationRun } from './types.js';
import type { MissionWorkspacePort } from './workspace.js';
import { validateVerifierResultBoundary, type BrowserVerifier, type VerifierResult } from './verification.js';
import { loadPreviewDataContract } from './preview-data-contract.js';

const now = () => new Date().toISOString();
const MAX_REPORT_BYTES = 60 * 1024;

function artifact(input: { missionId: string; workspaceRevisionId: string; kind: MissionArtifact['kind']; mediaType: string; content: string; }): MissionArtifact {
  return { id: randomUUID(), missionId: input.missionId, taskId: null, attemptId: null, kind: input.kind, mediaType: input.mediaType, content: input.content, storage: { kind: 'inline' }, sha256: createHash('sha256').update(input.content, 'utf8').digest('hex'), workspaceRevisionId: input.workspaceRevisionId, createdBy: { kind: 'system', agentId: null }, originalByteLength: Buffer.byteLength(input.content, 'utf8'), truncated: false, createdAt: now() };
}

export class MissionVerificationService {
  constructor(
    private readonly store: JsonStore,
    private readonly workspaces: MissionWorkspacePort,
    private readonly references: DesignReferenceStore,
    private readonly verifier: BrowserVerifier,
    private readonly evidence: MissionEvidenceStore,
    private readonly redactionSecrets: readonly string[] = [],
    private readonly onRepairReady?: (missionId: string) => Promise<unknown>,
    private readonly onFinalPassReady?: (missionId: string, verificationRunId: string) => Promise<unknown>,
  ) {}

  async start(missionId: string): Promise<void> {
    const verification = await this.store.mutate(async (database) => {
      const mission = database.missions.find((item) => item.id === missionId);
      if (!mission) throw new HttpError(404, 'Mission not found');
      const current = mission.workflow.currentVerificationRunId ? database.verificationRuns.find((run) => run.id === mission.workflow.currentVerificationRunId) : null;
      const revision = mission.workflow.implementedWorkspaceRevisionId ? database.missionWorkspaceRevisions.find((item) => item.id === mission.workflow.implementedWorkspaceRevisionId && item.missionId === missionId) : null;
      const inspection = revision ? await this.workspaces.inspectMissionWorkspace(missionId, revision.contentHash, false) : { state: 'unavailable' as const };
      const implementationAccepted = Boolean(currentImplementationAcceptance({ mission, verificationRuns: database.verificationRuns, events: database.missionEvents }));
      const guard = guardVerificationAdmission({ mission, currentVerification: current ?? null, workspaceState: inspection.state, implementationAccepted });
      if (!guard.accepted) throw new HttpError(409, 'Verification admission denied', 'VERIFICATION_ADMISSION_DENIED', { reason: guard.reason });
      const run: VerificationRun = { id: randomUUID(), missionId, designRevisionId: guard.designRevisionId, workspaceRevisionId: guard.workspaceRevisionId, cycle: current ? current.cycle + 1 : 0, status: 'running', correlationId: randomUUID(), checks: [], consoleErrors: [], pageErrors: [], url: null, durationMs: null, referenceScreenshotArtifactId: null, actualScreenshotArtifactId: null, reportArtifactId: null, visualDifference: null, error: null, createdAt: now(), startedAt: now(), completedAt: null, updatedAt: now() };
      const decision = startVerification({ mission, verification: run });
      if (!decision.accepted) throw new HttpError(409, 'Verification inputs are no longer current', 'VERIFICATION_ADMISSION_DENIED', { reason: decision.reason });
      Object.assign(mission.workflow, decision.value);
      mission.status = 'running';
      mission.updatedAt = now();
      database.verificationRuns.push(run);
      addEvent(database, mission, 'verification_started', {}, { verificationRunId: run.id, correlationId: run.correlationId, designRevisionId: run.designRevisionId, workspaceRevisionId: run.workspaceRevisionId, mode: implementationAccepted ? 'final' : 'precheck' });
      return run;
    });
    void this.execute(verification).catch((error) => this.publish(verification.id, { status: 'error', correlationId: verification.correlationId, checks: [], consoleErrors: [], pageErrors: [], url: null, durationMs: 0, screenshotBase64: null, error: { category: 'infrastructure', message: `Verification execution failed: ${error instanceof Error ? error.message : String(error)}` } }).catch(() => undefined));
  }

  async reconcileStartup(): Promise<void> {
    await this.store.mutate((database) => {
      for (const run of database.verificationRuns) {
        if (!['queued', 'running'].includes(run.status)) continue;
        const timestamp = now();
        run.status = 'error';
        run.error = { category: 'infrastructure', message: 'Verification interrupted by server restart' };
        run.completedAt = timestamp;
        run.updatedAt = timestamp;
        const report = artifact({ missionId: run.missionId, workspaceRevisionId: run.workspaceRevisionId, kind: 'verification_report', mediaType: 'application/json', content: JSON.stringify({ correlationId: run.correlationId, status: run.status, error: run.error }) });
        database.missionArtifacts.push(report);
        run.reportArtifactId = report.id;
        const mission = database.missions.find((item) => item.id === run.missionId);
        if (mission?.workflow.currentVerificationRunId === run.id && mission.workflow.phase === 'verifying' && mission.status !== 'completed' && mission.status !== 'blocked' && mission.status !== 'cancelled') {
          mission.status = 'recovered_paused';
          mission.updatedAt = timestamp;
          addEvent(database, mission, 'verification_error', {}, { verificationRunId: run.id, reason: 'server restart' });
        }
      }
    });
  }

  private async execute(run: VerificationRun): Promise<void> {
    const snapshot = this.store.snapshot();
    const mission = snapshot.missions.find((item) => item.id === run.missionId);
    const revision = snapshot.designRevisions.find((item) => item.id === run.designRevisionId && item.missionId === run.missionId);
    const workspaceRevision = snapshot.missionWorkspaceRevisions.find((item) => item.id === run.workspaceRevisionId && item.missionId === run.missionId);
    if (!mission || !revision || !workspaceRevision || mission.workflow.currentVerificationRunId !== run.id || mission.workflow.approvedDesignRevisionId !== run.designRevisionId || mission.workflow.implementedWorkspaceRevisionId !== run.workspaceRevisionId) {
      const published = await this.publish(run.id, { status: 'error', correlationId: run.correlationId, checks: [], consoleErrors: [], pageErrors: [], url: null, durationMs: 0, screenshotBase64: null, error: { category: 'infrastructure', message: 'Verification inputs became stale before execution' } });
      if (published.autoRepairScheduled) await this.startScheduledRepair(run.missionId);
      return;
    }
    let result: VerifierResult;
    try {
      const materialization = resolveDesignReferenceMaterialization({ revision, artifacts: snapshot.missionArtifacts });
      if (!materialization.ok) throw new Error('Approved design reference is unavailable');
      const packageValue = parseDesignPackage(await this.references.read(materialization.materialization.package, 768 * 1024));
      const checkpointPath = await this.workspaces.resolveMissionRevision(run.missionId, workspaceRevision);
      const previewData = await loadPreviewDataContract(checkpointPath, this.redactionSecrets);
      const surfaceResults: Array<{ id: string; title: string; route: string; result: VerifierResult }> = [];
      for (const surface of packageValue.surfaces) {
        const verified = validateVerifierResultBoundary(await this.verifier.verify({ missionId: run.missionId, designRevisionId: run.designRevisionId, workspaceRevisionId: run.workspaceRevisionId, correlationId: run.correlationId, workspacePath: checkpointPath, contract: surface.contract, referenceHtml: createSurfacePreviewHtml(surface), route: surface.route, ...(previewData ? { previewData } : {}) }), run.correlationId);
        surfaceResults.push({ id: surface.id, title: surface.title, route: surface.route, result: verified });
        if (verified.status === 'error') break;
      }
      const primary = surfaceResults.find((item) => item.id === packageValue.primarySurfaceId) ?? surfaceResults[0];
      const infrastructure = surfaceResults.find((item) => item.result.status === 'error');
      const checks = surfaceResults.flatMap((item) => item.result.checks.map((check) => ({ ...check, id: `${item.id}:${check.id}`, label: `${item.title} (${item.route}) · ${check.label}` })));
      const combined: VerifierResult = {
        status: infrastructure ? 'error' : checks.some((item) => !item.passed) ? 'failed' : 'passed', correlationId: run.correlationId, checks,
        consoleErrors: surfaceResults.flatMap((item) => item.result.consoleErrors.map((value) => `[${item.id}] ${value}`)).slice(0, 32),
        pageErrors: surfaceResults.flatMap((item) => item.result.pageErrors.map((value) => `[${item.id}] ${value}`)).slice(0, 32),
        url: primary?.result.url ?? null, durationMs: surfaceResults.reduce((sum, item) => sum + item.result.durationMs, 0),
        screenshotBase64: primary?.result.screenshotBase64 ?? null,
        ...(primary?.result.screenshotBase64 ? { screenshotMediaType: primary.result.screenshotMediaType, screenshotWidth: primary.result.screenshotWidth, screenshotHeight: primary.result.screenshotHeight, screenshotByteLength: primary.result.screenshotByteLength, screenshotSha256: primary.result.screenshotSha256, screenshotQuality: primary.result.screenshotQuality } : {}),
        ...(primary?.result.referenceScreenshotBase64 ? { referenceScreenshotBase64: primary.result.referenceScreenshotBase64, referenceScreenshotMediaType: primary.result.referenceScreenshotMediaType, referenceScreenshotWidth: primary.result.referenceScreenshotWidth, referenceScreenshotHeight: primary.result.referenceScreenshotHeight, referenceScreenshotByteLength: primary.result.referenceScreenshotByteLength, referenceScreenshotSha256: primary.result.referenceScreenshotSha256, referenceScreenshotQuality: primary.result.referenceScreenshotQuality } : {}),
        error: infrastructure ? { category: 'infrastructure', message: `Surface ${infrastructure.id} (${infrastructure.route}) failed: ${infrastructure.result.error?.message ?? 'verification infrastructure error'}` } : null,
      };
      result = validateVerifierResultBoundary(combined, run.correlationId);
    } catch (error) {
      result = { status: 'error', correlationId: run.correlationId, checks: [], consoleErrors: [], pageErrors: [], url: null, durationMs: 0, screenshotBase64: null, error: { category: 'infrastructure', message: error instanceof Error ? error.message : String(error) } };
    }
    let published: { autoRepairScheduled: boolean; finalPassReady: boolean };
    try { published = await this.publish(run.id, result); }
    catch (error) {
      published = await this.publish(run.id, { status: 'error', correlationId: run.correlationId, checks: [], consoleErrors: [], pageErrors: [], url: null, durationMs: 0, screenshotBase64: null, error: { category: 'infrastructure', message: `Verifier result publication failed: ${error instanceof Error ? error.message : String(error)}` } });
    }
    if (published.autoRepairScheduled) await this.startScheduledRepair(run.missionId);
    if (published.finalPassReady && this.onFinalPassReady) await this.onFinalPassReady(run.missionId, run.id);
  }

  private async startScheduledRepair(missionId: string): Promise<void> {
    if (!this.onRepairReady) return;
    try { await this.onRepairReady(missionId); } catch { /* Pending Repair remains explicit and retryable from the Mission surface. */ }
  }

  private async publish(runId: string, result: VerifierResult): Promise<{ autoRepairScheduled: boolean; finalPassReady: boolean }> {
    const pendingRun = this.store.snapshot().verificationRuns.find((run) => run.id === runId && run.status === 'running' && run.correlationId === result.correlationId);
    if (!pendingRun) return { autoRepairScheduled: false, finalPassReady: false };
    const publishImage = async (base64: string | undefined, metadata: { mediaType: string | undefined; width: number | undefined; height: number | undefined; byteLength: number | undefined; sha256: string | undefined; quality: number | undefined }): Promise<{ key: string; sha256: string; byteLength: number } | null> => { if (!base64) return null; const bytes = Buffer.from(base64, 'base64'); if (metadata.mediaType !== 'image/jpeg' || metadata.width === undefined || metadata.height === undefined || ![86, 78, 70].includes(metadata.quality ?? -1) || metadata.byteLength !== bytes.byteLength || bytes.byteLength > 512 * 1024 || metadata.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('Verifier screenshot metadata failed validation'); return this.evidence.write(bytes); };
    const publishedImage = await publishImage(result.screenshotBase64 ?? undefined, { mediaType: result.screenshotMediaType, width: result.screenshotWidth, height: result.screenshotHeight, byteLength: result.screenshotByteLength, sha256: result.screenshotSha256, quality: result.screenshotQuality });
    let publishedReference: { key: string; sha256: string; byteLength: number } | null = null;
    try { publishedReference = await publishImage(result.referenceScreenshotBase64, { mediaType: result.referenceScreenshotMediaType, width: result.referenceScreenshotWidth, height: result.referenceScreenshotHeight, byteLength: result.referenceScreenshotByteLength, sha256: result.referenceScreenshotSha256, quality: result.referenceScreenshotQuality }); }
    catch (error) { if (publishedImage) await this.evidence.remove(publishedImage.key).catch(() => undefined); throw error; }
    try { return await this.store.mutate((database) => {
      const run = database.verificationRuns.find((item) => item.id === runId);
      if (!run || run.status !== 'running' || run.correlationId !== result.correlationId) throw new Error('Verification publication authority changed');
      const mission = database.missions.find((item) => item.id === run.missionId);
      if (!mission) throw new Error('Verification Mission disappeared before evidence publication');
      const current = mission.status === 'running' && mission.workflow.phase === 'verifying' && mission.workflow.currentVerificationRunId === run.id && mission.workflow.approvedDesignRevisionId === run.designRevisionId && mission.workflow.implementedWorkspaceRevisionId === run.workspaceRevisionId && mission.workspace.currentRevisionId === run.workspaceRevisionId;
      run.status = result.status;
      run.correlationId = result.correlationId;
      run.checks = result.checks.slice(0, 128).map((item) => ({ ...item, label: safeMissionText(item.label, 512, this.redactionSecrets).content, details: safeMissionText(item.details, 1024, this.redactionSecrets).content }));
      run.consoleErrors = result.consoleErrors.slice(0, 32).map((item) => safeMissionText(item, 1024, this.redactionSecrets).content);
      run.pageErrors = result.pageErrors.slice(0, 32).map((item) => safeMissionText(item, 1024, this.redactionSecrets).content);
      run.url = result.url ? safeMissionText(result.url, 512, this.redactionSecrets).content : null;
      run.durationMs = Number.isSafeInteger(result.durationMs) && result.durationMs >= 0 ? result.durationMs : 0;
      run.error = result.error ? { category: 'infrastructure', message: safeMissionText(result.error.message, 4_096, this.redactionSecrets).content } : null;
      run.completedAt = now();
      run.updatedAt = run.completedAt;
      if (publishedImage) {
        const screenshot: MissionArtifact = { id: randomUUID(), missionId: run.missionId, taskId: null, attemptId: null, kind: 'actual_screenshot', mediaType: 'image/jpeg', content: null, storage: { kind: 'external', key: publishedImage.key }, sha256: publishedImage.sha256, workspaceRevisionId: run.workspaceRevisionId, createdBy: { kind: 'system', agentId: null }, originalByteLength: publishedImage.byteLength, truncated: false, createdAt: now() };
        database.missionArtifacts.push(screenshot);
        run.actualScreenshotArtifactId = screenshot.id;
      }
      if (publishedReference) { const screenshot: MissionArtifact = { id: randomUUID(), missionId: run.missionId, taskId: null, attemptId: null, kind: 'reference_screenshot', mediaType: 'image/jpeg', content: null, storage: { kind: 'external', key: publishedReference.key }, sha256: publishedReference.sha256, workspaceRevisionId: run.workspaceRevisionId, createdBy: { kind: 'system', agentId: null }, originalByteLength: publishedReference.byteLength, truncated: false, createdAt: now() }; database.missionArtifacts.push(screenshot); run.referenceScreenshotArtifactId = screenshot.id; }
      const report = safeMissionText(JSON.stringify({ correlationId: result.correlationId, status: result.status, checks: run.checks, consoleErrors: run.consoleErrors, pageErrors: run.pageErrors, url: run.url, durationMs: run.durationMs, capture: result.screenshotBase64 ? { mediaType: result.screenshotMediaType, width: result.screenshotWidth, height: result.screenshotHeight, byteLength: result.screenshotByteLength, quality: result.screenshotQuality } : null, referenceCapture: result.referenceScreenshotBase64 ? { mediaType: 'image/jpeg', width: result.referenceScreenshotWidth, height: result.referenceScreenshotHeight, byteLength: result.referenceScreenshotByteLength, quality: result.referenceScreenshotQuality } : null, error: run.error }), MAX_REPORT_BYTES, this.redactionSecrets);
      const reportArtifact = artifact({ missionId: run.missionId, workspaceRevisionId: run.workspaceRevisionId, kind: 'verification_report', mediaType: 'application/json', content: report.content });
      reportArtifact.originalByteLength = report.originalByteLength;
      reportArtifact.truncated = report.truncated;
      database.missionArtifacts.push(reportArtifact);
      run.reportArtifactId = reportArtifact.id;
      if (!current) {
        addEvent(database, mission, 'verification_result_discarded', {}, { verificationRunId: run.id, correlationId: run.correlationId, reason: 'verification inputs are no longer current' });
        return { autoRepairScheduled: false, finalPassReady: false };
      }
      const implementationAccepted = Boolean(currentImplementationAcceptance({ mission, verificationRuns: database.verificationRuns, events: database.missionEvents }));
      const automaticRepairAlreadyUsed = database.missionEvents.some((event) => event.missionId === mission.id && event.type === 'repair_scheduled' && event.details.trigger === 'automatic_precheck');
      const decision = acceptVerificationOutcome({ mission, verification: run, implementationAccepted, automaticRepairAlreadyUsed });
      if (!decision.accepted) return { autoRepairScheduled: false, finalPassReady: false };
      Object.assign(mission, decision.value.mission);
      mission.updatedAt = run.completedAt;
      if (result.status === 'passed') {
        if (implementationAccepted) {
          addEvent(database, mission, 'verification_passed', {}, { verificationRunId: run.id, correlationId: run.correlationId, checkCount: run.checks.length, mode: 'final' });
          return { autoRepairScheduled: false, finalPassReady: true };
        } else {
          addEvent(database, mission, 'implementation_precheck_passed', {}, { verificationRunId: run.id, correlationId: run.correlationId, designRevisionId: run.designRevisionId, workspaceRevisionId: run.workspaceRevisionId, checkCount: run.checks.length });
        }
        return { autoRepairScheduled: false, finalPassReady: false };
      }
      if (result.status === 'failed') {
        addEvent(database, mission, 'verification_failed', {}, { verificationRunId: run.id, correlationId: run.correlationId, failedCheckCount: run.checks.filter((item) => !item.passed).length, mode: implementationAccepted ? 'final' : 'precheck' });
        if (decision.value.requestRepairTask) {
          const order = Math.max(-1, ...database.missionTasks.filter((task) => task.missionId === mission.id).map((task) => task.order)) + 1;
          const task = createRepairTask({ mission, verification: run, order, repairCycle: decision.value.repairCycle });
          database.missionTasks.push(task);
          mission.currentTaskId = task.id;
          addEvent(database, mission, 'repair_scheduled', { taskId: task.id }, { verificationRunId: run.id, designRevisionId: run.designRevisionId, workspaceRevisionId: run.workspaceRevisionId, repairCycle: decision.value.repairCycle, trigger: 'automatic_precheck' });
          return { autoRepairScheduled: true, finalPassReady: false };
        }
        return { autoRepairScheduled: false, finalPassReady: false };
      }
      addEvent(database, mission, 'verification_error', {}, { verificationRunId: run.id, correlationId: run.correlationId, reason: run.error?.message ?? 'infrastructure error', mode: implementationAccepted ? 'final' : 'precheck' });
      return { autoRepairScheduled: false, finalPassReady: false };
    }); } catch (error) { await Promise.all([publishedImage ? this.evidence.remove(publishedImage.key).catch(() => undefined) : undefined, publishedReference ? this.evidence.remove(publishedReference.key).catch(() => undefined) : undefined]); throw error; }
  }
}
