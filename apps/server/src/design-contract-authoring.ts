import {
  canonicalizeDesignContract,
  SUPPORTED_ACCESSIBLE_ROLES,
  type DesignContractV1,
} from './design-contract.js';

export const DESIGN_CONTRACT_AUTHORING_EXAMPLE: DesignContractV1 = {
  schemaVersion: 1,
  viewport: { width: 1440, height: 900 },
  requiredText: ['Fresh Donuts Daily'],
  requiredElements: [
    { role: 'heading', name: 'Fresh Donuts Daily' },
    { role: 'link', name: 'Order Now' },
  ],
  interactions: [
    {
      id: 'order-now',
      action: 'click',
      target: { role: 'link', name: 'Order Now' },
      expected: {
        requiredText: ['Our Donuts'],
        requiredElements: [],
      },
    },
  ],
};

export function designContractAuthoringGuide(): string {
  return [
    'Write every surface contract property as exact DesignContractV1 JSON embedded in design-bundle.json. Do not write a separate design-contract.json file. Use exactly these contract keys and this valid shape:',
    JSON.stringify(DESIGN_CONTRACT_AUTHORING_EXAMPLE, null, 2),
    'Rules: viewport has width and height only (no breakpoints). requiredText is a string array. requiredElements use accessible role/name pairs. Include the smallest useful set of visually significant semantic anchors from the approved composition—important headings, navigation/main regions with accessible names, and meaningful controls—because Conductor derives bounded visual-fidelity enforcement from those exact contract elements. Do not enumerate decorative wrappers or use CSS selectors. Every interaction action is click; target uses role/name; expected contains requiredText and requiredElements. Supported roles: ' + SUPPORTED_ACCESSIBLE_ROLES.join(', ') + '. Validate JSON syntax and this exact shape before finishing.',
  ].join('\n');
}
