import { randomUUID } from 'node:crypto';
import { RunCancelledError, RunnerExecutionError } from './errors.js';
import { safeMissionText } from './mission-evidence.js';
import type { Agent, AgentRun, AgentRunner, RunnerPreflightRequest, RunnerReadinessResult, RunnerRequest, RunnerResult } from './types.js';
import { JsonStore } from './store.js';

const now = () => new Date().toISOString();

function safePlaygroundResult(result: RunnerResult, secrets: readonly string[]): RunnerResult {
  return { ...result, output: result.output === null ? null : safeMissionText(result.output, 50 * 1024, secrets).content };
}

function safePlaygroundError(error: Error, secrets: readonly string[]): Error {
  const message = safeMissionText(error.message, 4096, secrets).content;
  if (error instanceof RunCancelledError) return new RunCancelledError();
  if (error instanceof RunnerExecutionError) return new RunnerExecutionError(message, error.usage);
  const safe = new Error(message);
  safe.name = error.name;
  return safe;
}

export interface RunExecutionPort {
  start(agentAtStart: Agent, run: AgentRun, request?: RunnerRequest): Promise<{ result: RunnerResult | null; error: Error | null }>;
  preflight(request: RunnerPreflightRequest): Promise<RunnerReadinessResult>;
  cancel(agentId: string): Promise<void>;
  isAvailable(): Promise<boolean>;
  reconcileStartup(): Promise<void>;
}

export class RunExecutionService implements RunExecutionPort {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  constructor(private readonly store: JsonStore, private readonly runner: AgentRunner, private readonly redactionSecrets: readonly string[] = []) {}
  start(agentAtStart: Agent, run: AgentRun, request: RunnerRequest = { agentId: agentAtStart.id, workspacePath: agentAtStart.workspacePath, prompt: run.prompt, threadId: agentAtStart.codexThreadId }): Promise<{ result: RunnerResult | null; error: Error | null }> {
    const execution = this.executeRun(agentAtStart, run, request); const active = execution.then(() => undefined); this.activeExecutions.set(agentAtStart.id, active); void active.finally(() => { if (this.activeExecutions.get(agentAtStart.id) === active) this.activeExecutions.delete(agentAtStart.id); }).catch(() => undefined); return execution;
  }
  async preflight(request: RunnerPreflightRequest): Promise<RunnerReadinessResult> {
    if (this.runner.preflight) return this.runner.preflight(request);
    return await this.runner.isAvailable()
      ? { ok: true }
      : { ok: false, category: 'runtime_unavailable', message: 'Agent Runtime is unavailable' };
  }
  async cancel(agentId: string): Promise<void> { this.cancellationRequests.add(agentId); try { await this.runner.cancel(agentId); const execution = this.activeExecutions.get(agentId); if (execution) await execution; } finally { this.cancellationRequests.delete(agentId); } }
  isAvailable(): Promise<boolean> { return this.runner.isAvailable(); }
  async reconcileStartup(): Promise<void> { await this.store.mutate((database) => { const timestamp = now(); for (const run of database.runs) if (['playground', 'playground_impact', 'playground_candidate'].includes(run.context.kind) && (run.status === 'queued' || run.status === 'running')) { run.status = 'cancelled'; run.error = 'Server restarted while this run was active'; run.completedAt = timestamp; } for (const admission of database.playgroundImpactAdmissions) { if (admission.status === 'planning') { admission.status = 'confirmation_required'; admission.decision = 'confirmation_required'; admission.allowNonvisualConfirmation = false; admission.reason = 'Impact planning was interrupted by server restart'; admission.error = 'Proposal interrupted by server restart'; admission.updatedAt = timestamp; } else if (admission.status === 'staging') { admission.status = 'failed'; admission.reason = 'Candidate execution was interrupted by server restart'; admission.error = admission.reason; admission.updatedAt = timestamp; admission.completedAt = timestamp; } } for (const agent of database.agents) if (agent.status === 'busy' && !database.runs.some((run) => run.agentId === agent.id && (run.status === 'queued' || run.status === 'running'))) { agent.status = 'ready'; agent.updatedAt = timestamp; } }); }
  private async executeRun(agentAtStart: Agent, run: AgentRun, request: RunnerRequest): Promise<{ result: RunnerResult | null; error: Error | null }> {
    await this.store.mutate((database) => { const stored = database.runs.find((item) => item.id === run.id); if (stored && stored.status === 'queued') { stored.status = 'running'; stored.startedAt = now(); } });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) throw new RunCancelledError();
      const result = await this.runner.run(request); const completedAt = now();
      const safeOutput = result.output === null ? null : safeMissionText(result.output, 50 * 1024, this.redactionSecrets).content;
      await this.store.mutate((database) => { const stored = database.runs.find((item) => item.id === run.id); const agent = database.agents.find((item) => item.id === agentAtStart.id); if (!stored || !agent || (stored.status !== 'queued' && stored.status !== 'running')) return; stored.status = 'completed'; stored.output = safeOutput; stored.usage = result.usage; stored.completedAt = completedAt; if (run.context.kind === 'playground') { if (safeOutput !== null) database.messages.push({ id: randomUUID(), agentId: agent.id, runId: run.id, role: 'assistant', content: safeOutput, createdAt: completedAt }); agent.codexThreadId = result.threadId; } const competing = database.runs.some((candidate) => candidate.id !== stored.id && candidate.agentId === agent.id && (candidate.status === 'queued' || candidate.status === 'running')); if (!['playground_impact', 'playground_candidate'].includes(run.context.kind) && !competing) agent.status = 'ready'; agent.lastError = null; agent.updatedAt = completedAt; });
      return { result: run.context.kind === 'playground' ? safePlaygroundResult(result, this.redactionSecrets) : { ...result, output: safeOutput }, error: null };
    } catch (caught) {
      const completedAt = now(); const cancelled = caught instanceof RunCancelledError; const error = caught instanceof Error ? caught : new Error(String(caught));
      const safeError = safeMissionText(error.message, 4096, this.redactionSecrets).content;
      await this.store.mutate((database) => { const stored = database.runs.find((item) => item.id === run.id); const agent = database.agents.find((item) => item.id === agentAtStart.id); if (stored && (stored.status === 'queued' || stored.status === 'running')) { stored.status = cancelled ? 'cancelled' : 'failed'; stored.error = safeError; if (error instanceof RunnerExecutionError) stored.usage = error.usage; stored.completedAt = completedAt; } if (agent && !['playground_impact', 'playground_candidate'].includes(run.context.kind) && agent.status !== 'stopped' && !database.runs.some((candidate) => candidate.id !== stored?.id && candidate.agentId === agent.id && (candidate.status === 'queued' || candidate.status === 'running'))) { agent.status = run.context.kind === 'mission' || cancelled ? 'ready' : 'error'; agent.lastError = cancelled || run.context.kind === 'mission' ? null : safeError; agent.updatedAt = completedAt; } });
      return { result: null, error: safePlaygroundError(error, this.redactionSecrets) };
    }
  }
}
