import { describe, expect, it } from 'vitest';
import { compareElementVisualSnapshots, contractVisualRequirements, type ElementVisualSnapshot } from './visual-fidelity.js';

const reference: ElementVisualSnapshot = {
  x: 0,
  y: 72,
  width: 240,
  height: 48,
  fontSize: 32,
  fontWeight: 700,
  color: 'rgb(17, 24, 39)',
  backgroundColor: 'rgb(16, 24, 40)',
};

const viewport = { width: 1440, height: 900 };

describe('reference-derived visual fidelity', () => {
  it('accepts small rendering differences that preserve the approved design', () => {
    expect(compareElementVisualSnapshots(reference, {
      ...reference,
      x: 8,
      y: 78,
      width: 246,
      height: 50,
      fontSize: 31,
      fontWeight: 600,
      color: 'rgb(20, 27, 42)',
      backgroundColor: 'rgb(17, 24, 39)',
    }, viewport)).toMatchObject({ passed: true });
  });

  it('rejects material layout, typography, and color changes', () => {
    const result = compareElementVisualSnapshots(reference, {
      ...reference,
      x: 320,
      y: 180,
      width: 420,
      height: 96,
      fontSize: 18,
      fontWeight: 400,
      color: 'rgb(245, 245, 245)',
      backgroundColor: 'rgb(255, 255, 255)',
    }, viewport);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('Material visual deviation');
    expect(result.details).toContain('width');
    expect(result.details).toContain('font-size');
    expect(result.details).toContain('background');
  });

  it('derives visual checks only for contract-significant elements and de-duplicates interaction targets', () => {
    expect(contractVisualRequirements({
      schemaVersion: 1,
      viewport,
      requiredText: ['Settings'],
      requiredElements: [{ role: 'button', name: 'Save Changes' }],
      interactions: [{ id: 'save', action: 'click', target: { role: 'button', name: 'Save Changes' }, expected: { requiredText: ['Saved'], requiredElements: [] } }],
    })).toEqual([{ role: 'button', name: 'Save Changes' }]);
  });

  it('does not enforce transparent reference backgrounds', () => {
    expect(compareElementVisualSnapshots({ ...reference, backgroundColor: 'rgba(0, 0, 0, 0)' }, { ...reference, backgroundColor: 'rgb(255, 255, 255)' }, viewport)).toMatchObject({ passed: true });
  });
});
