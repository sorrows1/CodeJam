import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { DesignReference, MissionDetail, MissionHistoryEntry } from '../types';
import { parseLogicalDesignViewport, type LogicalDesignViewport } from './design-preview-model';
import { evidenceBindingKey, previewMatchesBinding } from './preview-binding';
import { ScaledDesignPreview } from './ScaledDesignPreview';
import './MissionEvidenceCanvas.css';

type ViewMode = 'compare' | 'approved' | 'built';
type PreviewState = { id: string; missionId: string; target: { kind: 'design'; revisionId: string } | { kind: 'workspace'; revisionId: string; designRevisionId: string }; contentPath: string; isolatedOrigin: boolean; expiresAt: string; previewDataHash: string | null; bindingKey: string };
type VerificationEntry = Extract<MissionHistoryEntry, { kind: 'verification' }>;

const shortId = (value: string | null) => !value ? '—' : value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;

function verificationGroups(entries: readonly VerificationEntry[]): Array<{ mode: VerificationEntry['mode']; entries: VerificationEntry[] }> {
  const groups: Array<{ mode: VerificationEntry['mode']; entries: VerificationEntry[] }> = [];
  for (const entry of entries) {
    const previous = groups.at(-1);
    if (previous?.mode === entry.mode) previous.entries.push(entry);
    else groups.push({ mode: entry.mode, entries: [entry] });
  }
  return groups;
}

function ScaledLivePreview({ src, isolatedOrigin, viewport }: { src: string; isolatedOrigin: boolean; viewport: LogicalDesignViewport }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setAvailableWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = useMemo(() => availableWidth ? Math.min(1, availableWidth / viewport.width) : 0, [availableWidth, viewport.width]);
  const renderedHeight = Math.max(1, Math.round(viewport.height * scale));

  return <div
    ref={containerRef}
    className="mission-live-preview__viewport"
    data-logical-width={viewport.width}
    data-logical-height={viewport.height}
    data-preview-scale={scale.toFixed(4)}
    style={{ height: renderedHeight }}
  >
    <div className="mission-live-preview__canvas" style={{ width: viewport.width, height: viewport.height, transform: `scale(${scale})` }}>
      <iframe title="Built app preview" sandbox={isolatedOrigin ? "allow-scripts allow-same-origin" : "allow-scripts"} src={src} width={viewport.width} height={viewport.height} />
    </div>
  </div>;
}

export function MissionEvidenceCanvas({ detail, reference }: { detail: MissionDetail; reference: DesignReference | null }) {
  const verifications = detail.history.filter((entry): entry is VerificationEntry => entry.kind === 'verification');
  const groups = verificationGroups(verifications);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = verifications.find((entry) => entry.runId === selectedId) ?? verifications.find((entry) => entry.current) ?? verifications.at(-1) ?? null;
  const [mode, setMode] = useState<ViewMode>('compare');
  const [full, setFull] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [historicalReference, setHistoricalReference] = useState<DesignReference | null>(null);
  const canvasRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setHistoricalReference(null);
    if (!selected || reference?.revision.id === selected.designRevisionId) return;
    let active = true;
    void api.designReference(detail.mission.id, selected.designRevisionId).then((value) => { if (active && value.revision.id === selected.designRevisionId) setHistoricalReference(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [detail.mission.id, reference?.revision.id, selected?.designRevisionId]);

  const selectedReference = reference && (!selected || reference.revision.id === selected.designRevisionId) ? reference : historicalReference?.revision.id === selected?.designRevisionId ? historicalReference : null;
  const binding = {
    missionId: detail.mission.id,
    selectionId: selected?.runId ?? null,
    designRevisionId: selected?.designRevisionId ?? selectedReference?.revision.id ?? null,
    workspaceRevisionId: selected?.workspaceRevisionId ?? detail.mission.workflow.implementedWorkspaceRevisionId,
  };
  const bindingKey = evidenceBindingKey(binding);
  const bindingKeyRef = useRef(bindingKey);
  bindingKeyRef.current = bindingKey;
  const previewTarget = binding.workspaceRevisionId && binding.designRevisionId ? { kind: 'workspace' as const, revisionId: binding.workspaceRevisionId, designRevisionId: binding.designRevisionId } : null;
  const activePreview = preview && preview.bindingKey === bindingKey && previewTarget && previewMatchesBinding(preview, binding, previewTarget) ? preview : null;
  const viewport = useMemo(() => selectedReference ? parseLogicalDesignViewport(selectedReference.contractJson) : { width: 1440, height: 900 }, [selectedReference]);
  const artifact = selected?.actualScreenshotArtifactId ? detail.artifacts.find((item) => item.id === selected.actualScreenshotArtifactId) ?? null : null;
  const legacyCapture = artifact?.mediaType === 'image/png';

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    if (!artifact) { setImageUrl(null); return; }
    if (artifact.content) { setImageUrl(`data:${artifact.mediaType};base64,${artifact.content}`); return; }
    void api.missionEvidence(detail.mission.id, artifact.id).then((blob) => { if (active) { objectUrl = URL.createObjectURL(blob); setImageUrl(objectUrl); } }).catch(() => { if (active) setImageUrl(null); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifact?.id, detail.mission.id]);

  useEffect(() => { setSelectedId(null); setPreviewError(null); setMode('compare'); setFull(false); }, [detail.mission.id]);
  useEffect(() => { setPreview((current) => current && current.bindingKey !== bindingKey ? null : current); }, [bindingKey]);
  useEffect(() => () => { if (preview) void api.stopPreview(preview.missionId, preview.id).catch(() => undefined); }, [preview?.id, preview?.missionId]);

  const startPreview = async () => {
    if (!previewTarget) return;
    const requestedKey = bindingKey;
    const requestedBinding = { ...binding };
    const requestedTarget = { ...previewTarget };
    setPreviewError(null);
    try {
      const result = await api.createPreview(detail.mission.id, requestedTarget);
      if (bindingKeyRef.current !== requestedKey || !previewMatchesBinding(result.session, requestedBinding, requestedTarget)) {
        await api.stopPreview(result.session.missionId, result.session.id).catch(() => undefined);
        return;
      }
      setPreview({ ...result.session, bindingKey: requestedKey });
      requestAnimationFrame(() => canvasRef.current?.scrollIntoView({ block: 'start', inline: 'nearest' }));
    } catch (error) {
      if (bindingKeyRef.current === requestedKey) setPreviewError(error instanceof Error ? error.message : String(error));
    }
  };

  const stopPreview = async () => {
    if (!preview) return;
    const stopped = preview;
    setPreview(null);
    await api.stopPreview(stopped.missionId, stopped.id).catch(() => undefined);
  };

  if (!selected && !selectedReference) return null;

  const comparison = <div className={`mission-evidence-stage is-${mode}`}>
    {mode !== 'built' ? <article className="mission-evidence-surface"><header><div><span>What you approved</span><strong>Approved design</strong></div><small>Design {shortId(binding.designRevisionId)}</small></header><div className="mission-evidence-frame is-design">{selectedReference ? <ScaledDesignPreview html={selectedReference.previewHtml} viewport={viewport} frameKey={`compare-${selected?.runId ?? 'design'}`} title="Approved design" onContainedInteraction={() => undefined} /> : <p>The approved design is unavailable for this older check.</p>}</div></article> : null}
    {mode !== 'approved' ? <article className="mission-evidence-surface"><header><div><span>What the Builder produced</span><strong>Built result</strong></div><small>Workspace {shortId(binding.workspaceRevisionId)}</small></header><div className="mission-evidence-frame is-built">{imageUrl ? <img src={imageUrl} alt="Built application captured by the verifier" /> : <p>The built-app capture is unavailable for this older check.</p>}</div>{legacyCapture ? <p className="mission-evidence-legacy-note">This older verification used the previous capture format. Its original framing is preserved; use Preview built app to inspect that saved workspace interactively.</p> : null}</article> : null}
  </div>;

  const currentDescription = selected?.current ? 'This is the check that currently controls whether the work can finish.' : 'This is an older saved check. It cannot approve or publish the current work.';
  const canvas = <section className="mission-evidence-canvas" aria-label="Built app verification" ref={canvasRef}>
    <header className="mission-evidence-header"><div><span>Independent app check</span><h2>{selected ? `${selected.mode === 'final' ? 'Final check' : 'App check'} · ${selected.status.toUpperCase()}` : 'Approved design'}</h2><p>{currentDescription}</p></div><div className="mission-evidence-header__actions">{verifications.length > 1 ? <details className="mission-evidence-history"><summary>History · {verifications.length} checks</summary><div className="mission-evidence-history__menu">{groups.map((group) => <section key={group.mode}><header><strong>{group.mode === 'final' ? 'Final checks' : 'App checks'}</strong><small>{group.entries.length} {group.entries.length === 1 ? 'check' : 'checks'}</small></header>{group.entries.map((entry, index) => <button className={selected?.runId === entry.runId ? 'is-active' : ''} key={entry.runId} onClick={() => setSelectedId(entry.runId)}><span>{group.entries.length > 1 ? `Check ${index + 1}` : entry.mode === 'final' ? 'Final check' : 'App check'}</span><small>{entry.status}{entry.current ? ' · current' : ''}</small></button>)}</section>)}</div></details> : null}<button onClick={() => setFull(true)}>Open large</button></div></header>
    <div className="mission-evidence-switcher" role="group" aria-label="Verification view"><button className={mode === 'compare' ? 'is-active' : ''} onClick={() => setMode('compare')}>Compare</button><button className={mode === 'approved' ? 'is-active' : ''} onClick={() => setMode('approved')}>Approved design</button><button className={mode === 'built' ? 'is-active' : ''} onClick={() => setMode('built')}>Built result</button></div>
    {activePreview ? <div className="mission-live-preview"><header><div><span>Interactive saved result</span><strong>Built app preview</strong></div><button onClick={() => void stopPreview()}>Stop preview</button></header><ScaledLivePreview src={activePreview.contentPath} isolatedOrigin={activePreview.isolatedOrigin} viewport={viewport} /><small>Temporary preview · {viewport.width}×{viewport.height} review size · workspace {shortId(activePreview.target.revisionId)} · expires {new Date(activePreview.expiresAt).toLocaleTimeString()}</small></div> : <div className="mission-preview-row"><p>Want to try the built app instead of only viewing the verification capture?</p><button disabled={!previewTarget} onClick={() => void startPreview()}>Preview built app</button></div>}
    {previewError ? <div className="mission-preview-error" role="alert"><strong>Preview unavailable</strong><span>{previewError}</span><button onClick={() => void startPreview()}>Try again</button></div> : null}
    {comparison}
    <details className="mission-evidence-details"><summary>Technical details</summary><div className="mission-evidence-detail-grid"><section><span>Check status</span><strong>{selected?.current ? 'CURRENT' : 'HISTORICAL'}</strong><small>Recorded result: {selected?.status ?? 'Unavailable'}</small></section><section><span>Exact versions</span><strong>Design {shortId(binding.designRevisionId)}</strong><small>Workspace {shortId(binding.workspaceRevisionId)}</small></section><section><span>Checks</span><strong>{selected ? `${selected.checks.filter((check) => check.passed).length}/${selected.checks.length} passed` : 'Unavailable'}</strong><small>Correlation {shortId(selected?.correlationId ?? null)}</small></section></div>{selectedReference ? <pre>{selectedReference.contractJson}</pre> : null}{selected?.checks.map((check) => <p className={check.passed ? 'is-pass' : 'is-fail'} key={check.id}><strong>{check.passed ? 'PASS' : 'FAIL'} · {check.label}</strong><span>{check.details}</span></p>)}</details>
  </section>;

  return full ? <div className="mission-evidence-full" role="dialog" aria-modal="true"><div className="mission-evidence-full__bar"><strong>Built app verification</strong><button onClick={() => setFull(false)}>Close</button></div>{canvas}</div> : canvas;
}
