import { describe, expect, it } from 'vitest';
import { canonicalizeDesignContract, hashDesignContract, parseDesignContract } from './design-contract.js';

const valid = { schemaVersion: 1, viewport: { width: 1280, height: 720 }, requiredText: ['Welcome'], requiredElements: [{ role: 'button', name: 'Continue' }], interactions: [{ id: 'continue', action: 'click', target: { role: 'button', name: 'Continue' }, expected: { requiredText: ['Done'], requiredElements: [] } }] };

describe('DesignContractV1', () => {
  it('validates and canonicalizes deterministic intent', () => {
    const contract = parseDesignContract(valid);
    expect(canonicalizeDesignContract(contract)).toBe(JSON.stringify(valid));
    expect(hashDesignContract(contract)).toBe(hashDesignContract(parseDesignContract(JSON.stringify(valid))));
  });

  it('rejects unknown keys, duplicates, bad bounds, and empty expectations', () => {
    expect(() => parseDesignContract({ ...valid, extra: true })).toThrow();
    expect(() => parseDesignContract({ ...valid, viewport: { width: 319, height: 720 } })).toThrow();
    expect(() => parseDesignContract({ ...valid, requiredText: ['Welcome', 'Welcome'] })).toThrow();
    expect(() => parseDesignContract({ ...valid, interactions: [{ ...valid.interactions[0], expected: { requiredText: [], requiredElements: [] } }] })).toThrow();
    expect(() => parseDesignContract({ ...valid, viewport: { ...valid.viewport, breakpoints: [320] } })).toThrow();
    expect(() => parseDesignContract({ ...valid, requiredElements: [{ role: 'button', name: 'Continue', selector: '#continue' }] })).toThrow();
  });
});
