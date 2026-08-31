import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPreviewContainerArgs, buildPreviewSecurityHeaders, detectPreviewProfile, isPreviewSourcePathAllowed, PREVIEW_SECURITY_HEADERS, resolvePreviewAsset, scopePreviewAssetSecurityHeaders } from './revision-preview.js';

describe('immutable revision preview boundaries', () => {
  it.each([['react', { vite: '1', react: '1', 'react-dom': '1' }, 'vite-react'], ['vue', { vite: '1', vue: '1' }, 'vite-vue'], ['vanilla', { vite: '1' }, 'vite-vanilla']] as const)('accepts the fixed %s Vite profile', async (_name, dependencies, expected) => {
    const root = await mkdtemp(path.join(tmpdir(), 'preview-')); await mkdir(path.join(root, 'src')); await writeFile(path.join(root, 'index.html'), '<main/>'); await writeFile(path.join(root, 'src', 'main.js'), ''); await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'evil-command' }, dependencies }));
    expect(await detectPreviewProfile(root)).toBe(expected);
  });
  it('accepts static HTML and rejects Python/unknown roots', async () => {
    const staticRoot = await mkdtemp(path.join(tmpdir(), 'preview-static-')); await writeFile(path.join(staticRoot, 'index.html'), '<main/>'); expect(await detectPreviewProfile(staticRoot)).toBe('static-html');
    const pythonRoot = await mkdtemp(path.join(tmpdir(), 'preview-python-')); await writeFile(path.join(pythonRoot, 'app.py'), ''); await expect(detectPreviewProfile(pythonRoot)).rejects.toThrow('index.html');
  });
  it('preserves bounded static assets without admitting control or arbitrary source files', () => {
    expect(isPreviewSourcePathAllowed('index.html')).toBe(true);
    expect(isPreviewSourcePathAllowed('styles.css')).toBe(true);
    expect(isPreviewSourcePathAllowed('script.js')).toBe(true);
    expect(isPreviewSourcePathAllowed('css/site.css')).toBe(true);
    expect(isPreviewSourcePathAllowed('images/donut.svg')).toBe(true);
    expect(isPreviewSourcePathAllowed('fonts/site.woff2')).toBe(true);
    expect(isPreviewSourcePathAllowed('src/main.ts')).toBe(true);
    expect(isPreviewSourcePathAllowed('src/App.tsx')).toBe(true);
    expect(isPreviewSourcePathAllowed('App.tsx')).toBe(false);
    expect(isPreviewSourcePathAllowed('vite.config.js')).toBe(false);
    expect(isPreviewSourcePathAllowed('postcss.config.js')).toBe(false);
    expect(isPreviewSourcePathAllowed('.conductor/secret.js')).toBe(false);
    expect(isPreviewSourcePathAllowed('node_modules/pkg/index.js')).toBe(false);
    expect(isPreviewSourcePathAllowed('dist/assets/app.js')).toBe(false);
  });
  it('uses a fixed networkless container command and refuses traversal', () => {
    const args = buildPreviewContainerArgs({ sourceRoot: path.resolve('source'), cidFile: path.resolve('preview.cid'), identity: 'conductor-preview-00000000-0000-4000-8000-000000000001', image: 'preview@sha256:abc', user: '1000:1000' });
    expect(args).toEqual(expect.arrayContaining(['--name', 'conductor-preview-00000000-0000-4000-8000-000000000001', '--cidfile', path.resolve('preview.cid'), '--label', 'io.conductor.preview=true', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/output:rw,nosuid,nodev,noexec,size=10m', '--env', 'NODE_ENV=production']));
    expect(args.join(' ')).not.toContain('target=/output');
    expect(args.join(' ')).not.toContain('evil-command');
    expect(() => resolvePreviewAsset(path.resolve('output'), '../secret')).toThrow('Invalid');
    expect(PREVIEW_SECURITY_HEADERS['content-security-policy']).toContain("connect-src 'none'");
  });
  it('authorizes exact immutable inline scripts without enabling arbitrary inline code', () => {
    const first = 'document.documentElement.dataset.ready="true";';
    const second = 'window.addEventListener("click", () => {});';
    const headers = buildPreviewSecurityHeaders(`<script>${first}</script><script src="./app.js"></script><script type="module">${second}</script>`);
    expect(headers['content-security-policy']).toContain(`'sha256-${createHash('sha256').update(first).digest('base64')}'`);
    expect(headers['content-security-policy']).toContain(`'sha256-${createHash('sha256').update(second).digest('base64')}'`);
    expect(headers['content-security-policy']).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(headers['content-security-policy']).toContain("connect-src 'none'");
  });
  it('refuses an unbounded inline-script policy', () => {
    const html = Array.from({ length: 33 }, (_, index) => `<script>window.value${index}=${index}</script>`).join('');
    expect(() => buildPreviewSecurityHeaders(html)).toThrow('exceeds the bound');
  });
  it('scopes opaque-origin browser assets to the exact authenticated session path', () => {
    const contentUrl = 'https://launchpad.example/api/missions/00000000-0000-4000-8000-000000000001/previews/00000000-0000-4000-8000-000000000002/content/';
    const headers = scopePreviewAssetSecurityHeaders(PREVIEW_SECURITY_HEADERS, contentUrl);
    for (const directive of ['script-src', 'style-src', 'img-src', 'font-src', 'connect-src']) expect(headers['content-security-policy']).toContain(`${directive} `);
    expect(headers['content-security-policy'].split(contentUrl)).toHaveLength(6);
    expect(headers['content-security-policy']).toContain(`connect-src 'none' ${contentUrl}`);
    expect(() => scopePreviewAssetSecurityHeaders(PREVIEW_SECURITY_HEADERS, 'javascript:alert(1)')).toThrow('Invalid preview content URL');
    expect(() => scopePreviewAssetSecurityHeaders(PREVIEW_SECURITY_HEADERS, 'https://user:secret@example.com/content/')).toThrow('Invalid preview content URL');
  });
});
