import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RevisionPreviewService, type PreviewRuntime } from './revision-preview-service.js';
import { credentializePreviewHtml, rewriteStaticPreviewCss, rewriteStaticPreviewHtml } from './revision-preview.js';
import type { DesignReferenceStore } from './design-reference-store.js';
import type { JsonStore } from './store.js';
import type { MissionWorkspacePort } from './workspace.js';

const missionId = '00000000-0000-4000-8000-000000000001';
const revisionId = '00000000-0000-4000-8000-000000000002';
const store = { snapshot: () => ({ missions: [{ id: missionId }], missionWorkspaceRevisions: [{ id: revisionId, missionId }], designRevisions: [], missionArtifacts: [] }) } as unknown as JsonStore;
const references = {} as DesignReferenceStore;
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exampleContentPath = '/api/missions/00000000-0000-4000-8000-000000000001/previews/00000000-0000-4000-8000-000000000099/content/';

const serviceFor = async (source: string, runtime: PreviewRuntime) => {
  const root = await mkdtemp(path.join(tmpdir(), 'preview-assets-root-'));
  const workspaces = { async resolveMissionRevision(mission: string, revision: { id: string }) { if (mission !== missionId || revision.id !== revisionId) throw new Error('integrity'); return source; } } as MissionWorkspacePort;
  const service = new RevisionPreviewService(store, workspaces, references, runtime, root);
  await service.initialize();
  return service;
};

describe('immutable preview asset fidelity', () => {
  it('normalizes only checkpoint-local root-relative static resource URLs', () => {
    const html = rewriteStaticPreviewHtml('<link href="/styles.css"><script src="/scripts/app.js"></script><img src="/images/a.svg" srcset="/images/a.svg 1x, /images/b.svg 2x"><div style="background:url(/images/bg.svg)"></div><style>@import "/css/theme.css";.hero{background:url(/images/bg.svg)}</style><a href="https://example.com">external</a><img src="//cdn.example/a.svg"><a href="#menu">fragment</a><img src="data:image/svg+xml;base64,abc"><script src="scripts/local.js"></script>', exampleContentPath);
    expect(html).toContain(`href="${exampleContentPath}styles.css"`);
    expect(html).toContain(`src="${exampleContentPath}scripts/app.js"`);
    expect(html).toContain(`src="${exampleContentPath}images/a.svg"`);
    expect(html).toContain(`srcset="${exampleContentPath}images/a.svg 1x, ${exampleContentPath}images/b.svg 2x"`);
    expect(html).toContain(`style="background:url(${exampleContentPath}images/bg.svg)"`);
    expect(html).toContain(`@import "${exampleContentPath}css/theme.css"`);
    expect(html).toContain(`background:url(${exampleContentPath}images/bg.svg)`);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('src="//cdn.example/a.svg"');
    expect(html).toContain('href="#menu"');
    expect(html).toContain('src="data:image/svg+xml;base64,abc"');
    expect(html).toContain('src="scripts/local.js"');

    const css = rewriteStaticPreviewCss('@import "/css/theme.css";.hero{background:url(/images/bg.svg)}.cdn{background:url(//cdn.example/bg.svg)}.data{background:url(data:image/png;base64,abc)}', exampleContentPath);
    expect(css).toContain(`@import "${exampleContentPath}css/theme.css"`);
    expect(css).toContain(`url(${exampleContentPath}images/bg.svg)`);
    expect(css).toContain('url(//cdn.example/bg.svg)');
    expect(css).toContain('url(data:image/png;base64,abc)');
    expect(() => rewriteStaticPreviewCss('body{}', 'not-absolute')).toThrow('Invalid preview content path');
  });

  it('credentials sandboxed browser subresources without touching unrelated markup', () => {
    const html = credentializePreviewHtml('<link rel="stylesheet" href="./assets/app.css"><link rel="modulepreload" crossorigin href="./assets/chunk.js"><script type="module" crossorigin="anonymous" src="./assets/app.js"></script><img src="./logo.svg"><source srcset="./a.webp 1x, ./b.webp 2x"><meta name="x" content="y"><script>inline()</script>');
    expect(html).toContain('<link rel="stylesheet" href="./assets/app.css" crossorigin="use-credentials">');
    expect(html).toContain('<link rel="modulepreload" crossorigin="use-credentials" href="./assets/chunk.js">');
    expect(html).toContain('<script type="module" crossorigin="use-credentials" src="./assets/app.js"></script>');
    expect(html).toContain('<img src="./logo.svg" crossorigin="use-credentials">');
    expect(html).toContain('<source srcset="./a.webp 1x, ./b.webp 2x" crossorigin="use-credentials">');
    expect(html).toContain('<meta name="x" content="y">');
    expect(html).toContain('<script>inline()</script>');
    expect(html).not.toContain('crossorigin="anonymous"');
  });

  it('materializes and serves root-level and conventional nested static assets through the opaque root', async () => {
    const source = await mkdtemp(path.join(tmpdir(), 'preview-static-assets-'));
    await mkdir(path.join(source, 'scripts'));
    await mkdir(path.join(source, 'images'));
    await mkdir(path.join(source, 'css'));
    await writeFile(path.join(source, 'index.html'), '<link rel="stylesheet" href="/styles.css"><script src="/scripts/app.js"></script><img src="/images/donut.svg" srcset="/images/donut.svg 1x, /images/donut-2x.svg 2x">');
    await writeFile(path.join(source, 'styles.css'), '@import "/css/theme.css";body{background:url(/images/donut.svg)}');
    await writeFile(path.join(source, 'css', 'theme.css'), '.menu{background:url(/images/donut.svg)}');
    await writeFile(path.join(source, 'scripts', 'app.js'), 'document.documentElement.dataset.ready="true";');
    await writeFile(path.join(source, 'images', 'donut.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(path.join(source, 'images', 'donut-2x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

    const service = await serviceFor(source, { async prepare() { throw new Error('static preview must not invoke Vite preparation'); } });
    const created = await service.create(missionId, { kind: 'workspace', revisionId });
    expect(created.session.profile).toBe('static-html');
    const prefix = created.session.contentPath;

    const html = await service.asset(missionId, created.session.id, created.token, 'index.html');
    expect(html.bytes.toString()).toContain(`href="${prefix}styles.css"`);
    expect(html.bytes.toString()).toContain(`src="${prefix}scripts/app.js"`);
    expect(html.bytes.toString()).toContain(`src="${prefix}images/donut.svg"`);
    expect(html.bytes.toString()).toContain(`srcset="${prefix}images/donut.svg 1x, ${prefix}images/donut-2x.svg 2x"`);

    const css = await service.asset(missionId, created.session.id, created.token, 'styles.css');
    expect(css.mediaType).toBe('text/css; charset=utf-8');
    expect(css.bytes.toString()).toContain(`@import "${prefix}css/theme.css"`);
    expect(css.bytes.toString()).toContain(`url(${prefix}images/donut.svg)`);

    const nestedCss = await service.asset(missionId, created.session.id, created.token, 'css/theme.css');
    expect(nestedCss.bytes.toString()).toContain(`url(${prefix}images/donut.svg)`);

    const script = await service.asset(missionId, created.session.id, created.token, 'scripts/app.js');
    expect(script.mediaType).toBe('text/javascript; charset=utf-8');
    expect(script.bytes.toString()).toContain('dataset.ready');

    const image = await service.asset(missionId, created.session.id, created.token, 'images/donut.svg');
    expect(image.mediaType).toBe('image/svg+xml');
    expect(image.bytes.toString()).toContain('<svg');
  });

  it('serves the immutable inline interaction with an exact CSP hash', async () => {
    const source = await mkdtemp(path.join(tmpdir(), 'preview-inline-script-'));
    const interaction = 'document.querySelector("button").addEventListener("click",()=>document.body.dataset.clicked="true");';
    await writeFile(path.join(source, 'index.html'), `<button>Run app</button><script>${interaction}</script>`);
    const service = await serviceFor(source, { async prepare() { throw new Error('static preview must not invoke Vite preparation'); } });
    const created = await service.create(missionId, { kind: 'workspace', revisionId });
    const html = await service.asset(missionId, created.session.id, created.token, 'index.html');
    expect(html.headers['content-security-policy']).toContain(`'sha256-${createHash('sha256').update(interaction).digest('base64')}'`);
    expect(html.headers['content-security-policy']).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(html.headers['content-security-policy']).toContain("connect-src 'none'");
  });

  it('serves generated Vite CSS and JS beneath the opaque preview content path', async () => {
    const source = await mkdtemp(path.join(tmpdir(), 'preview-vite-assets-'));
    await mkdir(path.join(source, 'src'));
    await writeFile(path.join(source, 'index.html'), '<div id="app"></div><script type="module" src="/src/main.js"></script>');
    await writeFile(path.join(source, 'src', 'main.js'), 'document.querySelector("#app").textContent="ready";');
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ dependencies: { vite: '1' } }));

    const runtime: PreviewRuntime = {
      async prepare({ outputRoot, profile }) {
        expect(profile).toBe('vite-vanilla');
        await mkdir(outputRoot);
        await mkdir(path.join(outputRoot, 'assets'));
        await writeFile(path.join(outputRoot, 'index.html'), '<link rel="stylesheet" href="./assets/app.css"><script type="module" crossorigin src="./assets/app.js"></script><div id="app"></div>');
        await writeFile(path.join(outputRoot, 'assets', 'app.css'), '#app{display:block}');
        await writeFile(path.join(outputRoot, 'assets', 'app.js'), 'document.querySelector("#app").textContent="ready";');
      },
    };
    const service = await serviceFor(source, runtime);
    const created = await service.create(missionId, { kind: 'workspace', revisionId });
    expect(created.session.profile).toBe('vite-vanilla');
    expect(created.session.contentPath).toMatch(/\/content\/$/);

    const html = await service.asset(missionId, created.session.id, created.token, 'index.html');
    expect(html.bytes.toString()).toContain('./assets/app.css');
    expect(html.bytes.toString()).toContain('./assets/app.js');
    expect((await service.asset(missionId, created.session.id, created.token, 'assets/app.css')).mediaType).toBe('text/css; charset=utf-8');
    expect((await service.asset(missionId, created.session.id, created.token, 'assets/app.js')).mediaType).toBe('text/javascript; charset=utf-8');
  });

  it('pins the Conductor-owned Vite build and fixed framework runtimes', async () => {
    const config = await readFile(path.join(serverRoot, 'preview-vite.config.mjs'), 'utf8');
    expect(config).toContain("base: './'");
    expect(config).toContain("@vitejs/plugin-vue/dist/index.mjs");
    expect(config).toContain('plugins: [vue()]');
    expect(config).toContain('react/jsx-runtime');
    expect(config).toContain('react/jsx-dev-runtime');
    expect(config).toContain('assetsInlineLimit: maxInlineAssetBytes');
    expect(config).toContain('inlineDynamicImports: true');

    const preparation = await readFile(path.join(serverRoot, 'preview-prepare.mjs'), 'utf8');
    expect(preparation).toContain('inlinePreparedViteEntry');
    expect(preparation).toContain("html.replace(tag, `<style>${css}</style>`)");
    expect(preparation).toContain('html.replace(tag, `${openingTag}${javascript}</script>`)');

    const dockerfile = await readFile(path.join(serverRoot, 'Dockerfile.verifier'), 'utf8');
    expect(dockerfile).toContain('@vitejs/plugin-vue@6.0.8');
    expect(dockerfile).toContain('@vue/compiler-sfc@3.5.28');
    expect(dockerfile).toContain('vue@3.5.28');
  });
});
