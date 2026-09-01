import { describe, expect, it } from "vitest";
import type { Message, PlaygroundImpactAdmission } from "./types";
import { buildPlaygroundFeed } from "./playground-feed";

const message = (id: string, runId: string, role: Message["role"]): Message => ({
  id,
  agentId: "agent-1",
  runId,
  role,
  content: id,
  createdAt: "2026-09-01T00:00:00.000Z",
});

const admission = (id: string, proposalRunId: string): PlaygroundImpactAdmission => ({
  id,
  requestId: `request-${id}`,
  agentId: "agent-1",
  prompt: id,
  status: "promoted",
  decision: "governed",
  allowNonvisualConfirmation: false,
  reason: "frontend impact",
  proposal: null,
  workspaceHash: "a".repeat(64),
  agentUpdatedAt: "2026-09-01T00:00:00.000Z",
  threadId: null,
  proposalRunId,
  admittedRunId: null,
  missionId: `mission-${id}`,
  error: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  completedAt: "2026-09-01T00:00:00.000Z",
});

describe("buildPlaygroundFeed", () => {
  it("places each Conductor card directly after the request that created it", () => {
    const feed = buildPlaygroundFeed(
      [message("first-chat", "run-1", "user"), message("second-chat", "run-2", "user")],
      [admission("first-card", "run-1"), admission("second-card", "run-2")],
    );

    expect(feed.map((item) => item.id)).toEqual([
      "message-first-chat",
      "impact-first-card",
      "message-second-chat",
      "impact-second-card",
    ]);
  });

  it("keeps an ordinary assistant reply after its request's Conductor card", () => {
    const feed = buildPlaygroundFeed(
      [message("request", "proposal-run", "user"), message("reply", "candidate-run", "assistant")],
      [admission("request-card", "proposal-run")],
    );

    expect(feed.map((item) => item.id)).toEqual([
      "message-request",
      "impact-request-card",
      "message-reply",
    ]);
  });

  it("still shows historical admissions whose correlated message is unavailable", () => {
    const feed = buildPlaygroundFeed(
      [message("available-chat", "run-1", "user")],
      [admission("orphan-card", "missing-run")],
    );

    expect(feed.map((item) => item.id)).toEqual([
      "message-available-chat",
      "impact-orphan-card",
    ]);
  });
});
