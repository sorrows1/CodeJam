import type { DesignContractV1 } from './design-contract.js';

const settingsContract: DesignContractV1 = {
  schemaVersion: 1,
  viewport: { width: 1440, height: 900 },
  requiredText: ['Settings'],
  requiredElements: [
    { role: 'heading', name: 'Settings' },
    { role: 'button', name: 'Save Changes' },
  ],
  interactions: [
    {
      id: 'save-settings',
      action: 'click',
      target: { role: 'button', name: 'Save Changes' },
      expected: {
        requiredText: ['Saving…'],
        requiredElements: [],
      },
    },
  ],
};

export const DESIGN_BUNDLE_AUTHORING_EXAMPLE = {
  schemaVersion: 1,
  primarySurfaceId: 'settings',
  surfaces: [
    {
      id: 'settings',
      title: 'Settings',
      route: '/settings',
      entrypoint: 'src/App.tsx',
      sourcePaths: ['src/Settings.tsx'],
      sharedDependencies: ['src/Sidebar.tsx'],
      states: ['default', 'saving'],
      indexHtml: '<main><h1>Settings</h1><button>Save Changes</button></main>',
      stylesCss: 'main { max-width: 72rem; margin: 0 auto; }',
      contract: settingsContract,
    },
    {
      id: 'agents',
      title: 'Agents with shared navigation',
      route: '/agents',
      entrypoint: 'src/App.tsx',
      sourcePaths: ['src/Agents.tsx'],
      sharedDependencies: ['src/Sidebar.tsx'],
      states: ['default'],
      indexHtml: '<main><h1>Agents</h1><nav aria-label="Primary"><a href="/settings">Settings</a></nav></main>',
      stylesCss: 'nav a { display: inline-flex; }',
      contract: {
        schemaVersion: 1,
        viewport: { width: 1440, height: 900 },
        requiredText: ['Agents', 'Settings'],
        requiredElements: [
          { role: 'heading', name: 'Agents' },
          { role: 'navigation', name: 'Primary' },
          { role: 'link', name: 'Settings' },
        ],
        interactions: [],
      } satisfies DesignContractV1,
    },
  ],
};

export function designBundleAuthoringGuide(): string {
  return [
    'Write .conductor/design-draft/design-bundle.json as one exact schemaVersion 1 JSON object. Return no alternate schema and write no other file.',
    'Use this complete valid shape example (replace example paths/content with repository-bound values):',
    JSON.stringify(DESIGN_BUNDLE_AUTHORING_EXAMPLE, null, 2),
    'Exact field rules:',
    '- Root keys are exactly schemaVersion, primarySurfaceId, surfaces. schemaVersion is the number 1. primarySurfaceId is one surface id. surfaces is an array of 1-8 objects.',
    '- Every surface has exactly id, title, route, entrypoint, sourcePaths, sharedDependencies, states, indexHtml, stylesCss, contract.',
    '- id, title, route, entrypoint, indexHtml, and stylesCss are strings. route is one string beginning with /, never an array. entrypoint is a non-null repository-relative portable path, never /workspace/... .',
    '- sourcePaths and sharedDependencies are arrays of unique repository-relative path strings. states is an array of unique non-empty strings such as ["default", "saving"]; states entries must never be objects.',
    '- indexHtml is a renderable static representation for that exact surface and stylesCss is its CSS string. contract is exact DesignContractV1 JSON described below.',
    '- Represent a shared surface on multiple routes as separate surface objects with unique ids and routes. Reuse sharedDependencies to bind the common layout/navigation files.',
    '- Treat the Mission goal as the required product change. The rendered surfaces, named states, and contracts must materially demonstrate that requested outcome using repository-bound routes and files.',
    '- Do not merely reproduce the current application unless the Mission goal explicitly asks for no product change. Include contract-significant text, controls, and interactions that uniquely prove the requested outcome.',
    'Before finishing, parse the file as JSON and verify every value type against these rules. A prose claim that the bundle is valid does not substitute for the file contract.',
    'The only permitted write is /workspace/.conductor/design-draft/design-bundle.json. Do not write /workspace/design-contract.json, application source, helper scripts, lockfiles, dependency metadata, or any second validation copy. Temporary validation tools must stay outside /workspace and be removed before finishing.',
  ].join('\n');
}
