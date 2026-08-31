import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { credentializePreviewHtml, scopePreviewAssetSecurityHeaders, scopePreviewFrameAncestor, type PreviewSecurityHeaders } from './revision-preview.js';

type PreviewAsset = { bytes: Buffer; mediaType: string; headers: PreviewSecurityHeaders; status?: number };

export interface PreviewOriginHandle {
  contentUrl: string;
  close(): Promise<void>;
}

export function supportsIsolatedPreviewOrigin(protocol: string, hostname: string): boolean {
  return protocol === 'http' && ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase());
}

function cookieValue(header: string | undefined, name: string): string {
  for (const part of String(header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ''; }
  }
  return '';
}

export async function startPreviewOrigin(input: {
  sessionId: string;
  parentOrigin: string;
  publicHostname: string;
  getAsset(token: string, requestPath: string): Promise<PreviewAsset>;
}): Promise<PreviewOriginHandle> {
  if (!supportsIsolatedPreviewOrigin('http', input.publicHostname)) throw new Error('Isolated preview origin requires a loopback host');
  const parent = new URL(input.parentOrigin);
  if (!['http:', 'https:'].includes(parent.protocol) || parent.username || parent.password || parent.pathname !== '/' || parent.search || parent.hash) throw new Error('Invalid preview parent origin');
  const bindHostname = input.publicHostname === '::1' ? '::1' : '127.0.0.1';
  const urlHostname = input.publicHostname === '::1' ? '[::1]' : input.publicHostname;
  let contentUrl = '';
  const server: Server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new Error('Preview method unavailable');
      const token = cookieValue(request.headers.cookie, `conductor_preview_${input.sessionId}`);
      const requestUrl = new URL(request.url ?? '/', 'http://preview.invalid');
      const asset = await input.getAsset(token, requestUrl.pathname.replace(/^\/+/, ''));
      const body = asset.mediaType.startsWith('text/html') ? Buffer.from(credentializePreviewHtml(asset.bytes.toString('utf8')), 'utf8') : asset.bytes;
      const headers = asset.mediaType.startsWith('text/html')
        ? scopePreviewFrameAncestor(scopePreviewAssetSecurityHeaders(asset.headers, contentUrl), parent.origin)
        : asset.headers;
      response.writeHead(asset.status ?? 200, { ...headers, 'content-type': asset.mediaType });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': `default-src 'none'; frame-ancestors ${parent.origin}` });
      response.end('Preview asset unavailable');
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, bindHostname, () => { server.off('error', onError); resolve(); });
  });
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') { server.close(); throw new Error('Preview origin failed to bind'); }
  contentUrl = `http://${urlHostname}:${address.port}/`;
  let closed = false;
  return {
    contentUrl,
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
