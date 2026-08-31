import { afterEach, describe, expect, it } from 'vitest';
import { PREVIEW_SECURITY_HEADERS } from './revision-preview.js';
import { startPreviewOrigin, supportsIsolatedPreviewOrigin, type PreviewOriginHandle } from './preview-origin-server.js';

describe('isolated preview origin', () => {
  let active: PreviewOriginHandle | null = null;
  afterEach(async () => { await active?.close(); active = null; });

  it('serves authenticated approved routes at origin-root paths for normal SPA navigation', async () => {
    const token = 'route-preview-token';
    const seen: string[] = [];
    active = await startPreviewOrigin({
      sessionId: '00000000-0000-4000-8000-000000000001',
      parentOrigin: 'http://localhost:3000',
      publicHostname: '127.0.0.1',
      getAsset: async (supplied, requestPath) => {
        if (supplied !== token) throw new Error('denied');
        seen.push(requestPath);
        if (!['', 'agents'].includes(requestPath)) throw new Error('route unavailable');
        return { bytes: Buffer.from(`<main>${requestPath || 'dashboard'}</main>`), mediaType: 'text/html; charset=utf-8', headers: PREVIEW_SECURITY_HEADERS };
      },
    });
    const cookie = { cookie: `conductor_preview_00000000-0000-4000-8000-000000000001=${token}` };
    const dashboard = await fetch(active.contentUrl, { headers: cookie });
    const agents = await fetch(new URL('/agents', active.contentUrl), { headers: cookie });
    const denied = await fetch(new URL('/settings', active.contentUrl));
    expect(await dashboard.text()).toContain('dashboard');
    expect(await agents.text()).toContain('agents');
    expect(agents.headers.get('content-security-policy')).toContain('frame-ancestors http://localhost:3000');
    expect(denied.status).toBe(404);
    expect(seen).toEqual(['', 'agents']);
  });

  it('limits the auxiliary origin to an HTTP loopback host', () => {
    expect(supportsIsolatedPreviewOrigin('http', 'localhost')).toBe(true);
    expect(supportsIsolatedPreviewOrigin('http', '127.0.0.1')).toBe(true);
    expect(supportsIsolatedPreviewOrigin('https', 'localhost')).toBe(false);
    expect(supportsIsolatedPreviewOrigin('http', 'example.com')).toBe(false);
  });
});
