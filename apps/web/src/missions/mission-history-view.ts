import type { MissionHistoryEntry } from '../types';

export interface MissionHistoryGroup {
  id: string;
  key: string;
  label: string;
  entries: MissionHistoryEntry[];
}

const groupKey = (entry: MissionHistoryEntry): string => entry.kind === 'attempt' ? `attempt:${entry.stage}` : `verification:${entry.mode}`;

const groupLabel = (entry: MissionHistoryEntry): string => {
  if (entry.kind === 'verification') return entry.mode === 'final' ? 'Final check' : 'App check';
  if (entry.stage === 'design') return 'Design';
  if (entry.stage === 'implement') return 'Build';
  return 'Repair';
};

export function groupMissionHistory(entries: readonly MissionHistoryEntry[]): MissionHistoryGroup[] {
  const groups: MissionHistoryGroup[] = [];
  for (const entry of entries) {
    const key = groupKey(entry);
    const previous = groups.at(-1);
    if (previous?.key === key) {
      previous.entries.push(entry);
      continue;
    }
    groups.push({ id: `${key}:${entry.id}`, key, label: groupLabel(entry), entries: [entry] });
  }
  return groups;
}

export function historyGroupSummary(group: MissionHistoryGroup): string {
  const latest = group.entries.at(-1)!;
  const count = group.entries.length;
  const countLabel = latest.kind === 'verification' ? `${count} ${count === 1 ? 'check' : 'checks'}` : `${count} ${count === 1 ? 'attempt' : 'attempts'}`;
  const current = latest.kind === 'verification' && latest.current ? ' · current' : '';
  return `${countLabel} · ${latest.status}${current}`;
}

export function historyRecordLabel(entry: MissionHistoryEntry, index: number): string {
  const status = entry.status.toUpperCase();
  const time = new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${index + 1} · ${status} · ${time}`;
}

export function readableHistoryEvent(type: string): string {
  return type.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
