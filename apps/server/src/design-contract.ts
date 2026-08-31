import { createHash } from 'node:crypto';

export const DESIGN_CONTRACT_MAX_BYTES = 64 * 1024;
export const SUPPORTED_ACCESSIBLE_ROLES = [
  'alert', 'button', 'checkbox', 'combobox', 'heading', 'img', 'link',
  'main', 'navigation', 'textbox', 'form', 'status',
] as const;
export type SupportedAccessibleRole = typeof SUPPORTED_ACCESSIBLE_ROLES[number];

const MAX_REQUIREMENTS = 64;
const MAX_INTERACTIONS = 32;
const MAX_STRING_BYTES = 512;

export interface DesignElementRequirement {
  role: SupportedAccessibleRole;
  name: string;
}

export interface DesignInteraction {
  id: string;
  action: 'click';
  target: DesignElementRequirement;
  expected: {
    requiredText: string[];
    requiredElements: DesignElementRequirement[];
  };
}

export interface DesignContractV1 {
  schemaVersion: 1;
  viewport: { width: number; height: number };
  requiredText: string[];
  requiredElements: DesignElementRequirement[];
  interactions: DesignInteraction[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`Invalid ${label} properties`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || bytes(value) > MAX_STRING_BYTES) throw new Error(`Invalid ${label}`);
  return value.trim();
}

function role(value: unknown, label: string): SupportedAccessibleRole {
  if (typeof value !== 'string' || !(SUPPORTED_ACCESSIBLE_ROLES as readonly string[]).includes(value)) throw new Error(`Invalid ${label} role`);
  return value as SupportedAccessibleRole;
}

function requirement(value: unknown, label: string): DesignElementRequirement {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
  exactKeys(value, ['role', 'name'], label);
  return { role: role(value.role, label), name: text(value.name, `${label} name`) };
}

function uniqueRequirements(values: DesignElementRequirement[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = `${value.role}\u0000${value.name}`;
    if (seen.has(key)) throw new Error(`Duplicate ${label}`);
    seen.add(key);
  }
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_REQUIREMENTS) throw new Error(`Invalid ${label}`);
  const result = value.map((item, index) => text(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`Duplicate ${label}`);
  return result;
}

export function parseDesignContract(value: unknown): DesignContractV1 {
  const source = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!isRecord(source)) throw new Error('Design contract must be an object');
  exactKeys(source, ['schemaVersion', 'viewport', 'requiredText', 'requiredElements', 'interactions'], 'Design contract');
  if (source.schemaVersion !== 1 || !isRecord(source.viewport)) throw new Error('Unsupported Design contract schema');
  exactKeys(source.viewport, ['width', 'height'], 'viewport');
  const width = source.viewport.width;
  const height = source.viewport.height;
  if (!Number.isSafeInteger(width) || (width as number) < 320 || (width as number) > 1920 || !Number.isSafeInteger(height) || (height as number) < 480 || (height as number) > 2160) throw new Error('Design viewport is out of bounds');
  if (!Array.isArray(source.requiredElements) || source.requiredElements.length > MAX_REQUIREMENTS) throw new Error('Invalid required elements');
  const requiredElements = source.requiredElements.map((item, index) => requirement(item, `requiredElements[${index}]`));
  uniqueRequirements(requiredElements, 'required element');
  if (!Array.isArray(source.interactions) || source.interactions.length > MAX_INTERACTIONS) throw new Error('Invalid interactions');
  const interactionIds = new Set<string>();
  const interactions = source.interactions.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Invalid interactions[${index}]`);
    exactKeys(item, ['id', 'action', 'target', 'expected'], `interactions[${index}]`);
    const id = text(item.id, `interactions[${index}] id`);
    if (interactionIds.has(id)) throw new Error('Duplicate interaction ID');
    interactionIds.add(id);
    if (item.action !== 'click' || !isRecord(item.expected)) throw new Error(`Invalid interactions[${index}] action`);
    exactKeys(item.expected, ['requiredText', 'requiredElements'], `interactions[${index}] expected`);
    const expectedText = stringList(item.expected.requiredText, `interactions[${index}] expected text`);
    const expectedElements = Array.isArray(item.expected.requiredElements) && item.expected.requiredElements.length <= MAX_REQUIREMENTS
      ? item.expected.requiredElements.map((entry, entryIndex) => requirement(entry, `interactions[${index}] expected element[${entryIndex}]`))
      : (() => { throw new Error(`Invalid interactions[${index}] expected elements`); })();
    uniqueRequirements(expectedElements, 'expected element');
    if (expectedText.length === 0 && expectedElements.length === 0) throw new Error('Every interaction needs an expected result');
    return { id, action: 'click' as const, target: requirement(item.target, `interactions[${index}] target`), expected: { requiredText: expectedText, requiredElements: expectedElements } };
  });
  const contract: DesignContractV1 = { schemaVersion: 1, viewport: { width: width as number, height: height as number }, requiredText: stringList(source.requiredText, 'required text'), requiredElements, interactions };
  if (bytes(canonicalizeDesignContract(contract)) > DESIGN_CONTRACT_MAX_BYTES) throw new Error('Design contract exceeds byte bound');
  return contract;
}

export function canonicalizeDesignContract(contract: DesignContractV1): string {
  return JSON.stringify({ schemaVersion: 1, viewport: { width: contract.viewport.width, height: contract.viewport.height }, requiredText: [...contract.requiredText], requiredElements: contract.requiredElements.map((item) => ({ role: item.role, name: item.name })), interactions: contract.interactions.map((item) => ({ id: item.id, action: item.action, target: { role: item.target.role, name: item.target.name }, expected: { requiredText: [...item.expected.requiredText], requiredElements: item.expected.requiredElements.map((entry) => ({ role: entry.role, name: entry.name })) } })) });
}

export function hashDesignContract(contract: DesignContractV1): string {
  return createHash('sha256').update(canonicalizeDesignContract(contract), 'utf8').digest('hex');
}
