import { describe, expect, it } from 'vitest';
import { createDesignBundle, createDesignPackage, createPreviewHtml, canonicalizeDesignPackage, parseDesignPackage } from './design-package.js';

const contract = { schemaVersion: 1, viewport: { width: 800, height: 600 }, requiredText: ['Hello'], requiredElements: [], interactions: [] };

describe('Design package', () => {
  it('round trips canonical package data and creates a script-free preview policy', () => {
    const packageValue = createDesignPackage({ indexHtml: '<main>Hello</main>', stylesCss: 'main { color: red; }', contract });
    expect(parseDesignPackage(canonicalizeDesignPackage(packageValue))).toEqual(packageValue);
    const preview = createPreviewHtml(packageValue);
    expect(preview).toContain("script-src 'none'");
    expect(preview).toContain('<style>main { color: red; }</style>');
  });

  it('rejects tampered package hashes', () => {
    const packageValue = createDesignPackage({ indexHtml: '<p>safe</p>', stylesCss: '', contract });
    const tampered = JSON.parse(canonicalizeDesignPackage(packageValue)) as { surfaces: Array<{ files: { indexHtml: string } }> };
    tampered.surfaces[0].files.indexHtml = '<p>changed</p>';
    expect(() => parseDesignPackage(tampered)).toThrow('integrity');
  });

  it('hash-binds every surface in one atomic package', () => {
    const packageValue = createDesignBundle({ primarySurfaceId: 'home', surfaces: [
      { id: 'home', title: 'Home', route: '/', entrypoint: 'src/main.tsx', sourcePaths: ['src/Home.tsx'], sharedDependencies: ['src/Layout.tsx'], states: ['default'], indexHtml: '<main>Home</main>', stylesCss: 'main { color: red; }', contract },
      { id: 'settings', title: 'Settings', route: '/settings', entrypoint: 'src/main.tsx', sourcePaths: ['src/Settings.tsx'], sharedDependencies: ['src/Layout.tsx'], states: ['default', 'saved'], indexHtml: '<main>Settings</main>', stylesCss: 'main { color: blue; }', contract: { ...contract, requiredText: ['Settings'] } },
    ] });
    expect(parseDesignPackage(canonicalizeDesignPackage(packageValue)).surfaces.map((surface) => surface.route)).toEqual(['/', '/settings']);
    const mixed = JSON.parse(canonicalizeDesignPackage(packageValue)) as { surfaces: Array<{ files: { stylesCss: string } }> };
    mixed.surfaces[1]!.files.stylesCss = 'main { color: green; }';
    expect(() => parseDesignPackage(mixed)).toThrow(/integrity/);
  });

  it('reports the exact invalid surface state location without loosening parsing', () => {
    expect(() => createDesignBundle({ primarySurfaceId: 'settings', surfaces: [
      { id: 'settings', title: 'Settings', route: '/settings', entrypoint: 'src/App.tsx', sourcePaths: [], sharedDependencies: [], states: ['default', { name: 'saving' } as unknown as string], indexHtml: '<main>Settings</main>', stylesCss: '', contract },
    ] })).toThrow('Design bundle surfaces[0].states[1] must be a non-empty string');
  });
});
