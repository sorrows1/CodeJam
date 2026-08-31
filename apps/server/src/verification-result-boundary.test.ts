import { describe, expect, it } from 'vitest';
import { appendContainerResultChunk, MAX_CONTAINER_RESULT_BYTES } from './verification.js';

describe('container verifier result boundary', () => {
  it('preserves a structured result larger than the diagnostic log bound', () => {
    const payload = JSON.stringify({ status: 'passed', screenshotBase64: 'a'.repeat(60 * 1024) });
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(16 * 1024);
    expect(appendContainerResultChunk('', payload)).toBe(payload);
  });

  it('fails closed when the structured result exceeds its explicit boundary', () => {
    const oversized = 'a'.repeat(MAX_CONTAINER_RESULT_BYTES + 1);
    expect(() => appendContainerResultChunk('', oversized)).toThrow('container verifier result exceeds the result boundary');
  });
});
