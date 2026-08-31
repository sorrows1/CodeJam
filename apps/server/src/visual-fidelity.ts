import type { DesignContractV1, DesignElementRequirement } from './design-contract.js';

export interface ElementVisualSnapshot {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontWeight: number;
  color: string;
  backgroundColor: string;
}

export interface VisualComparisonResult {
  passed: boolean;
  details: string;
}

const round = (value: number): number => Math.round(value * 10) / 10;

export function contractVisualRequirements(contract: DesignContractV1): DesignElementRequirement[] {
  const result: DesignElementRequirement[] = [];
  const seen = new Set<string>();
  for (const requirement of [
    ...contract.requiredElements,
    ...contract.interactions.map((interaction) => interaction.target),
  ]) {
    const key = `${requirement.role}\u0000${requirement.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ role: requirement.role, name: requirement.name });
  }
  return result;
}

function parseRgba(value: string): [number, number, number, number] | null {
  const match = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(value.trim());
  if (!match) return null;
  const rgb = match.slice(1, 4).map(Number);
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (rgb.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255) || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
  return [rgb[0]!, rgb[1]!, rgb[2]!, alpha];
}

function colorDistance(reference: string, actual: string): number | null {
  const left = parseRgba(reference);
  const right = parseRgba(actual);
  if (!left || !right) return reference.trim().toLowerCase() === actual.trim().toLowerCase() ? 0 : null;
  const rgb = Math.sqrt((left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2);
  const alpha = Math.abs(left[3] - right[3]) * 255;
  return Math.sqrt(rgb ** 2 + alpha ** 2);
}

function transparent(value: string): boolean {
  const parsed = parseRgba(value);
  return parsed ? parsed[3] <= 0.05 : value.trim().toLowerCase() === 'transparent';
}

export function compareElementVisualSnapshots(
  reference: ElementVisualSnapshot,
  actual: ElementVisualSnapshot,
  viewport: { width: number; height: number },
): VisualComparisonResult {
  const mismatches: string[] = [];
  const xTolerance = Math.max(12, viewport.width * 0.015);
  const yTolerance = Math.max(10, viewport.height * 0.015);
  const widthTolerance = Math.max(6, Math.min(24, Math.max(reference.width * 0.05, 6)));
  const heightTolerance = Math.max(6, Math.min(20, Math.max(reference.height * 0.08, 6)));

  if (Math.abs(actual.x - reference.x) > xTolerance) mismatches.push(`x ${round(actual.x)}px vs ${round(reference.x)}px`);
  if (Math.abs(actual.y - reference.y) > yTolerance) mismatches.push(`y ${round(actual.y)}px vs ${round(reference.y)}px`);
  if (Math.abs(actual.width - reference.width) > widthTolerance) mismatches.push(`width ${round(actual.width)}px vs ${round(reference.width)}px`);
  if (Math.abs(actual.height - reference.height) > heightTolerance) mismatches.push(`height ${round(actual.height)}px vs ${round(reference.height)}px`);
  if (Math.abs(actual.fontSize - reference.fontSize) > 2) mismatches.push(`font-size ${round(actual.fontSize)}px vs ${round(reference.fontSize)}px`);
  if (Math.abs(actual.fontWeight - reference.fontWeight) > 100) mismatches.push(`font-weight ${actual.fontWeight} vs ${reference.fontWeight}`);

  const textColorDistance = colorDistance(reference.color, actual.color);
  if (textColorDistance === null ? reference.color !== actual.color : textColorDistance > 36) mismatches.push(`text color ${actual.color} vs ${reference.color}`);
  if (!transparent(reference.backgroundColor)) {
    const backgroundDistance = colorDistance(reference.backgroundColor, actual.backgroundColor);
    if (backgroundDistance === null ? reference.backgroundColor !== actual.backgroundColor : backgroundDistance > 36) mismatches.push(`background ${actual.backgroundColor} vs ${reference.backgroundColor}`);
  }

  const summary = `Reference ${round(reference.x)},${round(reference.y)} ${round(reference.width)}×${round(reference.height)}; actual ${round(actual.x)},${round(actual.y)} ${round(actual.width)}×${round(actual.height)}.`;
  return mismatches.length
    ? { passed: false, details: `${summary} Material visual deviation: ${mismatches.join('; ')}.` }
    : { passed: true, details: `${summary} Geometry, typography, and key colors remain within bounded reference tolerances.` };
}
