import type { Message, PlaygroundImpactAdmission } from "./types";

export type PlaygroundFeedItem =
  | { kind: "message"; id: string; message: Message }
  | { kind: "impact"; id: string; admission: PlaygroundImpactAdmission };

export function buildPlaygroundFeed(
  messages: readonly Message[],
  admissions: readonly PlaygroundImpactAdmission[],
): PlaygroundFeedItem[] {
  const admissionByProposalRunId = new Map(
    admissions.map((admission) => [admission.proposalRunId, admission]),
  );
  const renderedAdmissionIds = new Set<string>();
  const feed: PlaygroundFeedItem[] = [];

  for (const message of messages) {
    feed.push({ kind: "message", id: `message-${message.id}`, message });

    if (message.role !== "user") continue;
    const admission = admissionByProposalRunId.get(message.runId);
    if (!admission) continue;

    feed.push({ kind: "impact", id: `impact-${admission.id}`, admission });
    renderedAdmissionIds.add(admission.id);
  }

  for (const admission of admissions) {
    if (!renderedAdmissionIds.has(admission.id)) {
      feed.push({ kind: "impact", id: `impact-${admission.id}`, admission });
    }
  }

  return feed;
}
