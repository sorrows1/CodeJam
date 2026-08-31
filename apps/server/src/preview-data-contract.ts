import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const CONFIG_NAME = 'conductor.preview.json';
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_ROUTES = 64;
const MAX_MOCKS = 32;
const MAX_FIXTURE_BYTES = 256 * 1024;
const MAX_FIXTURE_TOTAL_BYTES = 2 * 1024 * 1024;
const portableFixture = /^preview-fixtures\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.json$/;
const identifier = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PreviewDataMock {
  id: string;
  method: 'GET';
  requestPath: string;
  status: number;
  fixturePath: string;
  body: string;
}

export interface PreviewDataContract {
  hash: string;
  routes: string[];
  mocks: PreviewDataMock[];
}

const exactKeys = (value: Record<string, unknown>, expected: string[], label: string): void => {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error(`${label} has unsupported keys`);
};

const routePath = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 256 || value.includes('..') || value.includes('\\') || /[?#]/.test(value)) throw new Error(`${label} is invalid`);
  return value.length > 1 ? value.replace(/\/$/, '') : value;
};

/** Reads an optional, revision-owned preview fixture contract without executing application code. */
export async function loadPreviewDataContract(root: string, sensitiveValues: readonly string[] = []): Promise<PreviewDataContract | null> {
  const configPath = path.join(root, CONFIG_NAME);
  const info = await stat(configPath).catch(() => null);
  if (!info) return null;
  if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw new Error('Preview data contract exceeds the bound');
  const raw = await readFile(configPath, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Preview data contract is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Preview data contract is invalid');
  const source = parsed as Record<string, unknown>;
  exactKeys(source, ['schemaVersion', 'routes', 'mocks'], 'Preview data contract');
  if (source.schemaVersion !== 1 || !Array.isArray(source.routes) || !Array.isArray(source.mocks) || source.routes.length > MAX_ROUTES || source.mocks.length > MAX_MOCKS) throw new Error('Preview data contract is invalid');
  const routes = source.routes.map((value, index) => routePath(value, `Preview route ${index}`));
  if (new Set(routes).size !== routes.length) throw new Error('Preview data contract routes must be unique');
  let totalBytes = 0;
  const mocks: PreviewDataMock[] = [];
  for (const [index, candidate] of source.mocks.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`Preview mock ${index} is invalid`);
    const mock = candidate as Record<string, unknown>;
    exactKeys(mock, ['id', 'method', 'path', 'status', 'fixture'], `Preview mock ${index}`);
    if (typeof mock.id !== 'string' || !identifier.test(mock.id) || mock.method !== 'GET' || typeof mock.fixture !== 'string' || !portableFixture.test(mock.fixture) || !Number.isSafeInteger(mock.status) || (mock.status as number) < 200 || (mock.status as number) > 599) throw new Error(`Preview mock ${index} is invalid`);
    const normalizedFixture = path.posix.normalize(mock.fixture);
    if (normalizedFixture !== mock.fixture || normalizedFixture.includes('..')) throw new Error(`Preview mock ${index} fixture is invalid`);
    const fixturePath = path.resolve(root, ...normalizedFixture.split('/'));
    const relative = path.relative(root, fixturePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Preview mock ${index} fixture is invalid`);
    const fixtureInfo = await stat(fixturePath).catch(() => null);
    if (!fixtureInfo?.isFile() || fixtureInfo.size > MAX_FIXTURE_BYTES) throw new Error(`Preview mock ${index} fixture exceeds the bound`);
    totalBytes += fixtureInfo.size;
    if (totalBytes > MAX_FIXTURE_TOTAL_BYTES) throw new Error('Preview fixture data exceeds the total bound');
    const body = await readFile(fixturePath, 'utf8');
    try { JSON.parse(body); } catch { throw new Error(`Preview mock ${index} fixture is not valid JSON`); }
    const lower = body.toLowerCase();
    if (sensitiveValues.some((value) => value.length >= 4 && lower.includes(value.toLowerCase()))) throw new Error(`Preview mock ${index} contains a configured sensitive value`);
    mocks.push({ id: mock.id, method: 'GET', requestPath: routePath(mock.path, `Preview mock ${index} path`), status: mock.status as number, fixturePath: normalizedFixture, body });
  }
  if (new Set(mocks.map((mock) => mock.id)).size !== mocks.length || new Set(mocks.map((mock) => mock.requestPath)).size !== mocks.length) throw new Error('Preview mock identifiers and paths must be unique');
  const hash = createHash('sha256').update(raw).update('\0').update(mocks.map((mock) => `${mock.fixturePath}\0${mock.body}`).join('\0')).digest('hex');
  return { hash, routes, mocks };
}
