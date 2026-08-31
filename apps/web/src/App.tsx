import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type { Agent, AgentRun, Message, PlaygroundImpactAdmission, SystemInfo } from "./types";
import MissionPanel from "./MissionPanel";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

type AgentPreviewSession = { id: string; agentId: string; workspaceHash: string; profile: string; contentPath: string; expiresAt: string };

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function impactStatusTitle(status: PlaygroundImpactAdmission["status"]): string {
  switch (status) {
    case "planning": return "Checking what this request would change";
    case "promoting": return "This change needs design approval";
    case "promoted": return "Moved to a protected build";
    case "admitted": return "Continuing as ordinary Playground work";
    case "confirmation_required": return "Conductor needs your confirmation";
    default: return "Request stopped safely";
  }
}

function LaunchpadSidebar({ view, system, primaryLabel, onPrimary, onShowAgents, onShowMissions, children }: {
  view: 'agents' | 'missions';
  system: SystemInfo | null;
  primaryLabel: string;
  onPrimary: () => void;
  onShowAgents: () => void;
  onShowMissions: () => void;
  children: ReactNode;
}) {
  return <aside className="sidebar">
    <div className="brand"><div className="brand-mark">A</div><div><strong>Agent Launchpad</strong><span>{system?.runtimeProvider === 'container' ? 'Local container · Codex CLI' : 'ECS / Docker · Codex CLI'}</span></div></div>
    <button className="button button-primary create-button" onClick={onPrimary}><span>＋</span>{primaryLabel}</button>
    <div className="view-switch" role="tablist" aria-label="Workspace views"><button className={view === 'agents' ? 'active' : ''} onClick={onShowAgents}>Agents</button><button className={view === 'missions' ? 'active' : ''} onClick={onShowMissions}>Missions</button></div>
    {children}
    <div className="runtime-card"><span className="eyebrow">Runtime</span><strong>{system?.runtime ?? 'Checking…'}</strong><span>{system?.arkModel ?? 'Model not configured'}{system?.containerEngine ? ' · ' + system.containerEngine : ''}</span></div>
  </aside>;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [impactAdmissions, setImpactAdmissions] = useState<PlaygroundImpactAdmission[]>([]);
  const [activeAdmission, setActiveAdmission] = useState<PlaygroundImpactAdmission | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [view, setView] = useState<"agents" | "missions">("agents");
  const [agentPreview, setAgentPreview] = useState<AgentPreviewSession | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const pollingAdmissionIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setActiveAdmission(null);
    setImpactAdmissions([]);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId), api.impactAdmissions(selectedId)])
      .then(([, result, impactResult]) => {
        if (selectedIdRef.current !== selectedId) return;
        setImpactAdmissions(impactResult.admissions);
        const latestAdmission = impactResult.admissions.at(-1) ?? null;
        setActiveAdmission(latestAdmission);
        if (latestAdmission && ["planning", "promoting"].includes(latestAdmission.status)) void pollImpact(latestAdmission.id, selectedId).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const openAgentPreview = async () => {
    if (!selected) return;
    setPreviewBusy(true);
    setError(null);
    try {
      const { session } = await api.createAgentPreview(selected.id);
      setAgentPreview(session);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPreviewBusy(false);
    }
  };

  const closeAgentPreview = async () => {
    const current = agentPreview;
    setAgentPreview(null);
    if (!current) return;
    await api.stopAgentPreview(current.agentId, current.id).catch(() => undefined);
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const pollImpact = async (admissionId: string, agentId: string) => {
    if (pollingAdmissionIds.current.has(admissionId)) return;
    pollingAdmissionIds.current.add(admissionId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.impactAdmissions(agentId);
        const admission = result.admissions.find((item) => item.id === admissionId);
        if (!admission) return;
        if (selectedIdRef.current === agentId) { setImpactAdmissions(result.admissions); setActiveAdmission(admission); }
        if (!["planning", "promoting"].includes(admission.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          if (admission.admittedRunId) await pollRun(admission.admittedRunId, agentId);
          return;
        }
      }
    } finally { pollingAdmissionIds.current.delete(admissionId); }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content, crypto.randomUUID());
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setImpactAdmissions((current) => [...current, result.admission]);
        setActiveAdmission(result.admission);
        setActiveRun(null);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollImpact(result.admission.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const confirmImpact = async (admission: PlaygroundImpactAdmission, choice: "governed" | "nonvisual") => {
    setError(null);
    try {
      const result = await api.confirmImpact(admission.agentId, admission.id, choice);
      setActiveAdmission(result.admission);
      setImpactAdmissions((current) => current.map((item) => item.id === result.admission.id ? result.admission : item));
      if (["planning", "promoting"].includes(result.admission.status)) await pollImpact(result.admission.id, admission.agentId);
      else if (result.admission.admittedRunId) await pollRun(result.admission.admittedRunId, result.admission.agentId);
      await refreshAgents();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  if (view === "missions") {
    return <MissionPanel agents={agents} system={system} onRefreshAgents={refreshAgents} render={({ sidebar, workspace, overlay, onNewMission }) => <div className="app-shell">
      <LaunchpadSidebar view="missions" system={system} primaryLabel="New Mission" onPrimary={onNewMission} onShowAgents={() => setView('agents')} onShowMissions={() => setView('missions')}>{sidebar}</LaunchpadSidebar>
      <main className="main mission-main">{workspace}</main>
      {overlay}
    </div>} />;
  }

  return (
    <div className="app-shell">
      <LaunchpadSidebar view="agents" system={system} primaryLabel="Create Agent" onPrimary={() => { setForm(emptyForm); setShowCreate(true); }} onShowAgents={() => setView('agents')} onShowMissions={() => setView('missions')}>
        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

      </LaunchpadSidebar>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set MODEL_API_KEY, MODEL_NAME, and MODEL_BASE_URL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-primary"
                  onClick={() => void openAgentPreview()}
                  disabled={busy || previewBusy || selected.status !== "ready"}
                >
                  {previewBusy ? <Spinner /> : "Preview current app"}
                </button>
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {impactAdmissions.map((admission) => (
                  <article className={`impact-card impact-card-${admission.status}`} key={admission.id}>
                    <div className="impact-card__mark">{admission.status === "promoted" ? "M" : admission.status === "admitted" ? "✓" : "◇"}</div>
                    <div className="impact-card__body">
                      <span className="eyebrow">Conductor request check</span>
                      <strong>{impactStatusTitle(admission.status)}</strong>
                      <p>{admission.reason ?? "Conductor is checking the request against the real workspace before allowing changes to become permanent."}</p>
                      {admission.proposal?.surfaces.length ? <div className="impact-card__surfaces">{admission.proposal.surfaces.map((surface) => <span key={surface.id}>{surface.route} · {surface.states.length || 1} state{surface.states.length === 1 ? "" : "s"}</span>)}</div> : null}
                      {admission.status === "confirmation_required" ? <div className="impact-card__actions"><button className="button button-primary" onClick={() => void confirmImpact(admission, "governed")}>Protect this change</button>{admission.allowNonvisualConfirmation ? <button className="button button-ghost" onClick={() => void confirmImpact(admission, "nonvisual")}>Continue as non-UI work</button> : null}</div> : null}
                      {admission.status === "promoted" && admission.missionId ? <div className="impact-card__actions"><button className="button button-primary" onClick={() => setView("missions")}>Open Mission</button><code>{admission.missionId.slice(0, 8)}</code></div> : null}
                      <details><summary>Technical details</summary><small>Workspace checkpoint {admission.workspaceHash.slice(0, 10)} · Playground thread {admission.threadId ? "preserved" : "new"}</small></details>
                    </div>
                  </article>
                ))}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    (activeAdmission != null && ["planning", "confirmation_required", "promoting"].includes(activeAdmission.status)) ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeAdmission != null && ["planning", "confirmation_required", "promoting"].includes(activeAdmission.status)) ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {agentPreview && (
        <div className="modal-backdrop agent-preview-backdrop" role="presentation" onMouseDown={() => void closeAgentPreview()}>
          <section className="agent-preview-modal" role="dialog" aria-modal="true" aria-label="Current Agent application" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><span className="eyebrow">Current Agent workspace</span><h2>Application before the new request</h2><p>Read-only temporary preview · workspace {agentPreview.workspaceHash.slice(0, 10)}</p></div>
              <button className="button button-primary" onClick={() => void closeAgentPreview()}>Close preview</button>
            </header>
            <iframe title="Current Agent application" sandbox="allow-scripts" src={agentPreview.contentPath} />
          </section>
        </div>
      )}

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
