import { readFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { DesignContractV1, DesignElementRequirement } from './design-contract.js';
import { safeMissionText } from './mission-evidence.js';
import type { VerificationCheck } from './types.js';
import type { PreviewDataContract } from './preview-data-contract.js';
import { compareElementVisualSnapshots, type ElementVisualSnapshot } from './visual-fidelity.js';

const MAX_LOG_BYTES = 16 * 1024;
export const MAX_CONTAINER_RESULT_BYTES = 1_500_000;
export const MAX_SCREENSHOT_BYTES = 512 * 1024;
const MAX_CHECKS = 128;
const MAX_ERRORS = 32;

export interface VerifierRequest {
  missionId: string;
  designRevisionId: string;
  workspaceRevisionId: string;
  correlationId: string;
  workspacePath: string;
  contract: DesignContractV1;
  referenceHtml?: string;
  route?: string;
  previewData?: PreviewDataContract;
}

export interface VerifierResult {
  status: 'passed' | 'failed' | 'error';
  correlationId: string;
  checks: VerificationCheck[];
  consoleErrors: string[];
  pageErrors: string[];
  url: string | null;
  durationMs: number;
  screenshotBase64: string | null;
  screenshotMediaType?: 'image/jpeg';
  screenshotWidth?: number;
  screenshotHeight?: number;
  screenshotByteLength?: number;
  screenshotSha256?: string;
  screenshotQuality?: number;
  referenceScreenshotBase64?: string;
  referenceScreenshotMediaType?: 'image/jpeg';
  referenceScreenshotWidth?: number;
  referenceScreenshotHeight?: number;
  referenceScreenshotByteLength?: number;
  referenceScreenshotSha256?: string;
  referenceScreenshotQuality?: number;
  error: { category: 'infrastructure'; message: string } | null;
}

export interface Verifier {
  verify(request: VerifierRequest): Promise<VerifierResult>;
}
export interface BrowserVerifier extends Verifier {}

export interface ContainerVerifierOptions {
  engine: string;
  image: string;
  timeoutMs?: number;
  cpuLimit?: number;
  memoryLimit?: string;
  pidsLimit?: number;
}

const bounded = (value: string, maxBytes = 1024): string => safeMissionText(value, maxBytes).content;

export async function captureCanonicalJpeg(page: import('playwright').Page, viewport: { width: number; height: number }): Promise<{ bytes: Buffer; width: number; height: number; quality: number }> {
  for (const quality of [86, 78, 70] as const) { const bytes = await page.screenshot({ type: 'jpeg', quality, animations: 'disabled' }); if (bytes.byteLength <= MAX_SCREENSHOT_BYTES) return { bytes, width: viewport.width, height: viewport.height, quality }; }
  const session = await page.context().newCDPSession(page); try { for (const scale of [0.75, 0.5] as const) { const result = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, fromSurface: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale } }); const bytes = Buffer.from(result.data, 'base64'); if (bytes.byteLength <= MAX_SCREENSHOT_BYTES) return { bytes, width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale), quality: 70 }; } } finally { await session.detach().catch(() => undefined); }
  throw new Error('canonical verification screenshot exceeds the hard evidence bound');
}

export function appendContainerResultChunk(current: string, chunk: Buffer | string): string {
  const next = current + String(chunk);
  if (Buffer.byteLength(next, 'utf8') > MAX_CONTAINER_RESULT_BYTES) throw new Error('container verifier result exceeds the result boundary');
  return next;
}

function requirementLabel(requirement: DesignElementRequirement): string {
  return `${requirement.role} named “${requirement.name}”`;
}

function profileError(value: unknown): Error {
  return new Error(`Verification requires a Node/React/Vite app profile: ${value instanceof Error ? value.message : String(value)}`);
}

async function assertViteProfile(workspacePath: string): Promise<void> {
  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(await readFile(path.join(workspacePath, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw profileError(error);
  }
  const scripts = packageJson.scripts;
  const dependencies = { ...(packageJson.dependencies as Record<string, unknown> | undefined), ...(packageJson.devDependencies as Record<string, unknown> | undefined) };
  if (!packageJson.name || typeof scripts !== 'object' || scripts === null || typeof (scripts as Record<string, unknown>).dev !== 'string' || !/(^|\s|&)vite(?:\s|$)/.test((scripts as Record<string, unknown>).dev as string) || !dependencies.vite || !dependencies.react) throw profileError('package.json is not the supported Vite/React profile');
}

function processOutput(child: ChildProcess): { stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer | string) => { stdout = bounded(stdout + String(chunk), MAX_LOG_BYTES); });
  child.stderr?.on('data', (chunk: Buffer | string) => { stderr = bounded(stderr + String(chunk), MAX_LOG_BYTES); });
  return { get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error('Verifier screenshot is not a complete JPEG');
  let offset = 2;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.byteLength) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.byteLength) throw new Error('Verifier screenshot has an invalid JPEG segment');
    if (startOfFrame.has(marker)) {
      if (length < 7) throw new Error('Verifier screenshot has an invalid JPEG frame');
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (!width || !height) throw new Error('Verifier screenshot has invalid JPEG dimensions');
      return { width, height };
    }
    offset += length;
  }
  throw new Error('Verifier screenshot JPEG dimensions are unavailable');
}

function validateCapture(input: { base64: unknown; mediaType: unknown; width: unknown; height: unknown; byteLength: unknown; sha256: unknown; quality: unknown }, label: string): void {
  if (typeof input.base64 !== 'string' || input.base64.length > Math.ceil(MAX_SCREENSHOT_BYTES * 4 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64)) throw new Error(`${label} screenshot encoding is invalid`);
  const bytes = Buffer.from(input.base64, 'base64');
  if (bytes.toString('base64') !== input.base64 || bytes.byteLength === 0 || bytes.byteLength > MAX_SCREENSHOT_BYTES) throw new Error(`${label} screenshot encoding is invalid`);
  if (input.mediaType !== 'image/jpeg') throw new Error(`${label} screenshot media type is invalid`);
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || (input.width as number) <= 0 || (input.height as number) <= 0 || (input.width as number) > 8_192 || (input.height as number) > 8_192 || (input.width as number) * (input.height as number) > 33_554_432) throw new Error(`${label} screenshot dimensions are invalid`);
  if (input.byteLength !== bytes.byteLength || typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(input.sha256) || input.sha256 !== createHash('sha256').update(bytes).digest('hex') || ![86, 78, 70].includes(input.quality as number)) throw new Error(`${label} screenshot metadata is invalid`);
  const decoded = jpegDimensions(bytes);
  if (decoded.width !== input.width || decoded.height !== input.height) throw new Error(`${label} screenshot dimensions do not match the JPEG`);
}

/** Validates the complete untrusted verifier result before it reaches Mission publication. */
export function validateVerifierResultBoundary(value: unknown, expectedCorrelationId: string): VerifierResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Verifier returned an invalid result');
  const result = value as Partial<VerifierResult>;
  if (result.correlationId !== expectedCorrelationId || !['passed', 'failed', 'error'].includes(result.status ?? '') || !Array.isArray(result.checks) || !Array.isArray(result.consoleErrors) || !Array.isArray(result.pageErrors) || result.checks.length > MAX_CHECKS || result.consoleErrors.length > MAX_ERRORS || result.pageErrors.length > MAX_ERRORS) throw new Error('Verifier returned an invalid result');
  if (!result.checks.every((item) => item && typeof item.id === 'string' && ['text', 'element', 'interaction', 'runtime'].includes(item.kind) && typeof item.label === 'string' && typeof item.passed === 'boolean' && typeof item.details === 'string') || !result.consoleErrors.every((item) => typeof item === 'string') || !result.pageErrors.every((item) => typeof item === 'string')) throw new Error('Verifier returned an invalid result');
  if ((result.url !== null && typeof result.url !== 'string') || !Number.isSafeInteger(result.durationMs) || (result.durationMs ?? -1) < 0) throw new Error('Verifier returned invalid timing or URL evidence');
  if (result.status === 'error') {
    if (!result.error || result.error.category !== 'infrastructure' || typeof result.error.message !== 'string') throw new Error('Verifier ERROR is missing infrastructure evidence');
  } else if (result.error !== null) throw new Error('Verifier semantic result contains an infrastructure error');
  if (result.screenshotBase64 === null) {
    if (result.status !== 'error') throw new Error('Verifier semantic result is missing its canonical screenshot');
  } else validateCapture({ base64: result.screenshotBase64, mediaType: result.screenshotMediaType, width: result.screenshotWidth, height: result.screenshotHeight, byteLength: result.screenshotByteLength, sha256: result.screenshotSha256, quality: result.screenshotQuality }, 'Canonical');
  if (result.referenceScreenshotBase64 !== undefined) validateCapture({ base64: result.referenceScreenshotBase64, mediaType: result.referenceScreenshotMediaType, width: result.referenceScreenshotWidth, height: result.referenceScreenshotHeight, byteLength: result.referenceScreenshotByteLength, sha256: result.referenceScreenshotSha256, quality: result.referenceScreenshotQuality }, 'Reference');
  return result as VerifierResult;
}

async function waitForApp(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'application did not start';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`application exited before verification (${child.exitCode})`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(500, Math.max(50, deadline - Date.now()))) });
      if (response.status >= 200 && response.status < 500) return;
      lastError = `application returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(lastError);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.once('close', () => resolve());
      killer.once('error', () => resolve());
    });
  } else {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => { child.once('close', () => resolve()); setTimeout(resolve, 500); });
  }
}

function check(kind: VerificationCheck['kind'], id: string, label: string, passed: boolean, details: string): VerificationCheck {
  return { kind, id, label: bounded(label, 512), passed, details: bounded(details, 1024) };
}

async function captureElementVisualSnapshot(locator: import('playwright').Locator): Promise<ElementVisualSnapshot | null> {
  if (await locator.count() === 0 || !await locator.first().isVisible()) return null;
  return locator.first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = element.ownerDocument.defaultView!.getComputedStyle(element);
    const parsedWeight = Number.parseInt(style.fontWeight, 10);
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      fontSize: Number.parseFloat(style.fontSize) || 0,
      fontWeight: Number.isFinite(parsedWeight) ? parsedWeight : style.fontWeight === 'bold' ? 700 : 400,
      color: style.color,
      backgroundColor: style.backgroundColor,
    };
  });
}

async function compareRequirementVisual(input: {
  requirement: DesignElementRequirement;
  referencePage: import('playwright').Page | null;
  actualPage: import('playwright').Page;
  viewport: { width: number; height: number };
}): Promise<{ passed: boolean; details: string } | null> {
  if (!input.referencePage) return null;
  const reference = await captureElementVisualSnapshot(input.referencePage.getByRole(input.requirement.role, { name: input.requirement.name, exact: true }));
  if (!reference) return { passed: false, details: `Protected reference does not expose ${requirementLabel(input.requirement)} for visual enforcement.` };
  const actual = await captureElementVisualSnapshot(input.actualPage.getByRole(input.requirement.role, { name: input.requirement.name, exact: true }));
  if (!actual) return { passed: false, details: `Actual application does not expose visible ${requirementLabel(input.requirement)}.` };
  return compareElementVisualSnapshots(reference, actual, input.viewport);
}

export class PlaywrightVerifier implements BrowserVerifier {
  constructor(private readonly options: { timeoutMs?: number } = {}) {}

  async verify(request: VerifierRequest): Promise<VerifierResult> {
    const correlationId = request.correlationId || randomUUID();
    const startedAt = Date.now();
    const timeoutMs = Math.min(Math.max(this.options.timeoutMs ?? 30_000, 1_000), 120_000);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    let child: ChildProcess | null = null;
    let childOutput: { stdout: string; stderr: string } | null = null;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    let url: string | null = null;
    let phase = 'profile';
    try {
      await assertViteProfile(request.workspacePath);
      const port = 41_000 + Math.floor(Math.random() * 1_000);
      const baseUrl = `http://127.0.0.1:${port}/`;
      url = new URL(request.route ?? '/', baseUrl).toString();
      const viteCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../node_modules/vite/bin/vite.js');
      child = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        cwd: request.workspacePath,
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
        // Vite watches stdin and exits when it observes EOF. Keep the pipe open
        // until stopProcess terminates the bounded verifier child.
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      childOutput = processOutput(child);
      phase = 'startup';
      await waitForApp(baseUrl, child, timeoutMs);
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: request.contract.viewport });
      await context.route('**/*', async (route) => {
        const target = new URL(route.request().url());
        const mock = request.previewData?.mocks.find((item) => item.method === route.request().method() && item.requestPath === target.pathname);
        if (mock) return route.fulfill({ status: mock.status, contentType: 'application/json; charset=utf-8', body: mock.body });
        if (target.protocol === 'data:' || target.protocol === 'blob:' || target.hostname === '127.0.0.1' || target.hostname === 'localhost') return route.continue();
        return route.abort('blockedbyclient');
      });
      let referenceCapture: Awaited<ReturnType<typeof captureCanonicalJpeg>> | null = null;
      let referencePage: import('playwright').Page | null = null;
      if (request.referenceHtml) {
        referencePage = await context.newPage();
        await referencePage.setContent(request.referenceHtml, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        referenceCapture = await captureCanonicalJpeg(referencePage, request.contract.viewport);
      }
      const page = await context.newPage();
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(bounded(message.text())); });
      page.on('pageerror', (error) => { pageErrors.push(bounded(error.message)); });
      phase = 'canonical-load';
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      phase = 'canonical-capture';
      const canonical = await captureCanonicalJpeg(page, request.contract.viewport);
      const screenshotBuffer = canonical.bytes; const screenshotBase64 = screenshotBuffer.toString('base64');
      const checks: VerificationCheck[] = [];
      if (request.previewData) checks.push(check('runtime', 'preview-data-binding', `Preview data contract ${request.previewData.hash.slice(0, 12)}`, true, 'Controlled mock responses were loaded from the exact captured workspace revision.'));
      for (const [index, requiredText] of request.contract.requiredText.entries()) {
        const present = (await page.locator('body').innerText()).includes(requiredText);
        checks.push(check('text', `text-${index + 1}`, `Required text “${requiredText}”`, present, present ? 'Text is present.' : 'Text was not found.'));
      }
      for (const [index, requiredElement] of request.contract.requiredElements.entries()) {
        const locator = page.getByRole(requiredElement.role, { name: requiredElement.name, exact: true });
        const count = await locator.count();
        const visible = count > 0 && await locator.first().isVisible();
        const visual = visible ? await compareRequirementVisual({ requirement: requiredElement, referencePage, actualPage: page, viewport: request.contract.viewport }) : null;
        const passed = visible && (visual?.passed ?? true);
        const details = !visible ? 'Accessible element was not found or is hidden.' : visual ? visual.details : 'Accessible element is visible.';
        checks.push(check('element', `element-${index + 1}`, `Required ${requirementLabel(requiredElement)}`, passed, details));
      }
      for (const [index, interaction] of request.contract.interactions.entries()) {
        phase = `interaction-${index + 1}-clean-load`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        const target = page.getByRole(interaction.target.role, { name: interaction.target.name, exact: true });
        const targetVisual = await compareRequirementVisual({ requirement: interaction.target, referencePage, actualPage: page, viewport: request.contract.viewport });
        let semanticPassed = false;
        let details = 'Interaction did not run.';
        try {
          await target.click({ timeout: timeoutMs });
          const bodyText = await page.locator('body').innerText();
          const missingText = interaction.expected.requiredText.find((value) => !bodyText.includes(value));
          const missingElement = (await Promise.all(interaction.expected.requiredElements.map(async (element) => (await page.getByRole(element.role, { name: element.name, exact: true }).count()) === 0 ? requirementLabel(element) : null))).find(Boolean);
          semanticPassed = !missingText && !missingElement;
          details = semanticPassed ? 'Interaction produced the expected result.' : `Missing ${missingText ? `text “${missingText}”` : `element ${missingElement}`}.`;
        } catch (error) {
          details = error instanceof Error ? error.message : String(error);
        }
        const visualPassed = targetVisual?.passed ?? true;
        if (targetVisual) details = `${details} Visual target: ${targetVisual.details}`;
        checks.push(check('interaction', interaction.id || `interaction-${index + 1}`, `Interaction ${interaction.id}`, semanticPassed && visualPassed, details));
      }
      await referencePage?.close().catch(() => undefined);
      if (consoleErrors.length || pageErrors.length) checks.push(check('runtime', 'runtime-errors', 'No page or console errors', false, `${consoleErrors.length} console error(s), ${pageErrors.length} page error(s).`));
      else checks.push(check('runtime', 'runtime-errors', 'No page or console errors', true, 'No page or console errors were captured.'));
      const failed = checks.some((item) => !item.passed);
      await context.close();
      return { status: failed ? 'failed' : 'passed', correlationId, checks: checks.slice(0, MAX_CHECKS), consoleErrors: consoleErrors.slice(0, MAX_ERRORS), pageErrors: pageErrors.slice(0, MAX_ERRORS), url, durationMs: Date.now() - startedAt, screenshotBase64, screenshotMediaType: 'image/jpeg', screenshotWidth: canonical.width, screenshotHeight: canonical.height, screenshotByteLength: screenshotBuffer.byteLength, screenshotSha256: createHash('sha256').update(screenshotBuffer).digest('hex'), screenshotQuality: canonical.quality, ...(referenceCapture ? { referenceScreenshotBase64: referenceCapture.bytes.toString('base64'), referenceScreenshotMediaType: 'image/jpeg' as const, referenceScreenshotWidth: referenceCapture.width, referenceScreenshotHeight: referenceCapture.height, referenceScreenshotByteLength: referenceCapture.bytes.byteLength, referenceScreenshotSha256: createHash('sha256').update(referenceCapture.bytes).digest('hex'), referenceScreenshotQuality: referenceCapture.quality } : {}), error: null };
    } catch (error) {
      const message = `${phase}: ${error instanceof Error ? error.message : String(error)} (app exit=${child?.exitCode ?? 'running'})`;
      return { status: 'error', correlationId, checks: [], consoleErrors: consoleErrors.slice(0, MAX_ERRORS), pageErrors: pageErrors.slice(0, MAX_ERRORS), url, durationMs: Date.now() - startedAt, screenshotBase64: null, error: { category: 'infrastructure', message: bounded(`${message}${childOutput?.stderr || childOutput?.stdout ? ` ${childOutput.stderr || childOutput.stdout}` : ''}`, 4_096) } };
    } finally {
      await browser?.close().catch(() => undefined);
      if (child) await stopProcess(child);
    }
  }
}

export function buildContainerVerifierArgs(request: VerifierRequest, options: ContainerVerifierOptions): string[] {
  return [
    'run', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m', '--cpus', String(options.cpuLimit ?? 2),
    '--memory', options.memoryLimit ?? '2g', '--pids-limit', String(options.pidsLimit ?? 256),
    '--mount', `type=bind,source=${request.workspacePath},target=/workspace,readonly`, options.image,
  ];
}

/** Runs the verifier harness in a pinned, network-isolated image. The host only owns the result boundary. */
export class ContainerBrowserVerifier implements BrowserVerifier {
  constructor(private readonly options: ContainerVerifierOptions) {}

  async verify(request: VerifierRequest): Promise<VerifierResult> {
    const startedAt = Date.now();
    const timeoutMs = Math.min(Math.max(this.options.timeoutMs ?? 120_000, 1_000), 300_000);
    const args = buildContainerVerifierArgs(request, this.options);
    let child: ChildProcess;
    let stdout = '';
    let stdoutOverflow = false;
    let stderr = '';
    try {
      child = spawn(this.options.engine, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (stdoutOverflow) return;
        try { stdout = appendContainerResultChunk(stdout, chunk); }
        catch { stdoutOverflow = true; }
      });
      child.stderr?.on('data', (chunk: Buffer | string) => { stderr = bounded(stderr + String(chunk), MAX_LOG_BYTES); });
      child.stdin?.end(JSON.stringify({ ...request, workspacePath: '/workspace' }));
      const result = await new Promise<VerifierResult>((resolve, reject) => {
        const timer = setTimeout(() => { void stopProcess(child); reject(new Error('container verifier timed out')); }, timeoutMs);
        child.once('error', reject);
        child.once('close', (code) => {
          clearTimeout(timer);
          if (stdoutOverflow) return reject(new Error('container verifier result exceeds the result boundary'));
          if (code !== 0) return reject(new Error(`container verifier exited with ${code}: ${stderr || stdout}`));
          try {
            resolve(validateVerifierResultBoundary(JSON.parse(stdout), request.correlationId));
          } catch (error) { reject(error); }
        });
      });
      return result;
    } catch (error) {
      return { status: 'error', correlationId: request.correlationId, checks: [], consoleErrors: [], pageErrors: [], url: null, durationMs: Date.now() - startedAt, screenshotBase64: null, error: { category: 'infrastructure', message: bounded(error instanceof Error ? error.message : String(error), 4_096) } };
    }
  }
}

export function createVerifier(options: { provider: 'local-process' | 'container'; image: string; engine: string; timeoutMs: number; cpuLimit: number; memoryLimit: string; pidsLimit: number }): Verifier {
  if (options.provider === 'container') return new ContainerBrowserVerifier({ engine: options.engine, image: options.image, timeoutMs: options.timeoutMs, cpuLimit: options.cpuLimit, memoryLimit: options.memoryLimit, pidsLimit: options.pidsLimit });
  return new PlaywrightVerifier({ timeoutMs: options.timeoutMs });
}
