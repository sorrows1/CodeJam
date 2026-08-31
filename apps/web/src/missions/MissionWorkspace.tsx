import { useEffect, useMemo, useRef } from 'react';
import type { DesignReference, MissionDetail, MissionPrimaryActionId, SystemInfo } from '../types';
import { MissionDesignRevision } from './MissionDesignRevision';
import { MissionInspector } from './MissionInspector';
import { MissionEvidenceCanvas } from './MissionEvidenceCanvas';
import { projectMissionFeed } from './mission-feed';
import './MissionDesktopRepair.css';

const labels: Record<MissionPrimaryActionId, string> = {
  generate_design: 'Prepare design',
  retry_design: 'Retry design',
  approve_design: 'Approve design',
  run_builder: 'Build approved design',
  finalize_build: 'Save built result',
  start_verification: 'Check built app',
  retry_verification: 'Retry check',
  run_repair: 'Run repair',
  accept_implementation: 'Accept result & run final check',
};
const artifactKinds = new Set(['design_revision']);
const evidenceStates = new Set(['implementation_checking', 'implementation_review', 'verifying', 'verification_failed', 'verification_error', 'complete']);

export function MissionWorkspace({ detail, reference, referenceStatus, referenceError, reviewedSurfaceIds, system, feedback, busy, onReviewedSurfaceIds, onRetryReference, onRetryPublication, onFeedback, onSubmitFeedback, onRequestImplementationChanges, onPrimaryAction, onStop, onDuplicate }: {
  detail: MissionDetail;
  reference: DesignReference | null;
  referenceStatus: 'idle' | 'loading' | 'ready' | 'error';
  referenceError: string | null;
  reviewedSurfaceIds: string[];
  system: SystemInfo | null;
  feedback: string;
  busy: boolean;
  onReviewedSurfaceIds: (ids: string[]) => void;
  onRetryReference: () => Promise<void>;
  onRetryPublication: () => Promise<void>;
  onFeedback: (value: string) => void;
  onSubmitFeedback: () => Promise<void>;
  onRequestImplementationChanges: () => Promise<void>;
  onPrimaryAction: () => Promise<void>;
  onStop: () => Promise<void>;
  onDuplicate: () => void;
}) {
  const workstreamRef = useRef<HTMLElement>(null);
  const feed = useMemo(() => projectMissionFeed(detail), [detail]);
  const currentAttempt = detail.attempts.find((attempt) => attempt.id === detail.runtimeActivity?.attemptId) ?? { id: '__none__', status: 'completed' as const, attemptNumber: 0 };
  const latestFailedAttempt = [...detail.attempts].reverse().find((attempt) => attempt.status === 'failed' || attempt.status === 'interrupted');
  const showCurrentEvidence = Boolean(detail.mission.workflow.currentVerificationRunId) && evidenceStates.has(detail.product.state);
  const designFeedback = detail.product.state === 'approval_required';
  const implementationFeedback = detail.product.state === 'implementation_review' ||
    (detail.product.state === 'verification_failed' && detail.product.currentStage === 'review' && detail.product.implementationReview.canRequestChanges);
  const terminalComplete = detail.product.state === 'complete';
  const approvalReady = referenceStatus === 'ready' && Boolean(reference) && reviewedSurfaceIds.length === reference?.surfaces.length;
  const publicationFailed = detail.publication?.status === 'failed' || detail.publication?.status === 'interrupted';

  useEffect(() => {
    const reset = () => workstreamRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    let secondFrame = 0;
    reset();
    const firstFrame = requestAnimationFrame(() => {
      reset();
      secondFrame = requestAnimationFrame(reset);
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [detail.mission.id, reference?.revision.id, showCurrentEvidence]);

  return <div className="mission-workspace">
    <main className="mission-workstream" ref={workstreamRef}>
      <header className="mission-header">
        <div><span>{detail.product.headline}</span><h1>{detail.mission.goal}</h1><p>Protected build workflow · Created {new Date(detail.mission.createdAt).toLocaleString()}</p></div>
        <div className="mission-header__actions"><button className="button button-ghost" onClick={onDuplicate}>Duplicate</button>{detail.recovery.stopPreserving.allowed ? <button className="button button-danger" disabled={busy} onClick={() => void onStop()}>Stop Mission</button> : null}</div>
      </header>
      <div className="mission-mobile-governance">{detail.product.rail.map((step, index) => <span className={`is-${step.state}`} key={step.id}>{step.state === 'complete' ? '✓' : index + 1}<small>{step.label}</small></span>)}</div>

      {showCurrentEvidence ? <section className="mission-current-evidence" aria-label="Current built-app evidence">
        <MissionEvidenceCanvas detail={detail} reference={reference} />
      </section> : null}

      {referenceStatus === 'error' && designFeedback ? <section className="mission-reference-error" role="alert"><div><strong>Design details unavailable</strong><p>{referenceError ?? 'The approved design bundle could not be loaded, so approval stays locked.'}</p></div><button className="button button-ghost" disabled={busy} onClick={() => void onRetryReference()}>Try again</button></section> : null}
      {detail.publication ? <section className={`mission-publication-status is-${detail.publication.status}`} role={publicationFailed ? 'alert' : 'status'}><div><strong>{detail.publication.status === 'published' ? 'Verified changes published to the Agent' : publicationFailed ? 'The verified result is safe, but publishing needs attention' : 'Publishing verified changes to the Agent'}</strong><p>{detail.publication.error ?? (detail.publication.status === 'published' ? 'Future Playground work now starts from this verified application.' : 'The Agent stays reserved until the workspace update finishes safely.')}</p></div>{publicationFailed ? <button className="button button-primary" disabled={busy} onClick={() => void onRetryPublication()}>Retry publish</button> : null}</section> : null}

      <section className="mission-feed">{feed.map((item) => <article className={`mission-feed-item is-${item.kind}${artifactKinds.has(item.kind) ? ' is-artifact' : ''}`} key={item.id}>
        <div className="mission-feed-avatar">{item.actor.slice(0, 1)}</div>
        <div className="mission-feed-content"><header><strong>{item.actor}</strong><time>{new Date(item.timestamp).toLocaleTimeString()}</time></header><h3>{item.title}</h3><p>{item.body}</p>
          {item.kind === 'design_revision' && item.revisionId === detail.mission.workflow.latestDesignRevisionId ? <MissionDesignRevision detail={detail} reference={reference} onReviewedSurfaceIds={onReviewedSurfaceIds} /> : null}
          {item.attemptId === currentAttempt.id && currentAttempt.status === 'running' ? <div className="mission-running-card">Attempt {currentAttempt.attemptNumber} · Running</div> : null}
          {item.failure ? <div className="mission-failure"><strong>{item.failure.title}</strong><p>{item.failure.message}</p><small>{item.failure.note}</small></div>
            : detail.product.failure && item.kind === 'failure' && item.attemptId === latestFailedAttempt?.id ? <div className="mission-failure"><strong>{detail.product.failure.title}</strong><p>{detail.product.failure.message}</p><small>Conductor kept the last safe saved state and the run history. This Mission is still incomplete.</small></div> : null}
        </div>
      </article>)}</section>
    </main>
    <MissionInspector detail={detail} system={system} />
    {!terminalComplete ? <footer className={`mission-action-dock is-${detail.product.state}`}>
      {designFeedback ? <div className="mission-action-dock__feedback"><label htmlFor="mission-design-feedback">Design changes</label><textarea id="mission-design-feedback" value={feedback} onChange={(event) => onFeedback(event.target.value)} placeholder="Describe what you want changed in the proposed design…" rows={2} /></div>
        : implementationFeedback ? <div className="mission-action-dock__feedback"><label htmlFor="mission-implementation-feedback">Changes to the built result</label><textarea id="mission-implementation-feedback" value={feedback} onChange={(event) => onFeedback(event.target.value)} placeholder="Describe what differs from the design you approved…" rows={2} /><small>Use this to fix the implementation. If you want a different product outcome, request a new design instead.</small></div>
          : <div className="mission-action-dock__status"><strong>{detail.product.headline}</strong><span>{detail.product.explanation}</span></div>}
      <div className="mission-action-dock__actions">
        {designFeedback ? <button className="button button-ghost" disabled={busy || !feedback.trim()} onClick={() => void onSubmitFeedback()}>Request design changes</button> : null}
        {implementationFeedback && detail.product.implementationReview.canRequestChanges ? <button className="button button-ghost" disabled={busy || !feedback.trim()} onClick={() => void onRequestImplementationChanges()}>Request build fixes</button> : null}
        {detail.product.primaryAction ? <button className="button button-primary" disabled={busy || (detail.product.primaryAction.id === 'approve_design' && !approvalReady)} title={detail.product.primaryAction.id === 'approve_design' && !approvalReady ? 'Review every affected screen and its requirements before approving the design.' : undefined} onClick={() => void onPrimaryAction()}>{labels[detail.product.primaryAction.id]}</button> : null}
      </div>
    </footer> : null}
  </div>;
}
