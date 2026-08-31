import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DesignReference, MissionDetail } from '../types';
import { designPreviewFrameKey, parseLogicalDesignViewport, resetDesignPreview, type DesignPreviewState } from './design-preview-model';
import { parseReadableContract } from './mission-feed';
import { ScaledDesignPreview } from './ScaledDesignPreview';

const initialPreviewState: DesignPreviewState = { instance: 0, notice: null };
const List = ({ values }: { values: string[] }) => values.length ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul> : <p className="mission-muted">None specified</p>;
const revisionStatus = (status: MissionDetail['designRevisions'][number]['status']) => status === 'approved' ? 'Approved' : status === 'superseded' ? 'Replaced' : 'Ready to review';

export function MissionDesignRevision({ detail, reference, onReviewedSurfaceIds }: {
  detail: MissionDetail;
  reference: DesignReference | null;
  onReviewedSurfaceIds: (ids: string[]) => void;
}) {
  const revision = detail.designRevisions.find((item) => item.id === detail.mission.workflow.latestDesignRevisionId);
  const [previewState, setPreviewState] = useState(initialPreviewState);
  const [expanded, setExpanded] = useState(false);
  const [contractOpen, setContractOpen] = useState(false);
  const [activeSurfaceId, setActiveSurfaceId] = useState<string | null>(null);
  const [reviewedSurfaceIds, setReviewedSurfaceIds] = useState<string[]>([]);
  const selectedSurface = useMemo(() => reference?.surfaces.find((surface) => surface.id === activeSurfaceId)
    ?? reference?.surfaces.find((surface) => surface.id === reference.primarySurfaceId)
    ?? reference?.surfaces[0]
    ?? null, [activeSurfaceId, reference]);
  const contract = useMemo(() => selectedSurface ? parseReadableContract(selectedSurface.contractJson) : null, [selectedSurface]);
  const viewport = useMemo(() => selectedSurface ? parseLogicalDesignViewport(selectedSurface.contractJson) : { width: 1440, height: 900 }, [selectedSurface]);

  useEffect(() => {
    setPreviewState(initialPreviewState);
    setExpanded(false);
    setContractOpen(false);
    setActiveSurfaceId(reference?.primarySurfaceId ?? reference?.surfaces[0]?.id ?? null);
    setReviewedSurfaceIds([]);
    onReviewedSurfaceIds([]);
  }, [onReviewedSurfaceIds, reference, revision?.id]);

  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [expanded]);

  const navigateToSurface = useCallback((destination: string) => {
    if (!reference) return false;
    const path = new URL(destination, 'https://conductor.invalid/').pathname.replace(/\/$/, '') || '/';
    const match = reference.surfaces.find((surface) => (surface.route.replace(/\/$/, '') || '/') === path);
    if (!match) return false;
    setActiveSurfaceId(match.id);
    setPreviewState(initialPreviewState);
    setContractOpen(false);
    return true;
  }, [reference]);

  if (!revision) return null;
  const reset = () => setPreviewState((state) => resetDesignPreview(state));
  const containInteraction = (message: string) => setPreviewState((state) => ({ ...state, notice: message }));
  const selectSurface = (surfaceId: string) => {
    setActiveSurfaceId(surfaceId);
    setPreviewState(initialPreviewState);
    setContractOpen(false);
  };
  const markReviewed = () => {
    if (!selectedSurface || reviewedSurfaceIds.includes(selectedSurface.id)) return;
    const next = [...reviewedSurfaceIds, selectedSurface.id];
    setReviewedSurfaceIds(next);
    onReviewedSurfaceIds(next);
  };
  const selectedReviewed = Boolean(selectedSurface && reviewedSurfaceIds.includes(selectedSurface.id));
  const frameKey = designPreviewFrameKey(`${revision.id}:${selectedSurface?.id ?? 'none'}`, previewState.instance);

  return <section className="mission-design-card">
    <header className="mission-design-card__header">
      <div><strong>Design v{revision.version}</strong><span className={`mission-chip is-${revision.status}`}>v{revision.version} · {revisionStatus(revision.status)}</span></div>
      <time>{new Date(revision.createdAt).toLocaleString()}</time>
    </header>
    {reference && selectedSurface ? <>
      <nav className="mission-surface-tabs" aria-label="Screens affected by this design">
        {reference.surfaces.map((surface) => <button className={surface.id === selectedSurface.id ? 'is-active' : ''} type="button" key={surface.id} onClick={() => selectSurface(surface.id)}>
          <span>{reviewedSurfaceIds.includes(surface.id) ? '✓' : '○'}</span><strong>{surface.title}</strong><small>{surface.route}</small>
        </button>)}
      </nav>
      <div className="mission-surface-review-status" role="status">Reviewed the design and requirements for {reviewedSurfaceIds.length} of {reference.surfaces.length} affected screens. Approval applies to this exact set.</div>
      <div className="mission-design-toolbar" aria-label="Design review controls">
        <div><strong>{selectedSurface.title}</strong><span>{viewport.width} × {viewport.height} review size</span></div>
        <div className="mission-design-actions">
          <button className="button button-ghost" type="button" onClick={() => setExpanded(true)}>Open larger preview</button>
          <button className="button button-ghost" type="button" onClick={reset}>Reset preview</button>
          <button className="button button-ghost" type="button" aria-expanded={contractOpen} aria-controls={`design-contract-${revision.id}`} onClick={() => setContractOpen((value) => !value)}>{contractOpen ? 'Hide requirements' : 'Review requirements'}</button>
        </div>
      </div>
      <div className="mission-design-preview-shell">
        <ScaledDesignPreview html={selectedSurface.previewHtml} viewport={viewport} frameKey={frameKey} title={`${selectedSurface.title} design preview`} onContainedInteraction={containInteraction} onNavigationRequest={navigateToSurface} />
      </div>
      {previewState.notice ? <div className="mission-preview-notice" role="status"><span>{previewState.notice}</span><button className="button button-ghost" type="button" onClick={() => setPreviewState((state) => ({ ...state, notice: null }))}>Dismiss</button></div> : null}
      {contractOpen ? <div className="mission-contract-summary" id={`design-contract-${revision.id}`}>
        <h4>Acceptance requirements</h4>
        <p className="mission-muted">These requirements and the approved visual reference together define what Conductor will check in the built app.</p>
        <div className="mission-contract-grid">
          <section><span>Required text</span><List values={contract?.requiredText ?? []} /></section>
          <section><span>Required controls and regions</span><List values={contract?.requiredElements ?? []} /></section>
          <section><span>Required interactions</span><List values={contract?.interactions ?? []} /></section>
          <p><span>Review size</span><strong>{contract?.viewport}</strong></p>
        </div>
        <button className="button button-primary" type="button" disabled={selectedReviewed} onClick={markReviewed}>{selectedReviewed ? 'Design + requirements reviewed ✓' : 'Mark design + requirements reviewed'}</button>
      </div> : null}
      <details className="mission-technical-evidence"><summary>Technical details</summary><p>Package {revision.packageHash.slice(0, 12)} · Preview {revision.previewHash.slice(0, 12)} · Contract {revision.contractHash.slice(0, 12)}</p><pre>{selectedSurface.contractJson}</pre></details>
    </> : <div className="mission-reference-loading">Loading design details…</div>}
    <footer><span>{revision.status === 'approved' ? `This exact design was approved${revision.approvedAt ? ` ${new Date(revision.approvedAt).toLocaleString()}` : ''}` : 'Review the rendered design and requirements for every affected screen before approving it'}</span></footer>
    {expanded && selectedSurface ? <div className="mission-preview-dialog" role="dialog" aria-modal="true" aria-label={`Large preview of ${selectedSurface.title}`}>
      <div className="mission-preview-dialog__surface">
        <header><div><strong>{selectedSurface.title}</strong><span>{viewport.width} × {viewport.height} review size</span></div><div><button className="button button-ghost" type="button" onClick={reset}>Reset preview</button><button className="button button-primary" type="button" onClick={() => setExpanded(false)}>Close</button></div></header>
        <div className="mission-preview-dialog__stage"><ScaledDesignPreview html={selectedSurface.previewHtml} viewport={viewport} frameKey={`expanded:${frameKey}`} title={`Large ${selectedSurface.title} design preview`} fit="contain" onContainedInteraction={containInteraction} onNavigationRequest={navigateToSurface} /></div>
        {previewState.notice ? <div className="mission-preview-notice" role="status"><span>{previewState.notice}</span><button className="button button-ghost" type="button" onClick={() => setPreviewState((state) => ({ ...state, notice: null }))}>Dismiss</button></div> : null}
      </div>
    </div> : null}
  </section>;
}
