import { describe, expect, it } from 'vitest';
import { captureCanonicalJpeg, MAX_SCREENSHOT_BYTES } from './verification.js';
import type { Page } from 'playwright';

const fakePage = (full: Buffer[], downscaled: Buffer[]) => ({ screenshot: async () => full.shift()!, context: () => ({ newCDPSession: async () => ({ send: async () => ({ data: downscaled.shift()!.toString('base64') }), detach: async () => undefined }) }) }) as unknown as Page;
describe('canonical JPEG encoding', () => {
  it('retains the exact 1440x900 viewport at the first bounded quality', async () => { const result = await captureCanonicalJpeg(fakePage([Buffer.alloc(100)], []), { width: 1440, height: 900 }); expect(result).toMatchObject({ width: 1440, height: 900, quality: 86 }); });
  it('uses the deterministic two-downscale ladder and then refuses overflow', async () => { const oversized = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1); const result = await captureCanonicalJpeg(fakePage([oversized, oversized, oversized], [Buffer.alloc(100)]), { width: 1440, height: 900 }); expect(result).toMatchObject({ width: 1080, height: 675, quality: 70 }); await expect(captureCanonicalJpeg(fakePage([oversized, oversized, oversized], [oversized, oversized]), { width: 1440, height: 900 })).rejects.toThrow('hard evidence bound'); });
});
