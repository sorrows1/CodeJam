import type { MissionTaskStage, RunUsage, RunnerObservation } from './types.js';

const MAX_ACTIVITY_ITEMS = 12;
const MAX_RECENT_MISSIONS = 64;

export interface MissionRuntimeActivityView {
  stage: Extract<MissionTaskStage, 'design' | 'implement' | 'repair'>;
  attemptId: string;
  attemptNumber: number;
  status: 'running' | 'completed';
  startedAt: string;
  completedAt: string | null;
  usage: RunUsage | null;
  activities: Array<{ label: string; observedAt: string }>;
}

/** Bounded, sanitized, non-authoritative and intentionally ephemeral. */
export class MissionRuntimeObservability {
  private readonly entries = new Map<string, MissionRuntimeActivityView>();
  private readonly missionAttempts = new Map<string, string>();

  begin(input: {
    missionId: string;
    stage: Extract<MissionTaskStage, 'design' | 'implement' | 'repair'>;
    attemptId: string;
    attemptNumber: number;
    startedAt: string | null;
  }): void {
    if (!this.entries.has(input.attemptId) && this.entries.size >= MAX_RECENT_MISSIONS) this.entries.delete(this.entries.keys().next().value as string);
    this.entries.set(input.attemptId, { stage: input.stage, attemptId: input.attemptId, attemptNumber: input.attemptNumber, status: 'running', startedAt: input.startedAt ?? new Date().toISOString(), completedAt: null, usage: null, activities: [] });
    this.missionAttempts.set(input.missionId, input.attemptId);
  }

  observe(attemptId: string, observation: RunnerObservation): void {
    const current = this.entries.get(attemptId);
    if (!current || current.status !== 'running') return;
    if (observation.kind === 'usage') { current.usage = { ...observation.usage }; return; }
    current.activities.push({ label: observation.label.slice(0, 96), observedAt: new Date().toISOString() });
    if (current.activities.length > MAX_ACTIVITY_ITEMS) current.activities.splice(0, current.activities.length - MAX_ACTIVITY_ITEMS);
  }

  finish(attemptId: string, usage: RunUsage | null): void {
    const current = this.entries.get(attemptId);
    if (!current) return;
    current.status = 'completed';
    current.completedAt = new Date().toISOString();
    if (usage) current.usage = { ...usage };
  }

  get(attemptId: string): MissionRuntimeActivityView | null {
    const current = this.entries.get(attemptId);
    return current ? structuredClone(current) : null;
  }

  getForMission(missionId: string): MissionRuntimeActivityView | null {
    const attemptId = this.missionAttempts.get(missionId);
    return attemptId ? this.get(attemptId) : null;
  }
}
