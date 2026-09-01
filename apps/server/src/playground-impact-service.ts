import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import { safeMissionText } from './mission-evidence.js';
import {
  decidePlaygroundImpact,
  fallbackPlaygroundImpactProposal,
  impactProposalPrompt,
  normalizePlaygroundImpactProposal,
  parsePlaygroundImpactProposal,
  type ImpactAdmissionDecision,
} from './playground-impact.js';
import type { RunExecutionPort } from './run-execution.js';
import { JsonStore } from './store.js';
import type { Agent, AgentRun, Message, PlaygroundImpactAdmission } from './types.js';
import { WorkspaceManager } from './workspace.js';
import {
  classifyWorkspaceDiff,
  compareWorkspaceProjections,
  type RepositoryFrameworkFacts,
  type WorkspaceProjection,
} from './workspace-projection.js';

const now = () => new Date().toISOString();

function mergeFrameworkFacts(
  authoritative: RepositoryFrameworkFacts,
  candidate: RepositoryFrameworkFacts,
): RepositoryFrameworkFacts {
  return {
    frontendPackages: [...new Set([...authoritative.frontendPackages, ...candidate.frontendPackages])].sort(),
    frontendRoots: [...new Set([...authoritative.frontendRoots, ...candidate.frontendRoots])].sort(),
    nonvisualPackages: [...new Set([...authoritative.nonvisualPackages, ...candidate.nonvisualPackages])].sort(),
    frontendConfigs: [...new Set([...authoritative.frontendConfigs, ...candidate.frontendConfigs])].sort(),
    bootstrapPaths: [...new Set([...authoritative.bootstrapPaths, ...candidate.bootstrapPaths])].sort(),
    factsComplete: authoritative.factsComplete && candidate.factsComplete,
  };
}

export interface PlaygroundImpactPromotionPort {
  promotePlaygroundImpact(admissionId: string): Promise<{ id: string }>;
}

export class PlaygroundImpactService {
  constructor(
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly execution: RunExecutionPort,
    private readonly missions: PlaygroundImpactPromotionPort,
    private readonly redactionSecrets: readonly string[] = [],
  ) {}

  list(agentId: string): PlaygroundImpactAdmission[] {
    if (!this.store.snapshot().agents.some((item) => item.id === agentId)) {
      throw new HttpError(404, 'Agent not found');
    }
    return this.store
      .snapshot()
      .playgroundImpactAdmissions
      .filter((item) => item.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async submit(
    agentId: string,
    prompt: string,
    requestId: string = randomUUID(),
  ): Promise<{ admission: PlaygroundImpactAdmission; message: Message }> {
    const boundedPrompt = safeMissionText(prompt, 50 * 1024, this.redactionSecrets).content.trim();
    if (!boundedPrompt) throw new HttpError(400, 'Message content is required');
    if (!this.store.snapshot().agents.some((item) => item.id === agentId)) {
      throw new HttpError(404, 'Agent not found');
    }

    const duplicate = this.store.snapshot().playgroundImpactAdmissions.find(
      (item) => item.agentId === agentId && item.requestId === requestId,
    );
    if (duplicate) {
      const message = this.store.snapshot().messages.find(
        (item) => item.runId === duplicate.proposalRunId && item.role === 'user',
      );
      if (!message) throw new Error('Impact admission message is unavailable');
      return { admission: duplicate, message };
    }

    let workspace: WorkspaceProjection;
    try {
      workspace = await this.workspaces.inspectAgentWorkspace(agentId);
    } catch (error) {
      throw new HttpError(
        422,
        error instanceof Error ? error.message : 'Agent workspace cannot be safely inspected',
        'PLAYGROUND_IMPACT_STALE',
      );
    }

    const timestamp = now();
    const admissionId = randomUUID();
    const run: AgentRun = {
      id: randomUUID(),
      agentId,
      status: 'queued',
      prompt: impactProposalPrompt(boundedPrompt, workspace.inventoryPaths),
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
      context: { kind: 'playground_impact', admissionId },
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId: run.id,
      role: 'user',
      content: boundedPrompt,
      createdAt: timestamp,
    };

    let agentAtStart: Agent | null = null;
    const creation = await this.store.mutate((database) => {
      const existing = database.playgroundImpactAdmissions.find(
        (item) => item.agentId === agentId && item.requestId === requestId,
      );
      if (existing) return { admission: structuredClone(existing), created: false };

      const agent = database.agents.find((item) => item.id === agentId);
      if (!agent) throw new HttpError(404, 'Agent not found');
      if (agent.status !== 'ready') {
        throw new HttpError(
          409,
          agent.status === 'stopped' || agent.status === 'error'
            ? 'Start the Agent before sending a message'
            : 'This Agent already has unresolved Playground work',
        );
      }
      if (
        database.playgroundImpactAdmissions.some(
          (item) =>
            item.agentId === agentId &&
            ['planning', 'confirmation_required', 'staging', 'publishing', 'promoting'].includes(item.status),
        )
      ) {
        throw new HttpError(409, 'This Agent already has unresolved Playground work');
      }
      if (
        database.missions.some(
          (mission) =>
            mission.participants.some((participant) => participant.agentId === agentId) &&
            !['completed', 'failed', 'cancelled'].includes(mission.status),
        )
      ) {
        throw new HttpError(409, 'Agent is reserved by an active Mission');
      }

      agentAtStart = structuredClone(agent);
      const record: PlaygroundImpactAdmission = {
        id: admissionId,
        requestId,
        agentId,
        prompt: boundedPrompt,
        status: 'planning',
        decision: null,
        allowNonvisualConfirmation: false,
        reason: null,
        proposal: null,
        workspaceHash: workspace.contentHash,
        agentUpdatedAt: agent.updatedAt,
        threadId: agent.codexThreadId,
        proposalRunId: run.id,
        admittedRunId: null,
        candidateRunId: null,
        candidateThreadId: null,
        candidateWorkspaceHash: null,
        changedFiles: [],
        diffComplete: false,
        inventoryTruncated: workspace.inventoryTruncated,
        repositoryFactsHash: createHash('sha256')
          .update(JSON.stringify(workspace.frameworkFacts))
          .digest('hex'),
        publicationTransactionId: null,
        missionId: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
      };
      database.playgroundImpactAdmissions.push(record);
      database.runs.push(run);
      database.messages.push(message);
      agent.status = 'busy';
      agent.lastError = null;
      agent.updatedAt = timestamp;
      return { admission: structuredClone(record), created: true };
    });

    if (!creation.created) {
      const storedMessage = this.store.snapshot().messages.find(
        (item) => item.runId === creation.admission.proposalRunId && item.role === 'user',
      );
      if (!storedMessage) throw new Error('Impact admission message is unavailable');
      return { admission: creation.admission, message: storedMessage };
    }
    if (!agentAtStart) throw new Error('Impact admission Agent snapshot is unavailable');

    void this.plan(agentAtStart, creation.admission, run, workspace).catch(() => undefined);
    return { admission: creation.admission, message };
  }

  async confirm(
    agentId: string,
    admissionId: string,
    choice: 'governed' | 'nonvisual',
  ): Promise<PlaygroundImpactAdmission> {
    const snapshot = this.store.snapshot();
    const admission = snapshot.playgroundImpactAdmissions.find(
      (item) => item.id === admissionId && item.agentId === agentId,
    );
    if (!admission) throw new HttpError(404, 'Playground impact admission not found');
    if (admission.status === 'promoted' || admission.status === 'admitted') return admission;
    if (admission.status !== 'confirmation_required') {
      throw new HttpError(409, 'Impact admission is not awaiting confirmation');
    }
    if (choice === 'nonvisual' && !admission.allowNonvisualConfirmation) {
      throw new HttpError(409, 'Server evidence does not permit a nonvisual continuation');
    }

    const workspaceHash = await this.workspaces.fingerprintAgentWorkspace(agentId);
    if (workspaceHash !== admission.workspaceHash) {
      return this.markStale(admissionId, 'Agent workspace changed before confirmation');
    }

    if (choice === 'governed') {
      const hadCandidate = Boolean(admission.candidateRunId);
      await this.store.mutate((database) => {
        const current = database.playgroundImpactAdmissions.find((item) => item.id === admissionId);
        const agent = database.agents.find((item) => item.id === agentId);
        if (!current || current.status !== 'confirmation_required') return;
        const timestamp = now();
        current.decision = 'governed';
        current.reason = 'Human confirmed safe Mission governance';
        current.updatedAt = timestamp;
        if (agent) {
          if (hadCandidate && current.threadId !== null && agent.codexThreadId === current.threadId) {
            agent.codexThreadId = null;
          }
          agent.status = 'ready';
          agent.updatedAt = timestamp;
          current.agentUpdatedAt = timestamp;
        }
      });
      if (hadCandidate) await this.workspaces.discardPlaygroundCandidate(admissionId).catch(() => undefined);
      await this.missions.promotePlaygroundImpact(admissionId);
      return this.store.snapshot().playgroundImpactAdmissions.find((item) => item.id === admissionId)!;
    }

    if (admission.candidateRunId && admission.candidateWorkspaceHash) {
      await this.publishCandidate(admissionId);
      return this.store.snapshot().playgroundImpactAdmissions.find((item) => item.id === admissionId)!;
    }

    const started = await this.stageCandidateRun(admissionId);
    if (started) {
      void this.executeCandidate(started.admission, started.agent, started.run).catch(() => undefined);
    }
    return this.store.snapshot().playgroundImpactAdmissions.find((item) => item.id === admissionId)!;
  }

  private async plan(
    agentAtStart: Agent,
    admission: PlaygroundImpactAdmission,
    run: AgentRun,
    workspace: WorkspaceProjection,
  ): Promise<void> {
    const execution = await this.execution.start(agentAtStart, run, {
      agentId: agentAtStart.id,
      workspacePath: agentAtStart.workspacePath,
      prompt: run.prompt,
      threadId: null,
      accessMode: 'read_only',
    });

    const finalHash = await this.workspaces.fingerprintAgentWorkspace(agentAtStart.id).catch(() => null);
    if (finalHash !== admission.workspaceHash) {
      await this.markStale(admission.id, 'Read-only impact proposal observed a workspace mutation');
      return;
    }

    let proposal: PlaygroundImpactAdmission['proposal'] = null;
    let decision: ImpactAdmissionDecision | null = null;
    let fallbackReason = execution.error?.message ?? null;

    if (execution.result?.output) {
      try {
        proposal = normalizePlaygroundImpactProposal(
          admission.prompt,
          parsePlaygroundImpactProposal(execution.result.output),
        );
        decision = decidePlaygroundImpact({
          prompt: admission.prompt,
          proposal,
          repositoryPaths: workspace.inventoryPaths,
          repositoryFacts: workspace.frameworkFacts,
        });
      } catch (caught) {
        fallbackReason = caught instanceof Error ? caught.message : String(caught);
      }
    } else if (!fallbackReason) {
      fallbackReason = 'Read-only impact planning returned no usable output.';
    }

    if (!proposal || !decision) {
      proposal = normalizePlaygroundImpactProposal(
        admission.prompt,
        fallbackPlaygroundImpactProposal(
          safeMissionText(
            fallbackReason ?? 'Read-only impact planning was unavailable.',
            1_024,
            this.redactionSecrets,
          ).content,
        ),
      );
      decision = decidePlaygroundImpact({
        prompt: admission.prompt,
        proposal,
        repositoryPaths: workspace.inventoryPaths,
        repositoryFacts: workspace.frameworkFacts,
      });
    }

    const outcome = await this.store.mutate((database) => {
      const current = database.playgroundImpactAdmissions.find((item) => item.id === admission.id);
      const agent = database.agents.find((item) => item.id === admission.agentId);
      if (!current || !agent || current.status !== 'planning') {
        return { promote: false, ordinary: null as null | { agent: Agent; run: AgentRun } };
      }

      const timestamp = now();
      current.proposal = proposal;
      current.decision = decision.decision;
      current.allowNonvisualConfirmation = decision.allowNonvisualConfirmation;
      current.reason = decision.reason;
      current.error = null;
      current.updatedAt = timestamp;

      if (agent.status === 'stopped' || agent.codexThreadId !== current.threadId) {
        current.status = 'stale';
        current.reason = 'Agent binding changed during impact planning';
        current.completedAt = timestamp;
        current.agentUpdatedAt = agent.updatedAt;
        return { promote: false, ordinary: null };
      }

      agent.status = 'ready';
      agent.lastError = null;
      agent.updatedAt = timestamp;
      current.agentUpdatedAt = timestamp;

      if (decision.decision === 'confirmation_required') {
        current.status = 'confirmation_required';
        return { promote: false, ordinary: null };
      }
      if (decision.decision === 'governed') {
        current.status = 'confirmation_required';
        return { promote: true, ordinary: null };
      }
      return {
        promote: false,
        ordinary: this.createCandidateRun(database, current, agent, timestamp),
      };
    });

    if (outcome.ordinary) {
      void this.executeCandidate(admission, outcome.ordinary.agent, outcome.ordinary.run).catch(
        () => undefined,
      );
    }
    if (outcome.promote) {
      await this.missions.promotePlaygroundImpact(admission.id).catch(async (caught) => {
        await this.markStale(
          admission.id,
          caught instanceof Error ? caught.message : String(caught),
        );
      });
    }
  }

  private createCandidateRun(
    database: ReturnType<JsonStore['snapshot']>,
    admission: PlaygroundImpactAdmission,
    agent: Agent,
    timestamp: string,
  ): { agent: Agent; run: AgentRun } {
    const run: AgentRun = {
      id: randomUUID(),
      agentId: agent.id,
      status: 'queued',
      prompt: admission.prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
      context: { kind: 'playground_candidate', admissionId: admission.id },
    };
    const agentAtStart = structuredClone(agent);
    database.runs.push(run);
    admission.status = 'staging';
    admission.decision = 'nonvisual';
    admission.candidateRunId = run.id;
    admission.updatedAt = timestamp;
    agent.status = 'busy';
    agent.updatedAt = timestamp;
    return { agent: agentAtStart, run: structuredClone(run) };
  }

  private async stageCandidateRun(
    admissionId: string,
  ): Promise<{ admission: PlaygroundImpactAdmission; agent: Agent; run: AgentRun } | null> {
    return this.store.mutate((database) => {
      const admission = database.playgroundImpactAdmissions.find((item) => item.id === admissionId);
      const agent = admission ? database.agents.find((item) => item.id === admission.agentId) : null;
      if (!admission || !agent || admission.status !== 'confirmation_required') return null;
      if (
        agent.status !== 'ready' ||
        agent.updatedAt !== admission.agentUpdatedAt ||
        agent.codexThreadId !== admission.threadId
      ) {
        throw new HttpError(409, 'Agent binding changed before admission', 'PLAYGROUND_IMPACT_STALE');
      }
      const created = this.createCandidateRun(database, admission, agent, now());
      return { admission: structuredClone(admission), ...created };
    });
  }

  private async executeCandidate(
    admissionInput: PlaygroundImpactAdmission,
    agentAtStart: Agent,
    run: AgentRun,
  ): Promise<void> {
    const admission = this.store.snapshot().playgroundImpactAdmissions.find(
      (item) => item.id === admissionInput.id,
    );
    if (!admission || admission.status !== 'staging' || admission.candidateRunId !== run.id) return;

    let candidatePath: string | null = null;
    try {
      const staged = await this.workspaces.createPlaygroundCandidate(
        admission.agentId,
        admission.id,
        admission.workspaceHash,
      );
      candidatePath = staged.path;

      const execution = await this.execution.start(agentAtStart, run, {
        agentId: admission.agentId,
        workspacePath: candidatePath,
        prompt: admission.prompt,
        threadId: admission.threadId,
        accessMode: 'write',
      });
      if (execution.error || !execution.result) {
        throw execution.error ?? new Error('Candidate execution did not return a result');
      }

      const authoritative = await this.workspaces.inspectAgentWorkspace(admission.agentId);
      if (authoritative.contentHash !== admission.workspaceHash) {
        throw new Error('Agent workspace changed during candidate execution');
      }
      const candidate = await this.workspaces.inspectPlaygroundCandidate(admission.id);
      const diff = compareWorkspaceProjections(authoritative, candidate);
      const impact = classifyWorkspaceDiff(
        diff,
        mergeFrameworkFacts(authoritative.frameworkFacts, candidate.frameworkFacts),
      );

      await this.store.mutate((database) => {
        const current = database.playgroundImpactAdmissions.find((item) => item.id === admission.id);
        const agent = database.agents.find((item) => item.id === admission.agentId);
        if (!current || !agent || current.status !== 'staging' || current.candidateRunId !== run.id) {
          throw new Error('Candidate admission authority changed');
        }

        const timestamp = now();
        current.changedFiles = diff.files.slice(0, 512);
        current.diffComplete = diff.complete;
        current.candidateThreadId = execution.result!.threadId;
        current.candidateWorkspaceHash = candidate.contentHash;
        current.reason = impact.reason;
        current.updatedAt = timestamp;

        if (impact.decision === 'nonvisual') {
          current.status = 'publishing';
          current.decision = 'nonvisual';
          current.publicationTransactionId = current.id;
          return;
        }

        agent.status = 'ready';
        agent.lastError = null;
        agent.updatedAt = timestamp;
        current.agentUpdatedAt = timestamp;

        if (impact.decision === 'uncertain') {
          current.status = 'confirmation_required';
          current.decision = 'confirmation_required';
          current.allowNonvisualConfirmation = true;
          return;
        }

        current.status = 'confirmation_required';
        current.decision = 'governed';
        current.allowNonvisualConfirmation = false;
        if (current.threadId !== null && agent.codexThreadId === current.threadId) {
          agent.codexThreadId = null;
        }
      });

      if (impact.decision === 'governed') {
        await this.workspaces.discardPlaygroundCandidate(admission.id).catch(() => undefined);
        candidatePath = null;
        await this.missions.promotePlaygroundImpact(admission.id);
        return;
      }

      if (impact.decision === 'uncertain') {
        candidatePath = null;
        return;
      }

      candidatePath = null;
      await this.publishCandidate(admission.id);
    } catch (error) {
      const reason = safeMissionText(
        error instanceof Error ? error.message : String(error),
        1_024,
        this.redactionSecrets,
      ).content;
      await this.store
        .mutate((database) => {
          const current = database.playgroundImpactAdmissions.find((item) => item.id === admission.id);
          if (!current || ['admitted', 'promoted'].includes(current.status)) return;
          const timestamp = now();
          current.status = 'failed';
          current.error = reason;
          current.reason = reason;
          current.updatedAt = timestamp;
          current.completedAt = timestamp;
          const agent = database.agents.find((item) => item.id === current.agentId);
          if (agent) {
            if (current.threadId !== null && agent.codexThreadId === current.threadId) {
              agent.codexThreadId = null;
            }
            agent.status = 'ready';
            agent.lastError = null;
            agent.updatedAt = timestamp;
            current.agentUpdatedAt = timestamp;
          }
        })
        .catch(() => undefined);
    } finally {
      const state = this.store.snapshot().playgroundImpactAdmissions.find(
        (item) => item.id === admission.id,
      );
      const preserveCandidate =
        state?.status === 'publishing' ||
        (state?.status === 'confirmation_required' && Boolean(state.candidateWorkspaceHash));
      if (candidatePath && !preserveCandidate) {
        await this.workspaces.discardPlaygroundCandidate(admission.id).catch(() => undefined);
      }
    }
  }

  private async publishCandidate(admissionId: string): Promise<void> {
    let publicationMayHaveStarted = false;
    let cleanupOnFailure = false;
    try {
      const snapshot = this.store.snapshot();
      const admission = snapshot.playgroundImpactAdmissions.find((item) => item.id === admissionId);
      if (!admission || !admission.candidateRunId || !admission.candidateWorkspaceHash) {
        throw new Error('Candidate publication binding is incomplete');
      }
      if (!['confirmation_required', 'publishing'].includes(admission.status)) {
        throw new Error('Candidate is not eligible for publication');
      }

      if (admission.status === 'confirmation_required') {
        const authoritative = await this.workspaces.inspectAgentWorkspace(admission.agentId);
        if (authoritative.contentHash !== admission.workspaceHash) {
          throw new Error('Agent workspace changed before candidate publication');
        }
        const candidate = await this.workspaces.inspectPlaygroundCandidate(admission.id);
        if (candidate.contentHash !== admission.candidateWorkspaceHash) {
          throw new Error('Candidate workspace changed before publication');
        }

        await this.store.mutate((database) => {
          const current = database.playgroundImpactAdmissions.find((item) => item.id === admission.id);
          const agent = database.agents.find((item) => item.id === admission.agentId);
          const run = database.runs.find((item) => item.id === admission.candidateRunId);
          if (
            !current ||
            !agent ||
            !run ||
            current.status !== 'confirmation_required' ||
            run.status !== 'completed' ||
            agent.codexThreadId !== current.threadId
          ) {
            throw new Error('Candidate publication authority changed');
          }
          const timestamp = now();
          current.status = 'publishing';
          current.decision = 'nonvisual';
          current.publicationTransactionId = current.id;
          current.updatedAt = timestamp;
          agent.status = 'busy';
          agent.updatedAt = timestamp;
          current.agentUpdatedAt = timestamp;
        });
      }

      publicationMayHaveStarted = true;
      const receipt = await this.workspaces.publishAgentWorkspace({
        transactionId: admission.id,
        agentId: admission.agentId,
        sourceRoot: this.workspaces.playgroundCandidatePath(admission.id),
        expectedAgentHash: admission.workspaceHash,
        expectedSourceHash: admission.candidateWorkspaceHash,
      });
      if (receipt.publishedHash !== admission.candidateWorkspaceHash) {
        throw new Error('Candidate publication hash mismatch');
      }

      await this.store.mutate((database) => {
        const current = database.playgroundImpactAdmissions.find((item) => item.id === admission.id);
        const agent = database.agents.find((item) => item.id === admission.agentId);
        const storedRun = database.runs.find((item) => item.id === admission.candidateRunId);
        if (
          !current ||
          !agent ||
          !storedRun ||
          current.status !== 'publishing' ||
          current.candidateRunId !== storedRun.id ||
          storedRun.status !== 'completed'
        ) {
          throw new Error('Candidate publication authority changed');
        }

        const timestamp = now();
        current.decision = 'nonvisual';
        current.admittedRunId = storedRun.id;
        current.updatedAt = timestamp;
        current.error = null;
        if (
          storedRun.output !== null &&
          !database.messages.some((message) => message.runId === storedRun.id && message.role === 'assistant')
        ) {
          database.messages.push({
            id: randomUUID(),
            agentId: agent.id,
            runId: storedRun.id,
            role: 'assistant',
            content: storedRun.output,
            createdAt: timestamp,
          });
        }
        agent.codexThreadId = current.candidateThreadId ?? current.threadId;
        agent.status = 'ready';
        agent.lastError = null;
        agent.updatedAt = timestamp;
        current.agentUpdatedAt = timestamp;
      });

      await this.workspaces.discardPlaygroundCandidate(admission.id).catch(() => undefined);
      await this.workspaces.finalizeAgentWorkspacePublication(admission.id).catch(() => undefined);
      await this.store.mutate((database) => {
        const current = database.playgroundImpactAdmissions.find((item) => item.id === admission.id);
        if (current?.status === 'publishing' && current.admittedRunId === admission.candidateRunId) {
          current.status = 'admitted';
          current.completedAt = now();
          current.updatedAt = current.completedAt;
        }
      });
    } catch (error) {
      const current = this.store.snapshot().playgroundImpactAdmissions.find(
        (item) => item.id === admissionId,
      );
      const reason = safeMissionText(
        error instanceof Error ? error.message : String(error),
        1_024,
        this.redactionSecrets,
      ).content;
      let publicationUnresolved = false;

      if (
        publicationMayHaveStarted &&
        current?.candidateWorkspaceHash &&
        current.publicationTransactionId
      ) {
        const recovery = await this.workspaces
          .recoverAgentWorkspacePublication({
            transactionId: current.publicationTransactionId,
            agentId: current.agentId,
            expectedAgentHash: current.workspaceHash,
            expectedPublishedHash: current.candidateWorkspaceHash,
          })
          .catch(() => ({ state: 'ambiguous' as const, contentHash: null }));
        publicationUnresolved = recovery.state !== 'original';
      }
      cleanupOnFailure = !publicationUnresolved;

      await this.store
        .mutate((database) => {
          const admission = database.playgroundImpactAdmissions.find((item) => item.id === admissionId);
          if (!admission || ['admitted', 'promoted'].includes(admission.status)) return;
          const timestamp = now();
          admission.status = publicationUnresolved ? 'publishing' : 'failed';
          admission.error = reason;
          admission.reason = reason;
          admission.updatedAt = timestamp;
          admission.completedAt = publicationUnresolved ? null : timestamp;
          const agent = database.agents.find((item) => item.id === admission.agentId);
          if (agent) {
            if (
              !publicationUnresolved &&
              admission.threadId !== null &&
              agent.codexThreadId === admission.threadId
            ) {
              agent.codexThreadId = null;
            }
            agent.status = publicationUnresolved ? 'error' : 'ready';
            agent.lastError = publicationUnresolved ? reason : null;
            agent.updatedAt = timestamp;
            admission.agentUpdatedAt = timestamp;
          }
        })
        .catch(() => undefined);
    } finally {
      if (cleanupOnFailure) {
        await this.workspaces.discardPlaygroundCandidate(admissionId).catch(() => undefined);
      }
    }
  }

  async reconcileStartup(): Promise<void> {
    const snapshot = this.store.snapshot();
    for (const admission of snapshot.playgroundImpactAdmissions.filter(
      (item) => item.status === 'publishing',
    )) {
      let ambiguous = false;
      try {
        if (
          !admission.publicationTransactionId ||
          !admission.candidateWorkspaceHash ||
          !admission.candidateRunId
        ) {
          throw new Error('Workspace publication recovery binding is incomplete');
        }

        let recovery = await this.workspaces.recoverAgentWorkspacePublication({
          transactionId: admission.publicationTransactionId,
          agentId: admission.agentId,
          expectedAgentHash: admission.workspaceHash,
          expectedPublishedHash: admission.candidateWorkspaceHash,
        });
        if (recovery.state === 'original') {
          const candidate = await this.workspaces.inspectPlaygroundCandidate(admission.id);
          if (candidate.contentHash !== admission.candidateWorkspaceHash) {
            throw new Error('Recovered candidate workspace binding is invalid');
          }
          await this.workspaces.publishAgentWorkspace({
            transactionId: admission.publicationTransactionId,
            agentId: admission.agentId,
            sourceRoot: this.workspaces.playgroundCandidatePath(admission.id),
            expectedAgentHash: admission.workspaceHash,
            expectedSourceHash: admission.candidateWorkspaceHash,
          });
          recovery = await this.workspaces.recoverAgentWorkspacePublication({
            transactionId: admission.publicationTransactionId,
            agentId: admission.agentId,
            expectedAgentHash: admission.workspaceHash,
            expectedPublishedHash: admission.candidateWorkspaceHash,
          });
        }
        if (recovery.state !== 'published') {
          ambiguous = recovery.state === 'ambiguous';
          throw new Error('Workspace publication recovery is ambiguous');
        }

        await this.store.mutate((database) => {
          const current = database.playgroundImpactAdmissions.find((item) => item.id === admission.id);
          const agent = database.agents.find((item) => item.id === admission.agentId);
          const run = database.runs.find((item) => item.id === admission.candidateRunId);
          if (!current || !agent || !run || current.status !== 'publishing' || run.status !== 'completed') {
            throw new Error('Workspace publication recovery authority changed');
          }
          const timestamp = now();
          current.status = 'admitted';
          current.decision = 'nonvisual';
          current.admittedRunId = run.id;
          current.error = null;
          current.completedAt = timestamp;
          current.updatedAt = timestamp;
          if (
            run.output !== null &&
            !database.messages.some((message) => message.runId === run.id && message.role === 'assistant')
          ) {
            database.messages.push({
              id: randomUUID(),
              agentId: agent.id,
              runId: run.id,
              role: 'assistant',
              content: run.output,
              createdAt: timestamp,
            });
          }
          agent.codexThreadId = current.candidateThreadId ?? current.threadId;
          agent.status = 'ready';
          agent.lastError = null;
          agent.updatedAt = timestamp;
          current.agentUpdatedAt = timestamp;
        });

        await this.workspaces.discardPlaygroundCandidate(admission.id).catch(() => undefined);
        await this.workspaces
          .finalizeAgentWorkspacePublication(admission.publicationTransactionId)
          .catch(() => undefined);
      } catch (error) {
        const reason = safeMissionText(
          error instanceof Error ? error.message : String(error),
          1_024,
          this.redactionSecrets,
        ).content;
        await this.store.mutate((database) => {
          const current = database.playgroundImpactAdmissions.find((item) => item.id === admission.id);
          const agent = database.agents.find((item) => item.id === admission.agentId);
          if (!current || current.status !== 'publishing') return;
          const timestamp = now();
          current.status = ambiguous ? 'publishing' : 'failed';
          current.error = reason;
          current.reason = reason;
          current.updatedAt = timestamp;
          current.completedAt = ambiguous ? null : timestamp;
          if (agent) {
            if (!ambiguous && current.threadId !== null && agent.codexThreadId === current.threadId) {
              agent.codexThreadId = null;
            }
            agent.status = ambiguous ? 'error' : 'ready';
            agent.lastError = ambiguous ? reason : null;
            agent.updatedAt = timestamp;
            current.agentUpdatedAt = timestamp;
          }
        });
      }
    }

    const failedCandidates = this.store
      .snapshot()
      .playgroundImpactAdmissions
      .filter((item) => item.status === 'failed' && item.candidateRunId);
    for (const admission of failedCandidates) {
      await this.store.mutate((database) => {
        const current = database.playgroundImpactAdmissions.find((item) => item.id === admission.id);
        const agent = database.agents.find((item) => item.id === admission.agentId);
        if (
          current &&
          agent &&
          current.threadId !== null &&
          agent.codexThreadId === current.threadId
        ) {
          agent.codexThreadId = null;
          agent.updatedAt = now();
          current.agentUpdatedAt = agent.updatedAt;
        }
      });
      await this.workspaces.discardPlaygroundCandidate(admission.id).catch(() => undefined);
    }
  }

  private async markStale(
    admissionId: string,
    reason: string,
  ): Promise<PlaygroundImpactAdmission> {
    return this.store.mutate((database) => {
      const admission = database.playgroundImpactAdmissions.find((item) => item.id === admissionId);
      if (!admission) throw new HttpError(404, 'Playground impact admission not found');
      if (admission.status === 'admitted' || admission.status === 'promoted') {
        return structuredClone(admission);
      }
      const timestamp = now();
      admission.status = 'stale';
      admission.reason = safeMissionText(reason, 1_024, this.redactionSecrets).content;
      admission.error = admission.reason;
      admission.updatedAt = timestamp;
      admission.completedAt = timestamp;
      const agent = database.agents.find((item) => item.id === admission.agentId);
      if (agent?.status === 'busy') {
        agent.status = 'ready';
        agent.lastError = null;
        agent.updatedAt = timestamp;
      }
      return structuredClone(admission);
    });
  }
}
