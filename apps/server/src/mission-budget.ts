import type { AgentRun, Mission, RunUsage } from './types.js';

export interface MissionUsageSummary {
  inputTokens: number; cachedInputTokens: number; outputTokens: number; totalTokens: number;
  measuredRunCount: number; unmeasuredTerminalRunCount: number; partialUsageRunCount: number;
}

const valid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function normalizeRunUsage(usage: RunUsage | null | undefined): RunUsage | null {
  if (!usage) return null;
  const values = Object.entries(usage).filter(([, value]) => value !== undefined);
  if (values.some(([, value]) => !valid(value))) return null;
  if (usage.cachedInputTokens !== undefined && usage.inputTokens !== undefined && usage.cachedInputTokens > usage.inputTokens) return null;
  return values.length ? { ...usage } : null;
}

export function summarizeMissionUsage(missionId: string, runs: readonly AgentRun[]): MissionUsageSummary {
  const summary: MissionUsageSummary = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, measuredRunCount: 0, unmeasuredTerminalRunCount: 0, partialUsageRunCount: 0 };
  for (const run of runs) {
    if (run.context.kind !== 'mission' || run.context.missionId !== missionId) continue;
    const usage = normalizeRunUsage(run.usage);
    if (!usage) { if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') summary.unmeasuredTerminalRunCount++; continue; }
    const hasInput = usage.inputTokens !== undefined; const hasOutput = usage.outputTokens !== undefined;
    if (!hasInput || !hasOutput) summary.partialUsageRunCount++;
    summary.inputTokens += usage.inputTokens ?? 0; summary.cachedInputTokens += usage.cachedInputTokens ?? 0; summary.outputTokens += usage.outputTokens ?? 0;
    summary.measuredRunCount++; summary.totalTokens = summary.inputTokens + summary.outputTokens;
  }
  return summary;
}

export function decideBudgetAdmission(tokenBudget: number | null, usage: MissionUsageSummary): boolean {
  return tokenBudget === null || usage.totalTokens < tokenBudget;
}

export function applyBudgetDenial(mission: Mission): Mission {
  const next = structuredClone(mission); next.status = 'blocked'; next.updatedAt = new Date().toISOString(); return next;
}
