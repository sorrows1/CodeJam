import type { MissionDetail } from '../types';

export type MissionCommandOutcome =
  | { ok: true; detail: MissionDetail }
  | { ok: false; detail: MissionDetail | null; error: unknown };

export async function runMissionCommand(input: {
  command: () => Promise<MissionDetail>;
  reloadDetail: () => Promise<MissionDetail>;
  refreshSummaries: () => Promise<void>;
  refreshAgents: () => Promise<void>;
}): Promise<MissionCommandOutcome> {
  try {
    const detail = await input.command();
    await Promise.all([input.refreshSummaries(), input.refreshAgents()]);
    return { ok: true, detail };
  } catch (error) {
    const [detail] = await Promise.allSettled([
      input.reloadDetail(),
      input.refreshSummaries(),
      input.refreshAgents(),
    ]);
    return { ok: false, detail: detail.status === 'fulfilled' ? detail.value : null, error };
  }
}
