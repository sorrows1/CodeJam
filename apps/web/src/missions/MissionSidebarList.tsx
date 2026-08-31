import type { MissionSummary } from '../types';

const stateLabel: Record<MissionSummary['product']['state'], string> = {
  designing: 'Preparing design',
  approval_required: 'Review design',
  implementation_unlocked: 'Ready to build',
  implementation_blocked: 'Build blocked',
  building: 'Building',
  implementation_checking: 'Checking built app',
  implementation_review: 'Review built result',
  repairing: 'Repairing',
  awaiting_verification: 'Waiting for app check',
  verifying: 'Final check',
  verification_failed: 'Verification failed',
  verification_error: 'Check needs retry',
  complete: 'Complete',
  stopped: 'Stopped',
  degraded: 'Needs attention',
};

export function MissionSidebarList({ summaries, selectedId, onSelect }: {
  summaries: MissionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return <>
    <div className="sidebar-label"><span>Missions</span><span>{summaries.length}</span></div>
    <nav className="mission-sidebar-list" aria-label="Missions">
      {summaries.map(({ mission, product }) => <button type="button" key={mission.id} className={mission.id === selectedId ? 'is-selected' : ''} onClick={() => onSelect(mission.id)}>
        <span className={`mission-sidebar-list__dot is-${product.state}`} />
        <span><strong>{mission.goal}</strong><small>{stateLabel[product.state]}</small></span>
      </button>)}
      {summaries.length === 0 ? <div className="empty-sidebar"><span>◇</span>No Missions yet.</div> : null}
    </nav>
  </>;
}
