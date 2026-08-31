import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { Agent, MissionAgentAvailability } from '../types';

export interface CreateMissionDraft { goal: string; tokenBudget: string; agentId: string; sourceAgentId: string; designerAgentId: string; builderAgentId: string; advanced: boolean; }
export const blankMissionDraft: CreateMissionDraft = { goal: '', tokenBudget: '', agentId: '', sourceAgentId: '', designerAgentId: '', builderAgentId: '', advanced: false };

export function MissionCreateDialog({ agents, availability, draft, setDraft, busy, onClose, onSubmit }: {
  agents: Agent[];
  availability: MissionAgentAvailability[];
  draft: CreateMissionDraft;
  setDraft: Dispatch<SetStateAction<CreateMissionDraft>>;
  busy: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent) => Promise<void>;
}) {
  const availabilityByAgent = new Map(availability.map((item) => [item.agentId, item]));
  const options = agents.map((agent) => {
    const entry = availabilityByAgent.get(agent.id);
    const unavailable = !entry?.availableForMission;
    const explanation = entry?.reason === 'reserved'
      ? `in use by ${entry.reservingMissionGoal ?? entry.reservingMissionId ?? 'another Mission'}`
      : entry?.reason === 'agent_not_ready' ? `status: ${agent.status}` : null;
    return <option key={agent.id} value={agent.id} disabled={unavailable}>{agent.name}{explanation ? ` — ${explanation}` : ''}</option>;
  });
  const availableCount = availability.filter((item) => item.availableForMission).length;

  return <div className="mission-dialog-backdrop"><form className="mission-create-dialog" onSubmit={(event) => void onSubmit(event)} role="dialog" aria-modal="true" aria-labelledby="new-mission-title">
    <div className="mission-dialog-title"><div><span>New Mission</span><h2 id="new-mission-title">What should the Agent build?</h2></div><button type="button" onClick={onClose} aria-label="Close">×</button></div>
    <p>The selected Agent is reserved while this Mission is active so ordinary Playground work cannot race the build. No model run starts until you ask for the design.</p>
    <label>Requested outcome<textarea autoFocus required rows={5} maxLength={8192} value={draft.goal} onChange={(event) => setDraft((current) => ({ ...current, goal: event.target.value }))} placeholder="Describe the product outcome and important behavior…" /></label>
    <label>Agent<select required value={draft.agentId} onChange={(event) => setDraft((current) => ({ ...current, agentId: event.target.value, sourceAgentId: event.target.value, designerAgentId: event.target.value, builderAgentId: event.target.value }))}><option value="">Choose an Agent</option>{options}</select><small>By default, the same Agent supplies the current workspace, prepares the design, and builds the approved result.</small></label>
    <details open={draft.advanced} onToggle={(event) => setDraft((current) => ({ ...current, advanced: event.currentTarget.open }))}><summary>Use different Agents for each step</summary><div className="mission-role-grid">{(['sourceAgentId', 'designerAgentId', 'builderAgentId'] as const).map((field) => <label key={field}>{field === 'sourceAgentId' ? 'Source workspace' : field === 'designerAgentId' ? 'Designer' : 'Builder'}<select value={draft[field]} onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}><option value="">Choose an Agent</option>{options}</select></label>)}</div></details>
    <label>Token limit for this Mission <span>(optional)</span><input type="number" min="1" value={draft.tokenBudget} onChange={(event) => setDraft((current) => ({ ...current, tokenBudget: event.target.value }))} placeholder="No token limit" /></label>
    {availableCount === 0 ? <div className="mission-agent-unavailable" role="status">No Agent is available right now. An Agent can be ready but temporarily in use by another unfinished Mission.</div> : null}
    <div className="mission-dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="is-primary" type="submit" disabled={busy || availableCount === 0}>{busy ? 'Creating…' : 'Create Mission'}</button></div>
  </form></div>;
}
