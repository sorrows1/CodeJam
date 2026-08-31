import { useEffect, useMemo, useState } from 'react';
import type { MissionDetail, MissionHistoryEntry, SystemInfo } from '../types';
import { groupMissionHistory, historyGroupSummary, historyRecordLabel, readableHistoryEvent } from './mission-history-view';
import './MissionInspector.css';

const shortId = (value: string | null) => !value ? '—' : value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;
const tokenValue = (value: number | undefined | null) => value === undefined || value === null ? 'Unavailable' : value.toLocaleString();
const stageLabel = (stage: MissionDetail['product']['currentStage']) => stage === 'design' ? 'Design' : stage === 'approval' ? 'Approve design' : stage === 'build' ? 'Build' : stage === 'review' ? 'Review built result' : stage === 'verify' ? 'Final check' : 'Complete';
const statusLabel = (entry: MissionHistoryEntry) => entry.kind === 'verification' && entry.current ? `${entry.status} · current` : entry.status;
const completionLabel = (value: MissionDetail['product']['completionAuthority']) => value === 'authorized' ? 'ALLOWED' : value === 'denied' ? 'BLOCKED' : 'WAITING';

function HistoryDetails({ entry, system }: { entry: MissionHistoryEntry; system: SystemInfo | null }) {
  if (entry.kind === 'verification') {
    const errors = [...entry.consoleErrors, ...entry.pageErrors];
    return <div className="mission-history-detail">
      <header><div><span>{entry.mode === 'final' ? 'Final check' : 'App check'}</span><h3>{entry.status.toUpperCase()}</h3></div><strong className={entry.current ? 'is-current' : ''}>{entry.current ? 'Current check' : 'Older check'}</strong></header>
      <dl className="mission-history-facts">
        <div><dt>Recorded</dt><dd>{new Date(entry.createdAt).toLocaleString()}</dd></div>
        <div><dt>Design version</dt><dd title={entry.designRevisionId}>{shortId(entry.designRevisionId)}</dd></div>
        <div><dt>Built workspace</dt><dd title={entry.workspaceRevisionId}>{shortId(entry.workspaceRevisionId)}</dd></div>
        <div><dt>Correlation ID</dt><dd title={entry.correlationId}>{shortId(entry.correlationId)}</dd></div>
        <div><dt>Duration</dt><dd>{entry.durationMs === null ? 'Unavailable' : `${entry.durationMs} ms`}</dd></div>
        <div><dt>Runtime</dt><dd>{system?.runtime ?? 'Unavailable'}</dd></div>
      </dl>
      <section><h4>Checks <small>{entry.checks.length}</small></h4>{entry.checks.length ? <ul className="mission-check-summary">{entry.checks.map((check) => <li className={check.passed ? 'is-passed' : 'is-failed'} key={check.id}><span>{check.passed ? '✓' : '!'}</span><div><strong>{check.label}</strong><small>{check.details}</small></div></li>)}</ul> : <p className="mission-inspector-empty">No check results were recorded.</p>}</section>
      {errors.length ? <section><h4>Runtime errors <small>{errors.length}</small></h4><ul className="mission-history-errors">{errors.map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}</ul></section> : null}
    </div>;
  }

  const measuredTotal = entry.usage ? (entry.usage.inputTokens ?? 0) + (entry.usage.outputTokens ?? 0) : null;
  const liveActivities = entry.live?.activities ?? [];
  return <div className="mission-history-detail">
    <header><div><span>{entry.stage === 'implement' ? 'Build attempt' : entry.stage === 'design' ? 'Design attempt' : 'Repair attempt'}</span><h3>{entry.status.toUpperCase()}</h3></div><strong>Attempt version {entry.authorityVersion}</strong></header>
    <dl className="mission-history-facts">
      <div><dt>Recorded</dt><dd>{new Date(entry.createdAt).toLocaleString()}</dd></div>
      <div><dt>Attempt ID</dt><dd title={entry.attemptId}>{shortId(entry.attemptId)}</dd></div>
      <div><dt>Input design</dt><dd title={entry.inputDesignRevisionId ?? undefined}>{shortId(entry.inputDesignRevisionId)}</dd></div>
      <div><dt>Starting workspace</dt><dd title={entry.inputWorkspaceRevisionId ?? undefined}>{shortId(entry.inputWorkspaceRevisionId)}</dd></div>
      <div><dt>Saved result</dt><dd title={entry.outputWorkspaceRevisionId ?? undefined}>{shortId(entry.outputWorkspaceRevisionId)}</dd></div>
      <div><dt>Model</dt><dd>{system?.arkModel ?? 'Unavailable'}</dd></div>
    </dl>
    {entry.failure ? <section className="mission-history-failure"><h4>Failure</h4><strong>{entry.failure.category}</strong><p>{entry.failure.message}</p></section> : null}
    <section><h4>Activity <small>{entry.events.length + liveActivities.length}</small></h4>{entry.events.length || liveActivities.length ? <ul className="mission-observation-list">{entry.events.map((event) => <li key={`${event.type}-${event.createdAt}`}><time>{new Date(event.createdAt).toLocaleTimeString()}</time><span>{readableHistoryEvent(event.type)}</span></li>)}{liveActivities.map((activity, index) => <li key={`${activity.observedAt}-${index}`}><time>{new Date(activity.observedAt).toLocaleTimeString()}</time><span>{activity.label}</span></li>)}</ul> : <p className="mission-inspector-empty">No observable activity was recorded for this attempt.</p>}</section>
    <section><h4>Files <small>{entry.files.length}</small></h4>{entry.filesAvailable ? entry.files.length ? <ul className="mission-file-list">{entry.files.map((file) => <li key={`${file.operation}-${file.path}`}><strong>{file.operation}</strong><code>{file.path}</code></li>)}</ul> : <p className="mission-inspector-empty">No changed files were recorded for this attempt.</p> : <p className="mission-inspector-empty">Changed-file evidence is unavailable for this attempt.</p>}{entry.filesTruncated ? <small>The file list was shortened to stay within the evidence limit.</small> : null}</section>
    <section><h4>Token use</h4><dl><div><dt>Input</dt><dd>{tokenValue(entry.usage?.inputTokens)}</dd></div><div><dt>Cached input</dt><dd>{tokenValue(entry.usage?.cachedInputTokens)}</dd></div><div><dt>Output</dt><dd>{tokenValue(entry.usage?.outputTokens)}</dd></div><div><dt>Measured total</dt><dd>{measuredTotal === null ? 'Unavailable' : measuredTotal.toLocaleString()}</dd></div></dl></section>
  </div>;
}

export function MissionInspector({ detail, system }: { detail: MissionDetail; system: SystemInfo | null }) {
  const [tab, setTab] = useState<'governance' | 'glassbox'>('governance');
  const [historyId, setHistoryId] = useState<string | null>(null);
  const groups = useMemo(() => groupMissionHistory(detail.history), [detail.history]);
  const selectedHistory = detail.history.find((entry) => entry.id === historyId) ?? detail.history.find((entry) => entry.kind === 'verification' && entry.current) ?? detail.history.at(-1) ?? null;
  const currentRevision = detail.designRevisions.find((revision) => revision.id === detail.mission.workflow.latestDesignRevisionId);
  const assignedId = detail.product.currentStage === 'build' ? detail.mission.workflow.builderAgentId : detail.product.currentStage === 'design' || detail.product.currentStage === 'approval' ? detail.mission.workflow.designerAgentId : null;
  const assignedAgent = assignedId ? detail.mission.participants.find((participant) => participant.agentId === assignedId) : null;
  const currentOwner = detail.product.currentStage === 'review' ? 'You' : detail.product.currentStage === 'verify' || detail.product.currentStage === 'complete' ? 'Independent verifier' : assignedAgent?.snapshot.name ?? 'Conductor';
  const showBuildGate = detail.mission.workflow.phase === 'implementing';
  const saveBuiltResultRequired = detail.recovery.resumeImplementation.allowed;

  useEffect(() => { setHistoryId(null); }, [detail.mission.id]);

  return <aside className="mission-inspector">
    <header className="mission-inspector__header"><strong>Mission details</strong><span>{detail.runtimeActivity ? '● Live' : 'Saved'}</span></header>
    <div className="mission-inspector-tabs">
      <button className={tab === 'governance' ? 'is-active' : ''} onClick={() => setTab('governance')}>Progress</button>
      <button className={tab === 'glassbox' ? 'is-active' : ''} onClick={() => setTab('glassbox')}>History</button>
    </div>
    <div className="mission-inspector__body">
      {tab === 'governance' ? <div className="mission-governance">
        <ol>{detail.product.rail.map((step, index) => <li className={`is-${step.state}`} key={step.id}><span>{step.state === 'complete' ? '✓' : index + 1}</span><div><strong>{step.label}</strong><small>{step.state}</small></div></li>)}</ol>
        <dl>
          <div><dt>Build access</dt><dd>{detail.product.implementationLock === 'unlocked' ? 'UNLOCKED' : 'LOCKED'}</dd></div>
          {saveBuiltResultRequired ? <><div><dt>Builder run</dt><dd className="is-authorized">FINISHED</dd></div><div><dt>Save built result</dt><dd className="is-required">REQUIRED</dd></div></> : showBuildGate ? <div><dt>Can build</dt><dd className={detail.product.implementationAdmission.allowed ? 'is-authorized' : 'is-denied'}>{detail.product.implementationAdmission.allowed ? 'YES' : 'NO'}</dd></div> : null}
          {!saveBuiltResultRequired && showBuildGate && !detail.product.implementationAdmission.allowed && detail.product.implementationAdmission.message ? <div className="mission-governance__reason"><dt>Why blocked</dt><dd>{detail.product.implementationAdmission.message}</dd></div> : null}
          {detail.mission.workflow.repairCycle > 0 ? <div><dt>Repairs used</dt><dd>{detail.mission.workflow.repairCycle} / {detail.mission.workflow.maxRepairCycles}</dd></div> : null}
          <div><dt>Can finish</dt><dd className={`is-${detail.product.completionAuthority}`}>{completionLabel(detail.product.completionAuthority)}</dd></div>
          <div><dt>Current design</dt><dd>{currentRevision ? `v${currentRevision.version}` : '—'}</dd></div>
          <div><dt>Current step owner</dt><dd>{currentOwner}</dd></div>
          <div><dt>Token use</dt><dd>{detail.budget.tokenLimit === null ? `${detail.budget.usage.totalTokens.toLocaleString()} · No limit` : `${detail.budget.usage.totalTokens.toLocaleString()} / ${detail.budget.tokenLimit.toLocaleString()} tokens`}</dd></div>
        </dl>
      </div> : <div className="mission-glassbox">
        <div className="mission-current-context"><span>Current step</span><strong>{stageLabel(detail.product.currentStage)}</strong><small>{detail.product.headline}</small></div>
        <section className="mission-history-section"><header><div><span>Saved audit trail</span><h3>History</h3></div><small>{detail.history.length} saved records</small></header>
          <div className="mission-history-groups">{groups.map((group) => {
            const latest = group.entries.at(-1)!;
            const selectedInGroup = selectedHistory ? group.entries.some((entry) => entry.id === selectedHistory.id) : false;
            return <div className={`mission-history-group${selectedInGroup ? ' is-selected' : ''}`} key={group.id}>
              <button className="mission-history-group__summary" onClick={() => setHistoryId(latest.id)}><span>{group.label}</span><strong>{historyGroupSummary(group)}</strong></button>
              {group.entries.length > 1 ? <details open={selectedInGroup}><summary>{group.entries.length} records</summary><div className="mission-history-records">{group.entries.map((entry, index) => <button className={selectedHistory?.id === entry.id ? 'is-active' : ''} key={entry.id} onClick={() => setHistoryId(entry.id)}><span>{historyRecordLabel(entry, index)}</span><small>{statusLabel(entry)}</small></button>)}</div></details> : null}
            </div>;
          })}</div>
        </section>
        {selectedHistory ? <HistoryDetails entry={selectedHistory} system={system} /> : <p className="mission-inspector-empty">No saved Mission history is available yet.</p>}
        <p className="mission-glassbox__note">Only bounded observable evidence is shown. Private reasoning, secrets, and raw tool payloads are excluded.</p>
      </div>}
    </div>
  </aside>;
}
