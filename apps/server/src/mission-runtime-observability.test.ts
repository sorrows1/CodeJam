import { describe, expect, it } from 'vitest';
import { MissionRuntimeObservability } from './mission-runtime-observability.js';

describe('Mission runtime observability', () => {
  it('keeps only bounded sanitized operational observations in memory', () => {
    const observability = new MissionRuntimeObservability();
    observability.begin({ missionId: 'mission-1', stage: 'design', attemptId: 'attempt-1', attemptNumber: 1, startedAt: '2026-01-01T00:00:00.000Z' });
    for (let index = 0; index < 20; index += 1) observability.observe('attempt-1', { kind: 'activity', label: `Safe activity ${index}` });
    observability.observe('attempt-1', { kind: 'usage', usage: { inputTokens: 20, cachedInputTokens: 8, outputTokens: 4 } });
    const active = observability.get('attempt-1');
    expect(active).toMatchObject({ status: 'running', stage: 'design', attemptNumber: 1, usage: { inputTokens: 20, cachedInputTokens: 8, outputTokens: 4 } });
    expect(active?.activities).toHaveLength(12);
    expect(active?.activities[0]?.label).toBe('Safe activity 8');
    observability.finish('attempt-1', { inputTokens: 21, outputTokens: 5 });
    expect(observability.getForMission('mission-1')).toMatchObject({ attemptId: 'attempt-1', status: 'completed', usage: { inputTokens: 21, outputTokens: 5 } });
  });

  it('never overlays a later attempt observation onto an earlier attempt', () => {
    const observability = new MissionRuntimeObservability();
    observability.begin({ missionId: 'mission-1', stage: 'design', attemptId: 'attempt-1', attemptNumber: 1, startedAt: null });
    observability.begin({ missionId: 'mission-1', stage: 'repair', attemptId: 'attempt-2', attemptNumber: 2, startedAt: null });
    observability.observe('attempt-2', { kind: 'activity', label: 'Repairing exact revision' });
    expect(observability.get('attempt-1')?.activities).toEqual([]);
    expect(observability.getForMission('mission-1')).toMatchObject({ attemptId: 'attempt-2', activities: [{ label: 'Repairing exact revision' }] });
  });
});
