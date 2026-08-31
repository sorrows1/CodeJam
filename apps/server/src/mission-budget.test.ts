import { describe, expect, it } from 'vitest';
import { decideBudgetAdmission, normalizeRunUsage, summarizeMissionUsage } from './mission-budget.js';
import type { AgentRun } from './types.js';

const run = (id: string, usage: AgentRun['usage'], status: AgentRun['status'] = 'completed'): AgentRun => ({ id, agentId: 'agent', status, prompt: '', output: null, error: null, usage, startedAt: null, completedAt: status === 'completed' ? '2026-01-01T00:00:00.000Z' : null, createdAt: '2026-01-01T00:00:00.000Z', context: { kind: 'mission', missionId: 'mission', taskId: 'task', attemptId: id } });

describe('Mission budget accounting', () => {
  it('aggregates mission attempts without double-counting cached input', () => {
    const summary = summarizeMissionUsage('mission', [run('one', { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 }), run('two', { inputTokens: 7, outputTokens: 2 }), { ...run('playground', { inputTokens: 100 }), context: { kind: 'playground' } }]);
    expect(summary).toMatchObject({ inputTokens: 17, cachedInputTokens: 4, outputTokens: 5, totalTokens: 22, measuredRunCount: 2 });
  });
  it('counts measured failure/stale runs and reports missing telemetry', () => {
    const summary = summarizeMissionUsage('mission', [run('failed', { inputTokens: 5, outputTokens: 1 }, 'failed'), run('stale', { inputTokens: 2, outputTokens: 1 }, 'cancelled'), run('unknown', null, 'failed')]);
    expect(summary.totalTokens).toBe(9); expect(summary.unmeasuredTerminalRunCount).toBe(1);
  });
  it('denies at the measured ceiling and allows below it', () => {
    const usage = summarizeMissionUsage('mission', [run('one', { inputTokens: 10, outputTokens: 5 })]);
    expect(decideBudgetAdmission(15, usage)).toBe(false); expect(decideBudgetAdmission(16, usage)).toBe(true); expect(decideBudgetAdmission(null, usage)).toBe(true);
  });
  it('rejects malformed usage rather than inventing totals', () => {
    expect(normalizeRunUsage({ inputTokens: -1 })).toBeNull(); expect(normalizeRunUsage({ inputTokens: 2, cachedInputTokens: 3, outputTokens: 1 })).toBeNull(); expect(normalizeRunUsage({ inputTokens: Number.POSITIVE_INFINITY })).toBeNull();
  });
});
