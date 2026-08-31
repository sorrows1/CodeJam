import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import { RunExecutionService } from "./run-execution.js";
import type { AgentRunner, PlaygroundImpactAdmission, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class CredentialOutputRunner implements AgentRunner {
  async run(): Promise<RunnerResult> {
    return {
      output: JSON.stringify({ authorization: "output-authorization-secret", accessKeyId: "output-access-key-secret", cookie: "output-cookie-secret" }),
      threadId: "credential-thread",
      usage: { inputTokens: 4, outputTokens: 3 },
    };
  }
  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

class CredentialErrorRunner implements AgentRunner {
  async run(): Promise<RunnerResult> {
    throw new Error("Authorization: error-authorization-secret; Cookie: error-cookie-secret; AWS_SECRET_ACCESS_KEY=error-secret-key-secret");
  }
  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    MODEL_API_KEY: "test-key",
    MODEL_NAME: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const service = new AgentService(
    config,
    store,
    workspaces,
    new RunExecutionService(store, runner),
  );
  await service.initialize();
  return service;
}

async function makeServiceWithStore(): Promise<{ service: AgentService; store: JsonStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    MODEL_API_KEY: "test-key",
    MODEL_NAME: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const service = new AgentService(
    config,
    store,
    workspaces,
    new RunExecutionService(store, new FakeRunner()),
  );
  await service.initialize();
  return { service, store };
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("does not let start clear an unresolved workspace publication", async () => {
    const { service, store } = await makeServiceWithStore();
    const agent = await service.createAgent({ name: "Publication recovery" });
    await service.stopAgent(agent.id);
    const timestamp = new Date().toISOString();
    const admission: PlaygroundImpactAdmission = {
      id: "impact-publishing",
      requestId: "request-publishing",
      agentId: agent.id,
      prompt: "Update backend behavior",
      status: "publishing",
      decision: "nonvisual",
      allowNonvisualConfirmation: false,
      reason: "Workspace publication recovery is ambiguous",
      proposal: null,
      workspaceHash: "a".repeat(64),
      agentUpdatedAt: timestamp,
      threadId: null,
      proposalRunId: "proposal-run",
      admittedRunId: null,
      candidateRunId: "candidate-run",
      candidateThreadId: "candidate-thread",
      candidateWorkspaceHash: "b".repeat(64),
      changedFiles: [],
      diffComplete: true,
      inventoryTruncated: false,
      repositoryFactsHash: "c".repeat(64),
      publicationTransactionId: "impact-publishing",
      missionId: null,
      error: "Workspace publication recovery is ambiguous",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };
    await store.mutate((database) => {
      database.runs.push(
        {
          id: "proposal-run",
          agentId: agent.id,
          status: "completed",
          prompt: "Plan impact",
          output: "{}",
          error: null,
          usage: null,
          startedAt: timestamp,
          completedAt: timestamp,
          createdAt: timestamp,
          context: { kind: "playground_impact", admissionId: admission.id },
        },
        {
          id: "candidate-run",
          agentId: agent.id,
          status: "completed",
          prompt: admission.prompt,
          output: "done",
          error: null,
          usage: null,
          startedAt: timestamp,
          completedAt: timestamp,
          createdAt: timestamp,
          context: { kind: "playground_candidate", admissionId: admission.id },
        },
      );
      database.playgroundImpactAdmissions.push(admission);
    });

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(service.getAgent(agent.id).status).toBe("stopped");
  });

  it("preserves terminal candidate Runs when deleting an Agent with admitted Playground history", async () => {
    const { service, store } = await makeServiceWithStore();
    const agent = await service.createAgent({ name: "Candidate history" });
    const timestamp = new Date().toISOString();
    const admissionId = "impact-admitted";
    await store.mutate((database) => {
      database.runs.push(
        {
          id: "proposal-run-admitted",
          agentId: agent.id,
          status: "completed",
          prompt: "Plan impact",
          output: "{}",
          error: null,
          usage: null,
          startedAt: timestamp,
          completedAt: timestamp,
          createdAt: timestamp,
          context: { kind: "playground_impact", admissionId },
        },
        {
          id: "candidate-run-admitted",
          agentId: agent.id,
          status: "completed",
          prompt: "Update backend behavior",
          output: "done",
          error: null,
          usage: null,
          startedAt: timestamp,
          completedAt: timestamp,
          createdAt: timestamp,
          context: { kind: "playground_candidate", admissionId },
        },
      );
      database.playgroundImpactAdmissions.push({
        id: admissionId,
        requestId: "request-admitted",
        agentId: agent.id,
        prompt: "Update backend behavior",
        status: "admitted",
        decision: "nonvisual",
        allowNonvisualConfirmation: false,
        reason: "No frontend impact",
        proposal: null,
        workspaceHash: "a".repeat(64),
        agentUpdatedAt: timestamp,
        threadId: null,
        proposalRunId: "proposal-run-admitted",
        admittedRunId: "candidate-run-admitted",
        candidateRunId: "candidate-run-admitted",
        candidateThreadId: "candidate-thread",
        candidateWorkspaceHash: "b".repeat(64),
        changedFiles: [],
        diffComplete: true,
        inventoryTruncated: false,
        repositoryFactsHash: "c".repeat(64),
        publicationTransactionId: admissionId,
        missionId: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
      });
    });

    await expect(service.deleteAgent(agent.id)).resolves.toBeTruthy();
    expect(service.listAgents()).toHaveLength(0);
    expect(store.snapshot().runs.filter((run) => run.agentId === agent.id).map((run) => run.context.kind).sort()).toEqual(["playground_candidate", "playground_impact"]);
  });

  it("redacts credential-shaped Playground output in Runs, Messages, and returned records", async () => {
    const service = await makeService(new CredentialOutputRunner());
    const agent = await service.createAgent({ name: "Output safety" });
    const returned = await service.sendMessage(agent.id, "accessKeyId=prompt-access-key-secret");
    expect(JSON.stringify(returned)).not.toContain("prompt-access-key-secret");

    await expect.poll(() => service.getRun(returned.run.id).status).toBe("completed");
    const run = service.getRun(returned.run.id);
    const messages = service.getMessages(agent.id);
    const serialized = JSON.stringify({ run, messages, agent: service.getAgent(agent.id) });
    expect(serialized).not.toContain("output-authorization-secret");
    expect(serialized).not.toContain("output-access-key-secret");
    expect(serialized).not.toContain("output-cookie-secret");
    expect(run.output).toContain("[REDACTED]");
    expect(messages[1]?.content).toContain("[REDACTED]");
    expect(service.getAgent(agent.id).codexThreadId).toBe("credential-thread");
  });

  it("redacts credential-shaped Playground failures in Run and Agent error surfaces", async () => {
    const service = await makeService(new CredentialErrorRunner());
    const agent = await service.createAgent({ name: "Error safety" });
    const returned = await service.sendMessage(agent.id, "Cookie=prompt-cookie-secret");
    expect(JSON.stringify(returned)).not.toContain("prompt-cookie-secret");

    await expect.poll(() => service.getRun(returned.run.id).status).toBe("failed");
    const run = service.getRun(returned.run.id);
    const currentAgent = service.getAgent(agent.id);
    const serialized = JSON.stringify({ run, agent: currentAgent });
    expect(serialized).not.toContain("error-authorization-secret");
    expect(serialized).not.toContain("error-cookie-secret");
    expect(serialized).not.toContain("error-secret-key-secret");
    expect(run.error).toContain("[REDACTED]");
    expect(currentAgent.lastError).toContain("[REDACTED]");
  });

});
