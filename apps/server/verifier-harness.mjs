import { spawn } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

const MAX = 512 * 1024;
const runtimeWorkspace = '/tmp/workspace';
const bounded = (value, limit = 4096) => Buffer.byteLength(value, 'utf8') <= limit ? value : value.slice(0, limit);
const readStdin = async () => {
  let value = '';
  for await (const chunk of process.stdin) value += String(chunk);
  return value;
};
const captureBoundedScreenshot = async (page, viewport) => {
  for (const quality of [86, 78, 70]) {
    const bytes = await page.screenshot({ type: 'jpeg', quality, animations: 'disabled' });
    if (bytes.byteLength <= MAX) return { base64: bytes.toString('base64'), mediaType: 'image/jpeg', width: viewport.width, height: viewport.height, byteLength: bytes.byteLength, quality };
  }
  const session = await page.context().newCDPSession(page); try { for (const scale of [0.75, 0.5]) { const result = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, fromSurface: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale } }); const bytes = Buffer.from(result.data, 'base64'); if (bytes.byteLength <= MAX) return { base64: result.data, mediaType: 'image/jpeg', width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale), byteLength: bytes.byteLength, quality: 70 }; } } finally { await session.detach().catch(() => undefined); }
  throw new Error('canonical verification screenshot exceeds the hard evidence bound');
};
const input = JSON.parse(await readStdin());
const started = Date.now();
const port = 41000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}/`;
const url = new URL(input.route ?? '/', baseUrl).toString();
let server;
let browser;
let output = '';
let errorOutput = '';
const errors = [];
const pageErrors = [];
const check = (kind, id, label, passed, details) => ({ kind, id, label: bounded(label, 512), passed, details: bounded(details, 1024) });
const requirementLabel = (requirement) => `${requirement.role} named “${requirement.name}”`;
const round = (value) => Math.round(value * 10) / 10;
const parseRgba = (value) => {
  const match = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(String(value).trim());
  if (!match) return null;
  const rgb = match.slice(1, 4).map(Number);
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (rgb.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255) || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
  return [rgb[0], rgb[1], rgb[2], alpha];
};
const colorDistance = (reference, actual) => {
  const left = parseRgba(reference); const right = parseRgba(actual);
  if (!left || !right) return String(reference).trim().toLowerCase() === String(actual).trim().toLowerCase() ? 0 : null;
  const rgb = Math.sqrt((left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2);
  const alpha = Math.abs(left[3] - right[3]) * 255;
  return Math.sqrt(rgb ** 2 + alpha ** 2);
};
const transparent = (value) => { const parsed = parseRgba(value); return parsed ? parsed[3] <= 0.05 : String(value).trim().toLowerCase() === 'transparent'; };
const captureVisual = async (locator) => {
  if (await locator.count() === 0 || !await locator.first().isVisible()) return null;
  return locator.first().evaluate((element) => {
    const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); const parsedWeight = Number.parseInt(style.fontWeight, 10);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, fontSize: Number.parseFloat(style.fontSize) || 0, fontWeight: Number.isFinite(parsedWeight) ? parsedWeight : style.fontWeight === 'bold' ? 700 : 400, color: style.color, backgroundColor: style.backgroundColor };
  });
};
const compareVisual = (reference, actual, viewport) => {
  const mismatches = [];
  const xTolerance = Math.max(12, viewport.width * 0.015); const yTolerance = Math.max(10, viewport.height * 0.015);
  const widthTolerance = Math.max(6, Math.min(24, Math.max(reference.width * 0.05, 6))); const heightTolerance = Math.max(6, Math.min(20, Math.max(reference.height * 0.08, 6)));
  if (Math.abs(actual.x - reference.x) > xTolerance) mismatches.push(`x ${round(actual.x)}px vs ${round(reference.x)}px`);
  if (Math.abs(actual.y - reference.y) > yTolerance) mismatches.push(`y ${round(actual.y)}px vs ${round(reference.y)}px`);
  if (Math.abs(actual.width - reference.width) > widthTolerance) mismatches.push(`width ${round(actual.width)}px vs ${round(reference.width)}px`);
  if (Math.abs(actual.height - reference.height) > heightTolerance) mismatches.push(`height ${round(actual.height)}px vs ${round(reference.height)}px`);
  if (Math.abs(actual.fontSize - reference.fontSize) > 2) mismatches.push(`font-size ${round(actual.fontSize)}px vs ${round(reference.fontSize)}px`);
  if (Math.abs(actual.fontWeight - reference.fontWeight) > 100) mismatches.push(`font-weight ${actual.fontWeight} vs ${reference.fontWeight}`);
  const textDistance = colorDistance(reference.color, actual.color); if (textDistance === null ? reference.color !== actual.color : textDistance > 36) mismatches.push(`text color ${actual.color} vs ${reference.color}`);
  if (!transparent(reference.backgroundColor)) { const backgroundDistance = colorDistance(reference.backgroundColor, actual.backgroundColor); if (backgroundDistance === null ? reference.backgroundColor !== actual.backgroundColor : backgroundDistance > 36) mismatches.push(`background ${actual.backgroundColor} vs ${reference.backgroundColor}`); }
  const summary = `Reference ${round(reference.x)},${round(reference.y)} ${round(reference.width)}×${round(reference.height)}; actual ${round(actual.x)},${round(actual.y)} ${round(actual.width)}×${round(actual.height)}.`;
  return mismatches.length ? { passed: false, details: `${summary} Material visual deviation: ${mismatches.join('; ')}.` } : { passed: true, details: `${summary} Geometry, typography, and key colors remain within bounded reference tolerances.` };
};
const compareRequirementVisual = async (requirement, referencePage, actualPage) => {
  if (!referencePage) return null;
  const reference = await captureVisual(referencePage.getByRole(requirement.role, { name: requirement.name, exact: true }));
  if (!reference) return { passed: false, details: `Protected reference does not expose ${requirementLabel(requirement)} for visual enforcement.` };
  const actual = await captureVisual(actualPage.getByRole(requirement.role, { name: requirement.name, exact: true }));
  if (!actual) return { passed: false, details: `Actual application does not expose visible ${requirementLabel(requirement)}.` };
  return compareVisual(reference, actual, input.contract.viewport);
};
const waitForServer = async () => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`application exited with ${server.exitCode}`);
    try { const response = await fetch(baseUrl, { signal: AbortSignal.timeout(500) }); if (response.status < 500) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('application did not start');
};
const stop = async () => { if (server?.exitCode === null) server.kill('SIGTERM'); await browser?.close().catch(() => undefined); };
try {
  await rm(runtimeWorkspace, { recursive: true, force: true });
  await cp('/workspace', runtimeWorkspace, { recursive: true, force: true });
  server = spawn(process.execPath, ['/verifier/node_modules/vite/bin/vite.js', '--config', '/verifier/vite.config.mjs', '--configLoader', 'native', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: runtimeWorkspace, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' }, stdio: ['pipe', 'pipe', 'pipe'] });
  server.stdout.on('data', (chunk) => { output = bounded(output + String(chunk), 16384); });
  server.stderr.on('data', (chunk) => { errorOutput = bounded(errorOutput + String(chunk), 16384); });
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: input.contract.viewport });
  await context.route('**/*', (route) => { const target = new URL(route.request().url()); const mock = input.previewData?.mocks?.find((item) => item.method === route.request().method() && item.requestPath === target.pathname); if (mock) return route.fulfill({ status: mock.status, contentType: 'application/json; charset=utf-8', body: mock.body }); return ['data:', 'blob:'].includes(target.protocol) || target.hostname === '127.0.0.1' || target.hostname === 'localhost' ? route.continue() : route.abort('blockedbyclient'); });
  let referenceScreenshot = null; let referencePage = null;
  if (input.referenceHtml) { referencePage = await context.newPage(); await referencePage.setContent(input.referenceHtml, { waitUntil: 'domcontentloaded', timeout: 30000 }); referenceScreenshot = await captureBoundedScreenshot(referencePage, input.contract.viewport); }
  const page = await context.newPage();
  page.on('console', (message) => { if (message.type() === 'error') errors.push(bounded(message.text(), 1024)); });
  page.on('pageerror', (error) => pageErrors.push(bounded(error.message, 1024)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const screenshot = await captureBoundedScreenshot(page, input.contract.viewport);
  const checks = [];
  if (input.previewData) checks.push(check('runtime', 'preview-data-binding', `Preview data contract ${input.previewData.hash.slice(0, 12)}`, true, 'Controlled mock responses were loaded from the exact captured workspace revision.'));
  for (const [index, requiredText] of input.contract.requiredText.entries()) { const present = (await page.locator('body').innerText()).includes(requiredText); checks.push(check('text', `text-${index + 1}`, `Required text \"${requiredText}\"`, present, present ? 'Text is present.' : 'Text was not found.')); }
  for (const [index, requiredElement] of input.contract.requiredElements.entries()) {
    const locator = page.getByRole(requiredElement.role, { name: requiredElement.name, exact: true }); const visible = await locator.count() > 0 && await locator.first().isVisible();
    const visual = visible ? await compareRequirementVisual(requiredElement, referencePage, page) : null; const passed = visible && (visual?.passed ?? true);
    checks.push(check('element', `element-${index + 1}`, `Required ${requiredElement.role} named \"${requiredElement.name}\"`, passed, !visible ? 'Accessible element was not found or is hidden.' : visual ? visual.details : 'Accessible element is visible.'));
  }
  for (const [index, interaction] of input.contract.interactions.entries()) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); const target = page.getByRole(interaction.target.role, { name: interaction.target.name, exact: true }); const targetVisual = await compareRequirementVisual(interaction.target, referencePage, page); let semanticPassed = false; let details = 'Interaction did not run.';
    try { await target.click({ timeout: 30000 }); const body = await page.locator('body').innerText(); const missingText = interaction.expected.requiredText.find((text) => !body.includes(text)); const missingElement = (await Promise.all(interaction.expected.requiredElements.map(async (element) => await page.getByRole(element.role, { name: element.name, exact: true }).count() === 0 ? requirementLabel(element) : null))).find(Boolean); semanticPassed = !missingText && !missingElement; details = semanticPassed ? 'Interaction produced the expected result.' : `Missing ${missingText ? `text \"${missingText}\"` : `element ${missingElement}`}.`; } catch (error) { details = error instanceof Error ? error.message : String(error); }
    const visualPassed = targetVisual?.passed ?? true; if (targetVisual) details = `${details} Visual target: ${targetVisual.details}`;
    checks.push(check('interaction', interaction.id ?? `interaction-${index + 1}`, `Interaction ${interaction.id ?? index + 1}`, semanticPassed && visualPassed, details));
  }
  await referencePage?.close().catch(() => undefined);
  checks.push(check('runtime', 'runtime-errors', 'No page or console errors', errors.length === 0 && pageErrors.length === 0, `${errors.length} console error(s), ${pageErrors.length} page error(s).`));
  await context.close();
  console.log(JSON.stringify({ status: checks.some((item) => !item.passed) ? 'failed' : 'passed', correlationId: input.correlationId, checks, consoleErrors: errors.slice(0, 32), pageErrors: pageErrors.slice(0, 32), url, durationMs: Date.now() - started, screenshotBase64: screenshot.base64, screenshotMediaType: screenshot.mediaType, screenshotWidth: screenshot.width, screenshotHeight: screenshot.height, screenshotByteLength: screenshot.byteLength, screenshotSha256: createHash('sha256').update(Buffer.from(screenshot.base64, 'base64')).digest('hex'), screenshotQuality: screenshot.quality, ...(referenceScreenshot ? { referenceScreenshotBase64: referenceScreenshot.base64, referenceScreenshotMediaType: referenceScreenshot.mediaType, referenceScreenshotWidth: referenceScreenshot.width, referenceScreenshotHeight: referenceScreenshot.height, referenceScreenshotByteLength: referenceScreenshot.byteLength, referenceScreenshotSha256: createHash('sha256').update(Buffer.from(referenceScreenshot.base64, 'base64')).digest('hex'), referenceScreenshotQuality: referenceScreenshot.quality } : {}), error: null }));
} catch (error) {
  console.log(JSON.stringify({ status: 'error', correlationId: input.correlationId, checks: [], consoleErrors: errors.slice(0, 32), pageErrors: pageErrors.slice(0, 32), url, durationMs: Date.now() - started, screenshotBase64: null, error: { category: 'infrastructure', message: bounded(`${error instanceof Error ? error.message : String(error)} ${errorOutput || output}`) } }));
} finally { await stop(); }
