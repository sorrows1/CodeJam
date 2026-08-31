import type { MissionEvent } from './types.js';

export interface MissionTimelineEvent { id: string; sequence: number; type: MissionEvent['type']; taskId: string | null; attemptId: string | null; agentId: string | null; actor: MissionEvent['actor']; createdAt: string; summary: string; }
export interface MissionTimeline { events: MissionTimelineEvent[]; totalEventCount: number; earliestReturnedSequence: number | null; }

/** Returns a bounded, already-redacted event window for Mission detail views. */
export function projectMissionTimeline(events: readonly MissionEvent[], limit = 100): MissionTimeline {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const window = ordered.slice(Math.max(0, ordered.length - Math.min(100, Math.max(1, limit))));
  return { events: window.map((event) => ({ id: event.id, sequence: event.sequence, type: event.type, taskId: event.taskId, attemptId: event.attemptId, agentId: event.agentId, actor: event.actor, createdAt: event.createdAt, summary: summaryFor(event) })), totalEventCount: ordered.length, earliestReturnedSequence: window[0]?.sequence ?? null };
}

function summaryFor(event: MissionEvent): string {
  const names: Record<MissionEvent['type'], string> = { mission_created: 'Mission created', participants_reserved: 'Participant reserved', workspace_ready: 'Mission workspace ready', attempt_started: 'Attempt started', attempt_completed: 'Attempt completed', attempt_failed: 'Attempt failed', attempt_result_discarded: 'Stale result rejected', mission_status_changed: 'Mission status changed', participants_released: 'Participants released', startup_interrupted: 'Restart recovery recorded', revision_created: 'Checkpoint created', revision_restored: 'Checkpoint restored', human_intervention: 'Human intervention recorded', downstream_marked_stale: 'Downstream work marked stale', recovery_command: 'Recovery action recorded', recovery_completed: 'Recovery completed', budget_admission_denied: 'Budget admission denied', design_revision_created: 'Design revision created', design_feedback_submitted: 'Design feedback submitted', design_approved: 'Design approved', implementation_admission_denied: 'Implementation admission denied', verification_started: 'Verification started', verification_passed: 'Verification passed', verification_failed: 'Verification failed', verification_error: 'Verification error', verification_result_discarded: 'Stale verification result rejected', implementation_precheck_passed: 'Implementation precheck passed', implementation_review_accepted: 'Implementation review accepted', implementation_changes_requested: 'Implementation changes requested', repair_scheduled: 'Repair scheduled', workspace_publication_started: 'Verified workspace publication started', workspace_publication_failed: 'Verified workspace publication failed', workspace_published: 'Verified workspace adopted by Agent', intent_workflow_completed: 'Intent workflow completed' };
  return names[event.type];
}
