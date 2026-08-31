import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Agent, DesignReference, MissionAgentAvailability, MissionDetail, MissionSummary, SystemInfo } from './types';
import { blankMissionDraft, MissionCreateDialog, type CreateMissionDraft } from './missions/MissionCreateDialog';
import { MissionSidebarList } from './missions/MissionSidebarList';
import { MissionWorkspace } from './missions/MissionWorkspace';
import { runMissionCommand } from './missions/mission-command';
import './missions/MissionWorkspace.css';

const requestId = () => globalThis.crypto.randomUUID();
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

export interface MissionPanelSurface { sidebar: ReactNode; workspace: ReactNode; overlay: ReactNode; onNewMission: () => void; }

export default function MissionPanel({ agents, system, onRefreshAgents, render }: {
  agents: Agent[];
  system: SystemInfo | null;
  onRefreshAgents: () => Promise<void>;
  render: (surface: MissionPanelSurface) => ReactNode;
}) {
  const [summaries, setSummaries] = useState<MissionSummary[]>([]);
  const [availability, setAvailability] = useState<MissionAgentAvailability[]>([]);
  const [detail, setDetail] = useState<MissionDetail | null>(null);
  const [reference, setReference] = useState<DesignReference | null>(null);
  const [referenceStatus, setReferenceStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [reviewedSurfaceIds, setReviewedSurfaceIds] = useState<string[]>([]);
  const [feedback, setFeedback] = useState('');
  const [draft, setDraft] = useState<CreateMissionDraft>(blankMissionDraft);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selection = useRef(0);
  const referenceSelection = useRef(0);
  const availableAgentIds = useMemo(() => new Set(availability.filter((item) => item.availableForMission).map((item) => item.agentId)), [availability]);

  const refreshSummaries = useCallback(async () => {
    const result = await api.listMissions();
    setSummaries(result.summaries);
    setAvailability(result.agentAvailability);
  }, []);
  const load = useCallback(async (id: string) => {
    const token = ++selection.current;
    const next = await api.getMission(id);
    if (token === selection.current) setDetail(next);
    return next;
  }, []);

  useEffect(() => { void refreshSummaries().catch((reason) => setError(message(reason))); }, [refreshSummaries]);
  useEffect(() => { if (!detail && summaries[0]) void load(summaries[0].mission.id).catch((reason) => setError(message(reason))); }, [detail, summaries, load]);
  useEffect(() => {
    const active = detail?.attempts.some((attempt) => attempt.status === 'running') || detail?.verificationRuns.some((run) => ['queued', 'running'].includes(run.status));
    if (!detail || !active) return;
    const id = detail.mission.id;
    const timer = window.setInterval(() => { if (!document.hidden) void load(id).catch(() => undefined); }, 1800);
    return () => window.clearInterval(timer);
  }, [detail, load]);
  const loadReference = useCallback(async (missionId: string, revisionId: string) => {
    const token = ++referenceSelection.current;
    setReferenceStatus('loading');
    setReferenceError(null);
    try {
      const next = await api.designReference(missionId, revisionId);
      if (token !== referenceSelection.current || next.revision.id !== revisionId) return;
      setReference(next);
      setReferenceStatus('ready');
    } catch (reason) {
      if (token !== referenceSelection.current) return;
      setReference(null);
      setReferenceStatus('error');
      setReferenceError(message(reason));
    }
  }, []);
  useEffect(() => {
    setReference(null);
    setReviewedSurfaceIds([]);
    const id = detail?.mission.workflow.latestDesignRevisionId;
    const missionId = detail?.mission.id;
    if (!id || !missionId) {
      setReferenceStatus('idle');
      setReferenceError(null);
      return;
    }
    void loadReference(missionId, id);
  }, [detail?.mission.id, detail?.mission.workflow.latestDesignRevisionId, loadReference]);

  const openCreate = (source?: MissionDetail) => {
    const preferred = source?.mission.workspace.source.agentId;
    const first = preferred && availableAgentIds.has(preferred) ? preferred : agents.find((agent) => availableAgentIds.has(agent.id))?.id ?? '';
    setDraft({ goal: source?.mission.goal ?? '', tokenBudget: source?.mission.tokenBudget?.toString() ?? '', agentId: first, sourceAgentId: first, designerAgentId: first, builderAgentId: first, advanced: false });
    setShowCreate(true);
  };
  const command = async (action: () => Promise<MissionDetail>) => {
    if (!detail) return;
    const missionId = detail.mission.id;
    setBusy(true);
    setError(null);
    const outcome = await runMissionCommand({ command: action, reloadDetail: () => load(missionId), refreshSummaries, refreshAgents: onRefreshAgents });
    if (outcome.detail) setDetail(outcome.detail);
    if (!outcome.ok) setError(message(outcome.error));
    setBusy(false);
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const sourceAgentId = draft.advanced ? draft.sourceAgentId : draft.agentId;
    const designerAgentId = draft.advanced ? draft.designerAgentId : draft.agentId;
    const builderAgentId = draft.advanced ? draft.builderAgentId : draft.agentId;
    setBusy(true);
    setError(null);
    try {
      const result = await api.createMission({ goal: draft.goal.trim(), sourceAgentId, designerAgentId, builderAgentId, tokenBudget: draft.tokenBudget ? Number(draft.tokenBudget) : null });
      await load(result.mission.id);
      await Promise.all([refreshSummaries(), onRefreshAgents()]);
      setShowCreate(false);
      setDraft(blankMissionDraft);
    } catch (reason) {
      const errorMessage = message(reason);
      await Promise.allSettled([refreshSummaries(), onRefreshAgents(), ...(detail ? [load(detail.mission.id)] : [])]);
      setError(errorMessage);
    } finally { setBusy(false); }
  };

  const primary = async () => {
    if (!detail?.product.primaryAction) return;
    const action = detail.product.primaryAction.id;
    if (action === 'generate_design' || action === 'run_builder' || action === 'run_repair') return command(() => api.startMission(detail.mission.id));
    if (action === 'finalize_build' && detail.recovery.resumeImplementation.allowed) return command(async () => (await api.recoverMission(detail.mission.id, { requestId: requestId(), action: 'resume', taskId: detail.recovery.resumeImplementation.allowed ? detail.recovery.resumeImplementation.taskId : '' })).detail);
    if (action === 'approve_design' && detail.mission.workflow.latestDesignRevisionId && referenceStatus === 'ready' && reference && reviewedSurfaceIds.length === reference.surfaces.length) return command(() => api.approveDesignRevision(detail.mission.id, detail.mission.workflow.latestDesignRevisionId!, reviewedSurfaceIds));
    if (action === 'accept_implementation') return command(() => api.reviewImplementation(detail.mission.id, { decision: 'accept' }));
    if (action === 'start_verification' || action === 'retry_verification') return command(() => api.verifyMission(detail.mission.id));
    if (action === 'retry_design' && detail.recovery.retryCurrentDesign.allowed) return command(async () => (await api.recoverMission(detail.mission.id, { requestId: requestId(), action: 'retry_current', taskId: detail.recovery.retryCurrentDesign.allowed ? detail.recovery.retryCurrentDesign.taskId : '' })).detail);
  };

  const requestImplementationChanges = async () => {
    if (!detail || !feedback.trim()) return;
    await command(() => api.reviewImplementation(detail.mission.id, { decision: 'request_changes', feedback: feedback.trim() }));
    setFeedback('');
  };

  const sidebar = <MissionSidebarList summaries={summaries} selectedId={detail?.mission.id ?? null} onSelect={(id) => { setFeedback(''); setReference(null); setReviewedSurfaceIds([]); void load(id).catch((reason) => setError(message(reason))); }} />;
  const workspace = <>
    {error ? <div className="error-banner mission-error" role="alert"><span>{error}</span><button onClick={() => setError(null)}>×</button></div> : null}
    {detail ? <MissionWorkspace detail={detail} reference={reference} referenceStatus={referenceStatus} referenceError={referenceError} reviewedSurfaceIds={reviewedSurfaceIds} system={system} feedback={feedback} busy={busy} onReviewedSurfaceIds={setReviewedSurfaceIds} onRetryReference={() => detail.mission.workflow.latestDesignRevisionId ? loadReference(detail.mission.id, detail.mission.workflow.latestDesignRevisionId) : Promise.resolve()} onRetryPublication={() => command(() => api.retryWorkspacePublication(detail.mission.id))} onFeedback={setFeedback} onSubmitFeedback={() => command(() => api.submitDesignFeedback(detail.mission.id, detail.mission.workflow.latestDesignRevisionId!, feedback.trim())).then(() => setFeedback(''))} onRequestImplementationChanges={requestImplementationChanges} onPrimaryAction={primary} onStop={() => command(async () => (await api.recoverMission(detail.mission.id, { requestId: requestId(), action: 'stop_preserve' })).detail)} onDuplicate={() => openCreate(detail)} /> : <section className="mission-empty"><h1>Guided builds</h1><p>Review the design before an Agent changes the product, then verify the real built app before the result can be published.</p><button className="button button-primary" onClick={() => openCreate()}>New Mission</button></section>}
  </>;
  const overlay = showCreate ? <MissionCreateDialog agents={agents} availability={availability} draft={draft} setDraft={setDraft} busy={busy} onClose={() => setShowCreate(false)} onSubmit={create} /> : null;
  return render({ sidebar, workspace, overlay, onNewMission: () => openCreate() });
}
