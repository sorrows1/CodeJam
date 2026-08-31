import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export type PreviewProfile = 'static-html' | 'vite-react' | 'vite-vue' | 'vite-vanilla';
const MAX_PACKAGE_BYTES = 64 * 1024;
export const MAX_PREVIEW_FILES = 512;
export const MAX_PREVIEW_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_TOTAL_BYTES = 8 * 1024 * 1024;
export const PREVIEW_CONTAINER_LABEL = 'io.conductor.preview=true';
const previewAssetExtensions = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2']);
const previewSourceOnlyExtensions = new Set(['.ts', '.tsx', '.jsx', '.vue']);
const previewSourceRoots = new Set(['src', 'public', 'assets']);
const blockedPreviewSegments = new Set(['AGENTS.md', 'node_modules', 'dist']);

const existsRegular = async (file: string): Promise<boolean> => stat(file).then((value) => value.isFile()).catch(() => false);
const hasBlockedPreviewSegment = (segments: readonly string[]): boolean => segments.some((segment) => segment.startsWith('.') || blockedPreviewSegments.has(segment));
const assertPreviewContentPath = (contentPath: string): string => {
  if (!contentPath.startsWith('/') || !contentPath.endsWith('/')) throw new Error('Invalid preview content path');
  return contentPath;
};
const rewriteRootRelativeUrl = (value: string, contentPath: string): string => value.replace(/^(\s*)\/(?!\/)/, (_match, whitespace: string) => `${whitespace}${contentPath}`);
const rewriteSrcset = (value: string, contentPath: string): string => value.replace(/(^|,)(\s*)\/(?!\/)/g, (_match, separator: string, whitespace: string) => `${separator}${whitespace}${contentPath}`);

/** Detects only the fixed Phase 14 profiles. It never reads or executes scripts or Vite config. */
export async function detectPreviewProfile(root: string): Promise<PreviewProfile> {
  if (!path.isAbsolute(root)) throw new Error('Preview root must be absolute');
  if (!await existsRegular(path.join(root, 'index.html'))) throw new Error('Preview requires a regular root index.html');
  const packagePath = path.join(root, 'package.json');
  if (!await existsRegular(packagePath)) return 'static-html';
  const raw = await readFile(packagePath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_PACKAGE_BYTES) throw new Error('Preview package.json exceeds the bound');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const dependencies = { ...(parsed.dependencies as Record<string, unknown> | undefined), ...(parsed.devDependencies as Record<string, unknown> | undefined) };
  if (typeof dependencies.vite !== 'string') throw new Error('Unsupported preview profile');
  if (typeof dependencies.react === 'string' && typeof dependencies['react-dom'] === 'string') return 'vite-react';
  if (typeof dependencies.vue === 'string') return 'vite-vue';
  if (await existsRegular(path.join(root, 'src', 'main.js')) || await existsRegular(path.join(root, 'src', 'main.ts'))) return 'vite-vanilla';
  throw new Error('Unsupported Vite preview profile');
}

/**
 * Allows only bounded browser-consumable assets plus the fixed Vite source
 * roots. Static checkpoints commonly keep CSS/JS/images beside index.html or
 * in folders such as css/ and images/, so those safe asset types must not be
 * dropped merely because they are outside src/public/assets.
 */
export function isPreviewSourcePathAllowed(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length || hasBlockedPreviewSegment(segments)) return false;
  const name = segments.at(-1)!;
  if (/^(?:vite|postcss|tailwind)\.config\./i.test(name) || name === '.npmrc') return false;
  if (segments.length === 1 && name === 'package.json') return true;
  const extension = path.posix.extname(name).toLowerCase();
  if (previewAssetExtensions.has(extension)) return true;
  return segments.length > 1 && previewSourceRoots.has(segments[0]!) && previewSourceOnlyExtensions.has(extension);
}

export function isPreviewAssetPathAllowed(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments.length > 0 && !hasBlockedPreviewSegment(segments) && previewAssetExtensions.has(path.posix.extname(segments.at(-1)!).toLowerCase());
}

/** Keeps root-relative static resources inside the exact opaque preview session. */
export function rewriteStaticPreviewCss(css: string, contentPath: string): string {
  const prefix = assertPreviewContentPath(contentPath);
  return css
    .replace(/url\(\s*(["']?)\/(?!\/)([^)"']*?)\1\s*\)/gi, (_match, quote: string, value: string) => `url(${quote}${prefix}${value}${quote})`)
    .replace(/(@import\s+)(["'])\/(?!\/)([^"']+)\2/gi, (_match, importPrefix: string, quote: string, value: string) => `${importPrefix}${quote}${prefix}${value}${quote}`);
}

/**
 * Rewrites only browser resource/navigation attributes. External, scheme-relative,
 * fragment, data, and already-relative references are left unchanged.
 */
export function rewriteStaticPreviewHtml(html: string, contentPath: string): string {
  const prefixPath = assertPreviewContentPath(contentPath);
  let rewritten = html.replace(
    /(\b(?:src|href|poster)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
    (_match, prefix: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
      const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
      const next = rewriteRootRelativeUrl(value, prefixPath);
      if (doubleQuoted !== undefined) return `${prefix}"${next}"`;
      if (singleQuoted !== undefined) return `${prefix}'${next}'`;
      return `${prefix}${next}`;
    },
  );
  rewritten = rewritten.replace(
    /(\bsrcset\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi,
    (_match, prefix: string, doubleQuoted: string | undefined, singleQuoted: string | undefined) => {
      const value = doubleQuoted ?? singleQuoted ?? '';
      const next = rewriteSrcset(value, prefixPath);
      return doubleQuoted !== undefined ? `${prefix}"${next}"` : `${prefix}'${next}'`;
    },
  );
  rewritten = rewritten.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_match, open: string, css: string, close: string) => `${open}${rewriteStaticPreviewCss(css, prefixPath)}${close}`);
  rewritten = rewritten.replace(
    /(\bstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi,
    (_match, prefix: string, doubleQuoted: string | undefined, singleQuoted: string | undefined) => {
      const value = doubleQuoted ?? singleQuoted ?? '';
      const next = rewriteStaticPreviewCss(value, prefixPath);
      return doubleQuoted !== undefined ? `${prefix}"${next}"` : `${prefix}'${next}'`;
    },
  );
  return rewritten;
}

/**
 * Sandboxed preview documents intentionally have an opaque origin. Browser
 * subresources therefore need an explicit credential mode so the short-lived,
 * path-scoped HttpOnly preview cookie accompanies CSS/JS/image requests.
 */
export function credentializePreviewHtml(html: string): string {
  return html.replace(/<(link|script|img|source)\b([^>]*)>/gi, (match, tag: string, attributes: string) => {
    const lower = tag.toLowerCase();
    const eligible = lower === 'link' ? /\bhref\s*=/i.test(attributes) : lower === 'script' ? /\bsrc\s*=/i.test(attributes) : /\b(?:src|srcset)\s*=/i.test(attributes);
    if (!eligible) return match;
    const selfClosing = /\/\s*$/.test(attributes);
    let body = selfClosing ? attributes.replace(/\/\s*$/, '') : attributes;
    const crossorigin = /\s+crossorigin(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/i;
    body = crossorigin.test(body) ? body.replace(crossorigin, ' crossorigin="use-credentials"') : `${body} crossorigin="use-credentials"`;
    return `<${tag}${body}${selfClosing ? ' /' : ''}>`;
  });
}

const MAX_INLINE_PREVIEW_SCRIPTS = 32;
const MAX_PREVIEW_CSP_BYTES = 8 * 1024;

/**
 * Authorizes only the exact inline script bodies present in the immutable
 * preview document. This keeps `unsafe-inline` disabled while allowing valid
 * static checkpoints and Vite output that intentionally retain inline app
 * bootstrap/interaction code.
 */
export function buildPreviewSecurityHeaders(html?: string): PreviewSecurityHeaders {
  if (html === undefined) return PREVIEW_SECURITY_HEADERS;
  const hashes = new Set<string>();
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(match[1] ?? '')) continue;
    const body = match[2] ?? '';
    if (!body) continue;
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
    if (hashes.size > MAX_INLINE_PREVIEW_SCRIPTS) throw new Error('Preview inline script policy exceeds the bound');
  }
  if (hashes.size === 0) return PREVIEW_SECURITY_HEADERS;
  const contentSecurityPolicy = PREVIEW_SECURITY_HEADERS['content-security-policy'].replace("script-src 'self'", `script-src 'self' ${[...hashes].join(' ')}`);
  if (Buffer.byteLength(contentSecurityPolicy, 'utf8') > MAX_PREVIEW_CSP_BYTES) throw new Error('Preview inline script policy exceeds the bound');
  return { ...PREVIEW_SECURITY_HEADERS, 'content-security-policy': contentSecurityPolicy };
}

/**
 * A sandbox without `allow-same-origin` has an opaque origin, so CSP `self`
 * cannot authorize even the exact Conductor asset route that supplied the
 * document. Add only that session's authenticated content-path prefix for the
 * browser-consumable resource directives.
 */
export function scopePreviewAssetSecurityHeaders(headers: PreviewSecurityHeaders, contentUrl: string): PreviewSecurityHeaders {
  let parsed: URL;
  try { parsed = new URL(contentUrl); } catch { throw new Error('Invalid preview content URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.endsWith('/')) throw new Error('Invalid preview content URL');
  const source = parsed.toString();
  let policy = headers['content-security-policy'];
  for (const directive of ['script-src', 'style-src', 'img-src', 'connect-src'] as const) {
    const pattern = new RegExp(`(?:^|;\\s*)${directive}\\s+([^;]*)`);
    if (pattern.test(policy)) policy = policy.replace(pattern, (match, values: string) => match.replace(values, `${values} ${source}`));
    else policy += `; ${directive} ${source}`;
  }
  policy += `; font-src ${source}`;
  return { ...headers, 'content-security-policy': policy };
}

export function isAllowedPreviewRoute(requestPath: string, allowedRoutes: readonly string[]): boolean {
  let decoded: string;
  try { decoded = decodeURIComponent(requestPath); } catch { return false; }
  const candidate = `/${decoded.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/$/, '')}`;
  if (candidate.includes('..') || /[?#]/.test(candidate)) return false;
  const normalized = candidate === '' ? '/' : candidate;
  return allowedRoutes.some((route) => (route.length > 1 ? route.replace(/\/$/, '') : route) === normalized);
}

export function buildPreviewContainerArgs(input: { sourceRoot: string; cidFile: string; identity: string; image: string; user: string; cpuLimit?: number; memoryLimit?: string; pidsLimit?: number }): string[] {
  if (!path.isAbsolute(input.sourceRoot) || !path.isAbsolute(input.cidFile)) throw new Error('Preview mounts must be absolute');
  if (!/^conductor-preview-[0-9a-f-]{36}$/i.test(input.identity)) throw new Error('Invalid preview container identity');
  return ['run', '--rm', '--name', input.identity, '--cidfile', input.cidFile, '--label', PREVIEW_CONTAINER_LABEL, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', input.user, '--cpus', String(input.cpuLimit ?? 1), '--memory', input.memoryLimit ?? '512m', '--pids-limit', String(input.pidsLimit ?? 64), '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m', '--tmpfs', '/output:rw,nosuid,nodev,noexec,size=10m', '--mount', `type=bind,source=${input.sourceRoot},target=/source,readonly`, '--env', 'NODE_ENV=production', '--entrypoint', 'node', input.image, '/preview/prepare.mjs', '/source', '/output'];
}

export function resolvePreviewAsset(root: string, requestPath: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(requestPath); } catch { throw new Error('Invalid preview asset path'); }
  const normalized = decoded.replaceAll('\\', '/').replace(/^\/+/, '') || 'index.html';
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) throw new Error('Invalid preview asset path');
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid preview asset path');
  if (!isPreviewAssetPathAllowed(relative)) throw new Error('Invalid preview asset path');
  return resolved;
}

export interface PreviewSecurityHeaders {
  'content-security-policy': string;
  'referrer-policy': string;
  'cache-control': string;
  'x-content-type-options': string;
}

export const PREVIEW_SECURITY_HEADERS: PreviewSecurityHeaders = { 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'; base-uri 'none'", 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
