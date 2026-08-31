import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlaywrightVerifier } from './verification.js';

const contract = {
  schemaVersion: 1 as const,
  viewport: { width: 800, height: 600 },
  requiredText: ['Intent complete'],
  requiredElements: [{ role: 'button' as const, name: 'Reveal result' }],
  interactions: [{ id: 'reveal', action: 'click' as const, target: { role: 'button' as const, name: 'Reveal result' }, expected: { requiredText: ['Verified'], requiredElements: [] } }],
};

const matchingReference = `<!doctype html><html><head><style>
body { margin: 0; font-family: sans-serif; background: #f7f8fa; }
main { width: 680px; margin: 100px auto; padding: 48px; background: white; }
button { padding: 12px 18px; }
</style></head><body><main aria-label="Verification app"><h1>Intent complete</h1><p id="result">Ready</p><button type="button">Reveal result</button></main></body></html>`;

const materiallyDifferentReference = `<!doctype html><html><head><style>
body { margin: 0; font-family: sans-serif; }
main { width: 760px; margin: 0; padding: 0; background: #111827; }
button { position: absolute; left: 24px; top: 24px; width: 320px; height: 96px; font-size: 32px; font-weight: 700; color: white; background: #111827; }
</style></head><body><main aria-label="Verification app"><h1>Intent complete</h1><p>Ready</p><button type="button">Reveal result</button></main></body></html>`;

describe('Playwright protected-reference visual enforcement', () => {
  it('passes a materially matching implementation and denies a noticeably different approved reference', async () => {
    const verifier = new PlaywrightVerifier({ timeoutMs: 15_000 });
    const base = {
      missionId: '00000000-0000-4000-8000-000000000001',
      designRevisionId: '00000000-0000-4000-8000-000000000002',
      workspaceRevisionId: '00000000-0000-4000-8000-000000000003',
      workspacePath: path.resolve('test-fixtures/verification-pass'),
      contract,
    };

    const matching = await verifier.verify({ ...base, correlationId: 'visual-match', referenceHtml: matchingReference });
    expect(matching.status, matching.error?.message).toBe('passed');
    expect(matching.checks.find((item) => item.id === 'element-1')).toMatchObject({ passed: true });

    const different = await verifier.verify({ ...base, correlationId: 'visual-different', referenceHtml: materiallyDifferentReference });
    expect(different.status, different.error?.message).toBe('failed');
    expect(different.checks.some((item) => !item.passed && item.details.includes('Material visual deviation'))).toBe(true);
  }, 30_000);
});
