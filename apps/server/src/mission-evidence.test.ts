import { describe, expect, it } from 'vitest';
import { addEvent, safeMissionText } from './mission-evidence.js';
import type { Database, Mission } from './types.js';

const mission = (): Mission => ({ id: 'mission-1', goal: 'goal', status: 'pending', participants: [], workflow: { phase: 'designing', designerAgentId: 'designer', builderAgentId: 'builder', latestDesignRevisionId: null, approvedDesignRevisionId: null, implementedWorkspaceRevisionId: null, currentVerificationRunId: null, repairCycle: 0, maxRepairCycles: 2 }, workspace: { owner: 'conductor', key: 'mission-1', state: 'provisioning', source: { kind: 'agent_workspace', agentId: 'designer', agentUpdatedAt: '2026-01-01T00:00:00.000Z' }, currentRevisionId: null, revisionStatus: 'unversioned', nextRevisionSequence: 1 }, currentTaskId: null, nextEventSequence: 1, activeRecoveryCommandId: null, tokenBudget: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', startedAt: null, completedAt: null });
const database = (record: Mission): Database => ({ version: 1, agents: [], messages: [], runs: [], missions: [record], missionTasks: [], taskAttempts: [], missionArtifacts: [], missionEvents: [], missionWorkspaceRevisions: [], missionRecoveryCommands: [], designRevisions: [], verificationRuns: [] });

describe('Mission evidence safety', () => {
  it('redacts JSON-like and assignment secret forms before bounding text', () => {
    const rawSecrets = ['json-secret', 'password with spaces', 'access-secret', 'assignment-secret', 'bearer-secret'];
    const safe = safeMissionText(`{"apiKey":"${rawSecrets[0]}", "password": "${rawSecrets[1]}", "accessToken":"${rawSecrets[2]}"}\nAPI_KEY=${rawSecrets[3]}\nBearer ${rawSecrets[4]}`, 4096).content;
    expect(safe).toContain('"apiKey":"[REDACTED]"');
    expect(safe).toContain('"password": "[REDACTED]"');
    expect(safe).toContain('"accessToken":"[REDACTED]"');
    expect(safe).toContain('API_KEY=[REDACTED]');
    expect(safe).toContain('Bearer [REDACTED]');
    for (const secret of rawSecrets) expect(safe).not.toContain(secret);
  });

  it('redacts cookie, authorization, and provider access-key forms in JSON and assignments', () => {
    const rawSecrets = {
      cookie: 'cookie-secret',
      setCookie: 'set-cookie-secret',
      accessKey: 'access-key-secret',
      secretKey: 'secret-key-secret',
      awsAccessKey: 'aws-access-key-secret',
      awsSecretKey: 'aws-secret-key-secret',
    };
    const safe = safeMissionText([
      `Cookie: ${rawSecrets.cookie}`,
      `Set-Cookie=${rawSecrets.setCookie}`,
      `access-key-id=${rawSecrets.accessKey}`,
      `secret-key=${rawSecrets.secretKey}`,
      `AWS_ACCESS_KEY_ID=${rawSecrets.awsAccessKey}`,
      'Basic basic-authorization-secret',
      JSON.stringify({ cookie: rawSecrets.cookie, setCookie: rawSecrets.setCookie, accessKeyId: rawSecrets.accessKey, secretAccessKey: rawSecrets.awsSecretKey }),
    ].join('\n')).content;

    expect(safe).toContain('Cookie: [REDACTED]');
    expect(safe).toContain('Set-Cookie=[REDACTED]');
    expect(safe).toContain('access-key-id=[REDACTED]');
    expect(safe).toContain('secret-key=[REDACTED]');
    expect(safe).toContain('AWS_ACCESS_KEY_ID=[REDACTED]');
    expect(safe).toContain('Basic [REDACTED]');
    expect(safe).not.toContain('basic-authorization-secret');
    for (const secret of Object.values(rawSecrets)) expect(safe).not.toContain(secret);
  });

  it('redacts structured secret keys and serializes event details within 8 KiB', () => {
    const record = mission();
    const state = database(record);
    const details = { apiKey: 'raw-api-secret', password: 'raw-password', accessToken: 'raw-access-token', ...Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`field-${index}-密钥`, '界'.repeat(1024)])) };
    const event = addEvent(state, record, 'mission_created', {}, details);
    const serialized = JSON.stringify(event.details);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(8192);
    expect(serialized).not.toContain('raw-api-secret');
    expect(serialized).not.toContain('raw-password');
    expect(serialized).not.toContain('raw-access-token');
  });

  it('redacts secret assignments embedded in event detail keys', () => {
    const record = mission();
    const state = database(record);
    const event = addEvent(state, record, 'mission_created', {}, { 'apiKey=raw-key-secret': 'safe value' });
    const serialized = JSON.stringify(event.details);
    expect(serialized).toContain('apiKey=[REDACTED]');
    expect(serialized).not.toContain('raw-key-secret');
  });
});
