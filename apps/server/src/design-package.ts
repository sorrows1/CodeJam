import { createHash } from 'node:crypto';
import type { DesignContractV1 } from './design-contract.js';
import { canonicalizeDesignContract, hashDesignContract, parseDesignContract } from './design-contract.js';

export const DESIGN_PACKAGE_MAX_BYTES = 768 * 1024;
const MAX_SURFACES = 8;
const MAX_SURFACE_FILE_BYTES = 256 * 1024;
const MAX_PATHS = 64;
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const portablePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._@+\-/]+$/;

export interface DesignSurfaceV2 {
  id: string;
  title: string;
  route: string;
  entrypoint: string;
  sourcePaths: string[];
  sharedDependencies: string[];
  states: string[];
  files: { indexHtml: string; stylesCss: string };
  contract: DesignContractV1;
  fileHashes: { indexHtml: string; stylesCss: string; contract: string };
}

export interface DesignPackageV2 {
  schemaVersion: 2;
  primarySurfaceId: string;
  surfaces: DesignSurfaceV2[];
}

export interface DesignSurfaceInput {
  id: string;
  title: string;
  route: string;
  entrypoint: string;
  sourcePaths?: string[];
  sharedDependencies?: string[];
  states?: string[];
  indexHtml: string;
  stylesCss: string;
  contract: unknown;
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');
const boundedText = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || bytes(value) > 512) throw new Error(`${label} must be a non-empty string of at most 512 UTF-8 bytes`);
  return value.trim();
};
const pathList = (value: string[] | undefined, label: string): string[] => {
  const result = value ?? [];
  if (result.length > MAX_PATHS || new Set(result).size !== result.length || result.some((item) => typeof item !== 'string' || !portablePath.test(item))) throw new Error(`${label} must contain at most ${MAX_PATHS} unique repository-relative path strings`);
  return [...result];
};

function surface(input: DesignSurfaceInput, surfaceIndex: number): DesignSurfaceV2 {
  const location = `Design bundle surfaces[${surfaceIndex}]`;
  const id = boundedText(input.id, `${location}.id`);
  const title = boundedText(input.title, `${location}.title`);
  const route = boundedText(input.route, `${location}.route`);
  const entrypoint = boundedText(input.entrypoint, `${location}.entrypoint`);
  if (!idPattern.test(id) || !route.startsWith('/') || route.includes('..') || !portablePath.test(entrypoint)) throw new Error(`${location} has an invalid id, route, or entrypoint binding`);
  if (bytes(input.indexHtml) > MAX_SURFACE_FILE_BYTES || bytes(input.stylesCss) > MAX_SURFACE_FILE_BYTES) throw new Error('Design package file exceeds byte bound');
  const contract = parseDesignContract(input.contract);
  const states = input.states ?? [];
  if (states.length > 32 || new Set(states).size !== states.length) throw new Error(`${location}.states must contain at most 32 unique strings`);
  const normalizedStates = states.map((item, stateIndex) => boundedText(item, `${location}.states[${stateIndex}]`));
  return {
    id, title, route, entrypoint,
    sourcePaths: pathList(input.sourcePaths, `${location}.sourcePaths`),
    sharedDependencies: pathList(input.sharedDependencies, `${location}.sharedDependencies`),
    states: normalizedStates,
    files: { indexHtml: input.indexHtml, stylesCss: input.stylesCss },
    contract,
    fileHashes: { indexHtml: sha256(input.indexHtml), stylesCss: sha256(input.stylesCss), contract: hashDesignContract(contract) },
  };
}

export function createDesignBundle(input: { primarySurfaceId: string; surfaces: DesignSurfaceInput[] }): DesignPackageV2 {
  if (!Array.isArray(input.surfaces) || input.surfaces.length < 1 || input.surfaces.length > MAX_SURFACES) throw new Error('Design bundle must contain 1-8 surfaces');
  const surfaces = input.surfaces.map((item, index) => surface(item, index));
  if (new Set(surfaces.map((item) => item.id)).size !== surfaces.length || new Set(surfaces.map((item) => item.route)).size !== surfaces.length) throw new Error('Design bundle surface IDs and routes must be unique');
  if (!surfaces.some((item) => item.id === input.primarySurfaceId)) throw new Error('Design bundle primary surface is unavailable');
  const totalChecks = surfaces.reduce((sum, item) => sum + item.contract.requiredText.length + item.contract.requiredElements.length + item.contract.interactions.length + 1, 0);
  if (totalChecks > 128) throw new Error('Design bundle exceeds the verifier check bound');
  const packageValue: DesignPackageV2 = { schemaVersion: 2, primarySurfaceId: input.primarySurfaceId, surfaces };
  if (bytes(canonicalizeDesignPackage(packageValue)) > DESIGN_PACKAGE_MAX_BYTES) throw new Error('Design package exceeds byte bound');
  if (bytes(canonicalizeDesignBundleContract(packageValue)) > 64 * 1024) throw new Error('Design bundle contract exceeds byte bound');
  return packageValue;
}

export function createDesignPackage(input: { indexHtml: string; stylesCss: string; contract: unknown }): DesignPackageV2 {
  return createDesignBundle({ primarySurfaceId: 'primary', surfaces: [{ id: 'primary', title: 'Primary surface', route: '/', entrypoint: 'src/main.tsx', sourcePaths: [], sharedDependencies: [], states: ['default'], indexHtml: input.indexHtml, stylesCss: input.stylesCss, contract: input.contract }] });
}

export function parseDesignBundleDraft(value: unknown): DesignPackageV2 {
  const source = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Design bundle draft must be an object');
  const candidate = source as Record<string, unknown>;
  if (candidate.schemaVersion === 2) return parseDesignPackage(source);
  if (candidate.schemaVersion !== 1 || typeof candidate.primarySurfaceId !== 'string' || !Array.isArray(candidate.surfaces) || Object.keys(candidate).sort().join(',') !== 'primarySurfaceId,schemaVersion,surfaces') throw new Error('Unsupported Design bundle draft schema');
  const surfaces = candidate.surfaces.map((raw, index): DesignSurfaceInput => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid Design bundle draft surface ${index}`);
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'contract,entrypoint,id,indexHtml,route,sharedDependencies,sourcePaths,states,stylesCss,title' || typeof item.indexHtml !== 'string' || typeof item.stylesCss !== 'string' || !Array.isArray(item.sourcePaths) || !Array.isArray(item.sharedDependencies) || !Array.isArray(item.states)) throw new Error(`Invalid Design bundle draft surface ${index}`);
    return { id: item.id as string, title: item.title as string, route: item.route as string, entrypoint: item.entrypoint as string, sourcePaths: item.sourcePaths as string[], sharedDependencies: item.sharedDependencies as string[], states: item.states as string[], indexHtml: item.indexHtml, stylesCss: item.stylesCss, contract: item.contract };
  });
  return createDesignBundle({ primarySurfaceId: candidate.primarySurfaceId, surfaces });
}

export function canonicalizeDesignBundleDraft(packageValue: DesignPackageV2): string {
  return JSON.stringify({ schemaVersion: 1, primarySurfaceId: packageValue.primarySurfaceId, surfaces: packageValue.surfaces.map((item) => ({ id: item.id, title: item.title, route: item.route, entrypoint: item.entrypoint, sourcePaths: [...item.sourcePaths], sharedDependencies: [...item.sharedDependencies], states: [...item.states], indexHtml: item.files.indexHtml, stylesCss: item.files.stylesCss, contract: JSON.parse(canonicalizeDesignContract(item.contract)) })) });
}

function canonicalSurface(value: DesignSurfaceV2): Record<string, unknown> {
  return { id: value.id, title: value.title, route: value.route, entrypoint: value.entrypoint, sourcePaths: [...value.sourcePaths], sharedDependencies: [...value.sharedDependencies], states: [...value.states], files: { indexHtml: value.files.indexHtml, stylesCss: value.files.stylesCss }, contract: JSON.parse(canonicalizeDesignContract(value.contract)), fileHashes: { indexHtml: value.fileHashes.indexHtml, stylesCss: value.fileHashes.stylesCss, contract: value.fileHashes.contract } };
}

export function canonicalizeDesignPackage(packageValue: DesignPackageV2): string {
  return JSON.stringify({ schemaVersion: 2, primarySurfaceId: packageValue.primarySurfaceId, surfaces: packageValue.surfaces.map(canonicalSurface) });
}

export function parseDesignPackage(value: unknown): DesignPackageV2 {
  const source = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Design package must be an object');
  const candidate = source as Record<string, unknown>;
  if (candidate.schemaVersion !== 2 || typeof candidate.primarySurfaceId !== 'string' || !Array.isArray(candidate.surfaces) || Object.keys(candidate).sort().join(',') !== 'primarySurfaceId,schemaVersion,surfaces') throw new Error('Unsupported Design package schema');
  const inputs = candidate.surfaces.map((raw, index): DesignSurfaceInput => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid Design surface ${index}`);
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'contract,entrypoint,fileHashes,files,id,route,sharedDependencies,sourcePaths,states,title' || !item.files || typeof item.files !== 'object' || !item.fileHashes || typeof item.fileHashes !== 'object') throw new Error(`Invalid Design surface ${index}`);
    const files = item.files as Record<string, unknown>;
    const hashes = item.fileHashes as Record<string, unknown>;
    if (typeof files.indexHtml !== 'string' || typeof files.stylesCss !== 'string' || !Array.isArray(item.sourcePaths) || !Array.isArray(item.sharedDependencies) || !Array.isArray(item.states)) throw new Error(`Invalid Design surface ${index}`);
    const input: DesignSurfaceInput = { id: item.id as string, title: item.title as string, route: item.route as string, entrypoint: item.entrypoint as string, sourcePaths: item.sourcePaths as string[], sharedDependencies: item.sharedDependencies as string[], states: item.states as string[], indexHtml: files.indexHtml, stylesCss: files.stylesCss, contract: item.contract };
    const normalized = surface(input, index);
    if (hashes.indexHtml !== normalized.fileHashes.indexHtml || hashes.stylesCss !== normalized.fileHashes.stylesCss || hashes.contract !== normalized.fileHashes.contract) throw new Error(`Design surface ${index} integrity mismatch`);
    return input;
  });
  const result = createDesignBundle({ primarySurfaceId: candidate.primarySurfaceId, surfaces: inputs });
  if (canonicalizeDesignPackage(result) !== JSON.stringify(source)) throw new Error('Design package integrity mismatch');
  return result;
}

export function primaryDesignSurface(packageValue: DesignPackageV2): DesignSurfaceV2 {
  const value = packageValue.surfaces.find((item) => item.id === packageValue.primarySurfaceId);
  if (!value) throw new Error('Design bundle primary surface is unavailable');
  return value;
}

export function canonicalizeDesignBundleContract(packageValue: DesignPackageV2): string {
  return JSON.stringify({ schemaVersion: 2, primarySurfaceId: packageValue.primarySurfaceId, surfaces: packageValue.surfaces.map((item) => ({ id: item.id, title: item.title, route: item.route, entrypoint: item.entrypoint, sourcePaths: [...item.sourcePaths], sharedDependencies: [...item.sharedDependencies], states: [...item.states], viewport: { ...item.contract.viewport }, contract: JSON.parse(canonicalizeDesignContract(item.contract)), previewHash: sha256(createSurfacePreviewHtml(item)) })) });
}

export function createSurfacePreviewHtml(value: DesignSurfaceV2): string {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; media-src data:; navigate-to 'none'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${value.files.stylesCss}</style></head><body>${value.files.indexHtml}</body></html>`;
}

export function createPreviewHtml(packageValue: DesignPackageV2): string { return createSurfacePreviewHtml(primaryDesignSurface(packageValue)); }
export function hashDesignArtifact(content: string): string { return sha256(content); }
