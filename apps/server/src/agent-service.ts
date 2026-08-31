import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import { isModelConfigured } from './config.js';
import { HttpError } from './errors.js';
import { safeMissionText } from './mission-evidence.js';
import { JsonStore } from './store.js';
import type {
  Agent,
  AgentRun,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
} from './types.js';
import { WorkspaceManager } from './workspace.js';
import { findReservingMission } from './mission-state.js';
import type { RunExecutionPort } from './run-execution.js';
import type { PlaygroundImpactService } from './playground-impact-service.js';

const now = () => new Date().toISOString();

export class AgentService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly execution: RunExecutionPort,
    private readonly impact?: PlaygroundImpactService,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.execution.reconcileStartup();
    await this.impact?.reconcileStartup();
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, 'Agent not found');
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      instructions: input.instructions?.trim() ?? '',
      status: 'ready',
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === 'busy') {
      throw new HttpError(409, 'Stop the active run before editing this Agent');
    }
    const updated = await this.store.mutate((database) => {
      const reserving = findReservingMission(database.missions, id);
      if (reserving)
        throw new HttpError(
          409,
          'Agent is reserved by Mission ' + reserving.id,
        );
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, 'Agent not found');
      }
      if (agent.status === 'busy') {
        throw new HttpError(
          409,
          'Stop the active run before editing this Agent',
        );
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined)
        agent.description = input.description.trim();
      if (input.instructions !== undefined)
        agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const admission = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, 'Agent not found');
      const unresolvedImpact = database.playgroundImpactAdmissions.find(
        (item) =>
          item.agentId === id &&
          ['planning', 'confirmation_required', 'staging', 'publishing', 'promoting'].includes(
            item.status,
          ),
      );
      if (unresolvedImpact)
        throw new HttpError(
          409,
          'Resolve the pending Playground impact admission before deleting this Agent',
        );
      const reserving = findReservingMission(database.missions, id);
      if (reserving)
        throw new HttpError(
          409,
          'Agent is reserved by Mission ' + reserving.id,
        );
      const wasBusy = agent.status === 'busy';
      if (wasBusy) {
        agent.status = 'stopped';
        agent.updatedAt = now();
      }
      return { agent: structuredClone(agent), wasBusy };
    });
    if (admission.wasBusy) await this.execution.cancel(id);
    const agent = admission.agent;
    let archivedWorkspace = '';
    await this.store.mutate(async (database) => {
      const reserving = findReservingMission(database.missions, id);
      if (reserving)
        throw new HttpError(
          409,
          'Agent is reserved by Mission ' + reserving.id,
        );
      archivedWorkspace = await this.workspaces.archive(agent);
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter(
        (item) => item.agentId !== id,
      );
      database.runs = database.runs.filter(
        (item) =>
          item.agentId !== id ||
          item.context.kind === 'mission' ||
          item.context.kind === 'playground_impact' ||
          item.context.kind === 'playground_candidate',
      );
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, 'ready');
  }

  async stopAgent(id: string): Promise<Agent> {
    const result = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, 'Agent not found');
      const reserving = findReservingMission(database.missions, id);
      if (reserving)
        throw new HttpError(
          409,
          'Agent is reserved by Mission ' + reserving.id,
        );
      const wasBusy = agent.status === 'busy';
      agent.status = 'stopped';
      agent.updatedAt = now();
      return { agent: structuredClone(agent), wasBusy };
    });
    if (result.wasBusy) await this.execution.cancel(id);
    return result.agent;
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, 'Run not found');
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter(
        (run) => run.agentId === agentId && run.context.kind === 'playground',
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isModelConfigured(this.config)) {
      throw new HttpError(
        503,
        'Model provider is not configured. Set MODEL_API_KEY and MODEL_NAME, then restart.',
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const safePrompt = safeMissionText(prompt).content;
    const run: AgentRun = {
      id: runId,
      agentId,
      status: 'queued',
      prompt: safePrompt,
      output: null,
      error: null,
      usage: null,
      context: { kind: 'playground' },
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: 'user',
      content: safePrompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, 'Agent not found');
      }
      if (storedAgent.status === 'stopped') {
        throw new HttpError(409, 'Start the Agent before sending a message');
      }
      if (storedAgent.status === 'busy') {
        throw new HttpError(409, 'This Agent is already running');
      }
      const reserving = findReservingMission(database.missions, agentId);
      if (reserving)
        throw new HttpError(
          409,
          'Agent is reserved by Mission ' + reserving.id,
        );
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = 'busy';
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    void this.execution.start(agentAtStart, run, {
      agentId: agentAtStart.id,
      workspacePath: agentAtStart.workspacePath,
      prompt,
      threadId: agentAtStart.codexThreadId,
    }).catch(() => undefined);
    return { run, message };
  }

  async sendGovernedMessage(agentId: string, prompt: string, requestId?: string) {
    if (!this.impact) return this.sendMessage(agentId, prompt);
    if (!isModelConfigured(this.config)) throw new HttpError(503, 'Model provider is not configured. Set MODEL_API_KEY and MODEL_NAME, then restart.');
    return this.impact.submit(agentId, prompt, requestId);
  }

  listImpactAdmissions(agentId: string) { return this.impact?.list(agentId) ?? []; }
  async confirmImpactAdmission(agentId: string, admissionId: string, choice: 'governed' | 'nonvisual') {
    if (!this.impact) throw new HttpError(503, 'Playground impact governance is unavailable');
    return this.impact.confirm(agentId, admissionId, choice);
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isModelConfigured(this.config),
      arkBaseUrl: this.config.modelBaseUrl,
      arkModel: this.config.modelName || null,
      codexAvailable: await this.execution.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === 'container'
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === 'container'
          ? 'Codex CLI in ' + this.config.containerEngine + ' Runtime'
          : 'Codex CLI in application container',
    };
  }

  private async setStatus(id: string, status: Agent['status']): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, 'Agent not found');
      }
      const reserving = findReservingMission(database.missions, id);
      if (reserving)
        throw new HttpError(
          409,
          'Agent is reserved by Mission ' + reserving.id,
        );
      if (status === 'ready' && agent.status === 'busy') {
        throw new HttpError(
          409,
          'Stop the active run before starting this Agent',
        );
      }
      if (
        status === 'ready' &&
        database.playgroundImpactAdmissions.some(
          (item) =>
            item.agentId === id &&
            [
              'planning',
              'confirmation_required',
              'staging',
              'publishing',
              'promoting',
            ].includes(item.status),
        )
      ) {
        throw new HttpError(
          409,
          'Resolve the pending Playground impact admission before starting this Agent',
        );
      }
      agent.status = status;
      if (status === 'ready') agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

}
