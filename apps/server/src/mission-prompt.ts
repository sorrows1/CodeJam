import type {
  Mission,
  MissionArtifact,
  MissionTask,
  VerificationRun,
} from './types.js';
import { safeMissionText } from './mission-evidence.js';
import { designContractAuthoringGuide } from './design-contract-authoring.js';
import { designBundleAuthoringGuide } from './design-bundle-authoring.js';

export const MAX_GOAL_BYTES = 8 * 1024;
export const MAX_INSTRUCTIONS_BYTES = 8 * 1024;
export const MAX_TASK_BYTES = 4 * 1024;
export const MAX_ARTIFACT_EXCERPT_BYTES = 8 * 1024;
export const MAX_ARTIFACTS_BYTES = 24 * 1024;
export const MAX_PROMPT_BYTES = 48 * 1024;

const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

export function boundedMissionSection(value: string, maxBytes: number): string {
  const marker = '\n[content truncated by Conductor]';
  const safe = safeMissionText(value, maxBytes);
  return safe.truncated
    ? safeMissionText(value, Math.max(0, maxBytes - bytes(marker))).content + marker
    : safe.content;
}

export function designTaskDefinition(): { title: string; instruction: string } {
  return {
    title: 'Design',
    instruction:
      'Inspect the real source application and prepare one atomic desktop Design bundle covering every affected route, shared surface, and named state. Write only .conductor/design-draft/design-bundle.json. Use schemaVersion 1 with exact root keys schemaVersion, primarySurfaceId, surfaces. Each surface has exact keys id, title, route, entrypoint, sourcePaths, sharedDependencies, states, indexHtml, stylesCss, contract. routes and entrypoints are strings, path collections are repository-relative string arrays, and states is an array of unique non-empty strings rather than objects. Every contract follows the current Conductor Design contract protocol and uses a desktop viewport. The server protects and hash-binds the whole bundle; partial approval is unsupported. Do not modify application source files, and do not claim human approval or Mission completion.',
  };
}

export function buildMissionPrompt(
  detail: { mission: Mission; tasks: MissionTask[]; artifacts: MissionArtifact[] },
  task: MissionTask,
): string {
  const participant = detail.mission.participants.find((item) => item.agentId === task.assignedAgentId)?.snapshot;
  const candidates = task.inputArtifactIds
    .map((id) => detail.artifacts.find((artifact) => artifact.id === id))
    .filter((artifact): artifact is MissionArtifact => artifact !== undefined && (artifact.createdBy.kind === 'human' || detail.tasks.find((candidate) => candidate.id === artifact.taskId)?.status === 'completed'))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const excerpts: string[] = [];
  let total = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const artifact = candidates[index];
    if (!artifact) continue;
    const producer = detail.mission.participants.find((item) => item.agentId === artifact.createdBy.agentId)?.snapshot.name ?? 'Agent';
    const producerTask = detail.tasks.find((item) => item.id === artifact.taskId)?.title ?? 'prior task';
    const excerpt = `Handoff artifact from ${producer} (${producerTask}):\n${boundedMissionSection(artifact.content ?? '', MAX_ARTIFACT_EXCERPT_BYTES)}`;
    if (total + bytes(excerpt) > MAX_ARTIFACTS_BYTES) continue;
    excerpts.unshift(excerpt);
    total += bytes(excerpt);
  }
  if (excerpts.length < candidates.length) excerpts.unshift('[Earlier handoff artifacts omitted to keep Mission context bounded]');
  const currentDesignGuide = task.stage === 'design' ? [designBundleAuthoringGuide(), designContractAuthoringGuide()].join('\n\n') : null;
  const stableTaskInstruction = currentDesignGuide ? task.instruction.replaceAll(currentDesignGuide, '').trim() : task.instruction;
  const sections = [
    'You are participating in a Conductor Mission. Work only in the shared Conductor Mission workspace; preserve existing files and do not expose credentials or private reasoning.',
    `Participant: ${boundedMissionSection(participant?.name ?? 'Agent', 4 * 1024)}`,
    participant?.description ? `Purpose:\n${boundedMissionSection(participant.description, 4 * 1024)}` : '',
    participant?.instructions ? `Participant instructions:\n${boundedMissionSection(participant.instructions, MAX_INSTRUCTIONS_BYTES)}` : '',
    `Mission goal:\n${boundedMissionSection(detail.mission.goal, MAX_GOAL_BYTES)}`,
    `Task: ${boundedMissionSection(task.title, MAX_TASK_BYTES)}\n${boundedMissionSection(stableTaskInstruction, MAX_TASK_BYTES)}`,
    currentDesignGuide ? 'Current Conductor Design execution protocol:\n' + currentDesignGuide : '',
    excerpts.length ? `Selected durable handoffs (chronological):\n${excerpts.join('\n\n')}` : 'No prior handoff artifacts are available; establish a useful bounded handoff for the next participant.',
    'Final response contract: report the result, files/actions taken, checks run, blockers, and a concise handoff. Prose reporting a defect or blocker is still a successful execution; do not invent success.',
  ].filter(Boolean);
  return boundedMissionSection(sections.join('\n\n'), MAX_PROMPT_BYTES);
}

export function buildImplementationPrompt(input: {
  mission: Mission;
  task: MissionTask;
  participant: { name: string; description: string; instructions: string } | null;
  designRevisionId: string;
  designVersion: number;
  packageHash: string;
  previewHash: string;
  contractHash: string;
  contractJson: string;
  packageExcerpt: string;
  previewExcerpt: string;
  workspaceRevisionId: string;
}): string {
  const participant = input.participant;
  const sections = [
    'You are the Builder in a Conductor Mission. Work only in the shared Mission workspace and never access or modify protected reference storage.',
    `Participant: ${boundedMissionSection(participant?.name ?? 'Builder', 4 * 1024)}`,
    participant?.description ? `Purpose:\n${boundedMissionSection(participant.description, 4 * 1024)}` : '',
    participant?.instructions ? `Participant instructions:\n${boundedMissionSection(participant.instructions, MAX_INSTRUCTIONS_BYTES)}` : '',
    `Mission goal:\n${boundedMissionSection(input.mission.goal, MAX_GOAL_BYTES)}`,
    `Approved DesignRevision: ${input.designRevisionId} (version ${input.designVersion})\nPackage SHA-256: ${input.packageHash}\nPreview SHA-256: ${input.previewHash}\nContract SHA-256: ${input.contractHash}`,
    `Approved contract (read-only):\n${boundedMissionSection(input.contractJson, 16 * 1024)}`,
    `Canonical package excerpt (read-only):\n${boundedMissionSection(input.packageExcerpt, 6 * 1024)}`,
    `Preview excerpt (read-only):\n${boundedMissionSection(input.previewExcerpt, 6 * 1024)}`,
    `Input Mission workspace revision: ${input.workspaceRevisionId}`,
    'The protected rendered DesignRevision is the visual source of truth. Reproduce it as closely as reasonably possible: preserve layout, proportions, dimensions, spacing, typography, colors, component placement, and visual hierarchy. Do not reinterpret or redesign the approved reference. Minor browser or implementation-specific rendering differences are acceptable, but material visual deviations are not. Implement the approved semantic behavior and use only the application\'s existing bounded checks. Do not add or download browser-automation/verification dependencies, write an ad-hoc browser verifier, or duplicate Conductor\'s independent verification. If no relevant test script exists, use an existing build or typecheck instead. Report files changed and checks run. Never modify protected reference material or claim that the Mission is complete; an independent verifier owns completion.',
  ].filter(Boolean);
  return boundedMissionSection(sections.join('\n\n'), MAX_PROMPT_BYTES);
}

export function buildRepairPrompt(input: {
  mission: Mission;
  task: MissionTask;
  participant: { name: string; description: string; instructions: string } | null;
  designRevisionId: string;
  designVersion: number;
  contractJson: string;
  workspaceRevisionId: string;
  verification: VerificationRun;
  humanFeedback: string | null;
}): string {
  const failedChecks = input.verification.checks.filter((check) => !check.passed).map((check) => `- ${check.label}: ${check.details}`).join('\n');
  const sections = [
    'You are performing a bounded Conductor Repair. Work only in the shared Mission workspace. The approved design/reference is immutable and must not be redesigned or modified.',
    `Participant: ${boundedMissionSection(input.participant?.name ?? 'Builder', 4 * 1024)}`,
    input.participant?.instructions ? `Participant instructions:\n${boundedMissionSection(input.participant.instructions, MAX_INSTRUCTIONS_BYTES)}` : '',
    `Mission goal:\n${boundedMissionSection(input.mission.goal, MAX_GOAL_BYTES)}`,
    `Approved DesignRevision: ${input.designRevisionId} (version ${input.designVersion})`,
    `Input implementation workspace revision: ${input.workspaceRevisionId}`,
    `Source VerificationRun: ${input.verification.id} (${input.verification.status})`,
    `Approved contract (read-only):\n${boundedMissionSection(input.contractJson, 16 * 1024)}`,
    failedChecks ? `Verifier findings to repair:\n${boundedMissionSection(failedChecks, 12 * 1024)}` : 'The verifier has no failed structured checks; preserve all currently passing behavior.',
    input.humanFeedback ? `Human implementation-review feedback:\n${boundedMissionSection(input.humanFeedback, 8 * 1024)}` : '',
    'Make the smallest implementation changes necessary to satisfy the findings while preserving the approved visual/product intent. Run useful local checks. Do not change the protected reference, broaden scope, or claim Mission completion. Conductor will capture a new immutable workspace revision and independently verify it again.',
  ].filter(Boolean);
  return boundedMissionSection(sections.join('\n\n'), MAX_PROMPT_BYTES);
}
