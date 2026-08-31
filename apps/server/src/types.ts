export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  context: RunContext;
}

export type RunContext =
  | { kind: "playground" }
  | { kind: "playground_impact"; admissionId: string }
  | { kind: "playground_candidate"; admissionId: string }
  | { kind: "mission"; missionId: string; taskId: string; attemptId: string };

export type PlaygroundImpactDecision = "nonvisual" | "governed" | "confirmation_required";
export type PlaygroundImpactStatus = "planning" | "confirmation_required" | "staging" | "publishing" | "admitted" | "promoting" | "promoted" | "stale" | "failed";
export interface PlaygroundImpactSurfaceProposal {
  id: string;
  route: string;
  entrypoint: string;
  sourcePaths: string[];
  sharedDependencies: string[];
  states: string[];
  viewport: { width: number; height: number };
}
export interface PlaygroundImpactProposal {
  routes: string[];
  entrypoints: string[];
  sharedLayouts: string[];
  componentDependencies: string[];
  predictedWritePaths: string[];
  surfaces: PlaygroundImpactSurfaceProposal[];
  effects: { visual: boolean; interaction: boolean; accessibility: boolean; display: boolean };
  evidence: string[];
  uncertainty: "low" | "medium" | "high";
}
export interface PlaygroundImpactAdmission {
  id: string;
  requestId: string;
  agentId: string;
  prompt: string;
  status: PlaygroundImpactStatus;
  decision: PlaygroundImpactDecision | null;
  allowNonvisualConfirmation: boolean;
  reason: string | null;
  proposal: PlaygroundImpactProposal | null;
  workspaceHash: string;
  agentUpdatedAt: string;
  threadId: string | null;
  proposalRunId: string;
  admittedRunId: string | null;
  candidateRunId?: string | null;
  candidateThreadId?: string | null;
  candidateWorkspaceHash?: string | null;
  changedFiles?: Array<{ path: string; operation: "ADDED" | "MODIFIED" | "DELETED" }>;
  diffComplete?: boolean;
  inventoryTruncated?: boolean;
  repositoryFactsHash?: string | null;
  publicationTransactionId?: string | null;
  missionId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type MissionStatus = "pending" | "running" | "paused" | "blocked" | "recovered_paused" | "completed" | "failed" | "cancelled";
export type IntentWorkflowPhase = "designing" | "awaiting_approval" | "implementing" | "verifying" | "repairing" | "awaiting_intervention" | "completed";
export type MissionTaskStage = "design" | "implement" | "repair";
export type MissionTaskStatus = "pending" | "running" | "paused" | "blocked" | "interrupted" | "completed" | "failed" | "stale" | "cancelled";
export type TaskAttemptStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type AttemptFailureCategory = "agent" | "infrastructure" | "cancelled" | "interrupted";
export type MissionArtifactKind = "agent_output" | "human_intervention" | "design_package" | "design_preview" | "design_contract" | "design_feedback" | "verification_report" | "reference_screenshot" | "actual_screenshot";

export interface MissionParticipant { agentId: string; order: number; snapshot: { name: string; description: string; instructions: string; agentUpdatedAt: string } }
export type MissionRevisionStatus = "unversioned" | "clean" | "uncheckpointed";
export type MissionRevisionOrigin = "mission_start" | "task_success" | "failed_attempt" | "startup_recovery" | "human_intervention" | "rollback";
export type MissionRevisionBoundary =
  | { kind: "before_task"; taskId: string }
  | { kind: "after_task"; taskId: string }
  | { kind: "after_failed_attempt"; taskId: string; attemptId: string }
  | { kind: "interrupted_attempt"; taskId: string; attemptId: string }
  | { kind: "human_intervention"; taskId: string }
  | { kind: "rollback"; taskId: string; restoredFromRevisionId: string };
export interface MissionWorkspaceRevision { id: string; missionId: string; sequence: number; parentRevisionId: string | null; restoredFromRevisionId: string | null; snapshotKey: string; contentHash: string; origin: MissionRevisionOrigin; boundaries: MissionRevisionBoundary[]; taskId: string | null; attemptId: string | null; interventionArtifactId: string | null; createdBy: "system" | "agent" | "human"; createdAt: string }
export interface MissionWorkspace { owner: "conductor"; key: string; state: "provisioning" | "ready" | "unavailable"; source: { kind: "agent_workspace"; agentId: string; agentUpdatedAt: string; impactAdmissionId: string | null; contentHash: string | null }; currentRevisionId: string | null; revisionStatus: MissionRevisionStatus; nextRevisionSequence: number }

export interface IntentWorkflowState {
  phase: IntentWorkflowPhase;
  designerAgentId: string;
  builderAgentId: string;
  latestDesignRevisionId: string | null;
  approvedDesignRevisionId: string | null;
  implementedWorkspaceRevisionId: string | null;
  currentVerificationRunId: string | null;
  repairCycle: number;
  maxRepairCycles: number;
}

export interface Mission { id: string; goal: string; status: MissionStatus; participants: MissionParticipant[]; workflow: IntentWorkflowState; workspace: MissionWorkspace; currentTaskId: string | null; nextEventSequence: number; activeRecoveryCommandId: string | null; tokenBudget: number | null; createdAt: string; updatedAt: string; startedAt: string | null; completedAt: string | null }
export interface MissionTask {
  id: string;
  missionId: string;
  order: number;
  stage: MissionTaskStage;
  assignedAgentId: string;
  title: string;
  instruction: string;
  inputDesignRevisionId: string | null;
  inputVerificationRunId: string | null;
  inputWorkspaceRevisionId: string | null;
  repairCycle: number | null;
  status: MissionTaskStatus;
  authoritativeAttemptId: string | null;
  authorityVersion: number;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  outputWorkspaceRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
export interface TaskAttempt {
  id: string;
  missionId: string;
  taskId: string;
  agentId: string;
  attemptNumber: number;
  authorityVersion: number;
  stage: MissionTaskStage;
  inputDesignRevisionId: string | null;
  inputVerificationRunId: string | null;
  inputWorkspaceRevisionId: string | null;
  repairCycle: number | null;
  status: TaskAttemptStatus;
  runId: string | null;
  runtimeThreadId: string | null;
  inputArtifactIds: string[];
  outputArtifactId: string | null;
  outputWorkspaceRevisionId: string | null;
  usage: RunUsage | null;
  error: { category: AttemptFailureCategory; message: string } | null;
  supersededAt: string | null;
  supersededByAttemptId: string | null;
  startedByRecoveryCommandId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export type ArtifactStorage = { kind: "inline" } | { kind: "external"; key: string };
export interface MissionArtifact {
  id: string;
  missionId: string;
  taskId: string | null;
  attemptId: string | null;
  kind: MissionArtifactKind;
  mediaType: string;
  content: string | null;
  storage: ArtifactStorage;
  sha256: string;
  workspaceRevisionId: string | null;
  createdBy: { kind: "system" | "agent" | "human"; agentId: string | null };
  originalByteLength: number;
  truncated: boolean;
  createdAt: string;
}

export interface DesignRevision {
  id: string;
  missionId: string;
  version: number;
  parentRevisionId: string | null;
  status: "draft" | "approved" | "superseded";
  sourceTaskId: string;
  sourceAttemptId: string;
  packageArtifactId: string;
  packageHash: string;
  previewArtifactId: string;
  previewHash: string;
  contractArtifactId: string;
  contractHash: string;
  feedbackArtifactId: string | null;
  createdAt: string;
  approvedAt: string | null;
  supersededAt: string | null;
  reviewedSurfaceIds?: string[] | null;
  reviewedBundleHash?: string | null;
}

export interface VerificationCheck {
  id: string;
  kind: 'text' | 'element' | 'interaction' | 'runtime';
  label: string;
  passed: boolean;
  details: string;
}

export interface VerificationRun {
  id: string;
  missionId: string;
  designRevisionId: string;
  workspaceRevisionId: string;
  cycle: number;
  status: "queued" | "running" | "passed" | "failed" | "error";
  correlationId: string;
  checks: VerificationCheck[];
  consoleErrors: string[];
  pageErrors: string[];
  url: string | null;
  durationMs: number | null;
  referenceScreenshotArtifactId: string | null;
  actualScreenshotArtifactId: string | null;
  reportArtifactId: string | null;
  visualDifference: number | null;
  error: { category: "infrastructure"; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export type MissionEventType = "mission_created" | "participants_reserved" | "workspace_ready" | "attempt_started" | "attempt_completed" | "attempt_failed" | "attempt_result_discarded" | "mission_status_changed" | "participants_released" | "startup_interrupted" | "revision_created" | "revision_restored" | "human_intervention" | "downstream_marked_stale" | "recovery_command" | "recovery_completed" | "budget_admission_denied" | "design_revision_created" | "design_feedback_submitted" | "design_approved" | "implementation_admission_denied" | "verification_started" | "verification_passed" | "verification_failed" | "verification_error" | "verification_result_discarded" | "implementation_precheck_passed" | "implementation_review_accepted" | "implementation_changes_requested" | "repair_scheduled" | "workspace_publication_started" | "workspace_publication_failed" | "workspace_published" | "intent_workflow_completed";
export interface MissionEvent { id: string; missionId: string; sequence: number; type: MissionEventType; taskId: string | null; attemptId: string | null; agentId: string | null; actor: "system" | "agent" | "human"; details: Record<string, string | number | boolean | null | undefined>; createdAt: string }

export type MissionRecoveryAction = "resume" | "retry_current" | "rollback_and_retry" | "intervene_and_retry" | "stop_preserve" | "stop_restore";
export type MissionRecoveryCommandStatus = "applying" | "completed" | "failed" | "interrupted";
export interface MissionRecoveryCommand { id: string; missionId: string; kind: MissionRecoveryAction; taskId: string | null; revisionId: string | null; payloadHash: string; status: MissionRecoveryCommandStatus; resultAttemptId: string | null; resultRevisionId: string | null; error: string | null; createdAt: string; updatedAt: string; completedAt: string | null }

export type AgentWorkspacePublicationStatus = "pending" | "publishing" | "published" | "failed" | "interrupted";
export interface AgentWorkspacePublication {
  id: string;
  missionId: string;
  agentId: string;
  designRevisionId: string;
  workspaceRevisionId: string;
  verificationRunId: string;
  expectedAgentWorkspaceHash: string;
  expectedPublishedWorkspaceHash: string;
  status: AgentWorkspacePublicationStatus;
  attemptCount: number;
  threadDisposition: "reset";
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  missions: Mission[];
  missionTasks: MissionTask[];
  taskAttempts: TaskAttempt[];
  missionArtifacts: MissionArtifact[];
  missionEvents: MissionEvent[];
  missionWorkspaceRevisions: MissionWorkspaceRevision[];
  missionRecoveryCommands: MissionRecoveryCommand[];
  designRevisions: DesignRevision[];
  verificationRuns: VerificationRun[];
  playgroundImpactAdmissions: PlaygroundImpactAdmission[];
  agentWorkspacePublications: AgentWorkspacePublication[];
}

export interface CreateAgentInput { name: string; description?: string | undefined; instructions?: string | undefined; }
export interface UpdateAgentInput { name?: string | undefined; description?: string | undefined; instructions?: string | undefined; }
export interface RunnerResult { output: string | null; threadId: string | null; usage: RunUsage | null; }
export type RunnerObservation =
  | { kind: "activity"; label: string }
  | { kind: "usage"; usage: RunUsage };
export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  accessMode?: "write" | "read_only";
  onObservation?: (observation: RunnerObservation) => void;
  missionAttempt?: {
    missionId: string;
    taskId: string;
    attemptId: string;
    stage: MissionTaskStage;
    inputDesignRevisionId: string | null;
    inputVerificationRunId: string | null;
    inputWorkspaceRevisionId: string | null;
    repairCycle: number | null;
    attemptNumber: number;
  };
}
export interface RunnerPreflightRequest { workspacePath: string; }
export type RunnerReadinessResult =
  | { ok: true }
  | {
      ok: false;
      category: "workspace_unavailable" | "runtime_unavailable" | "runtime_config_unavailable";
      message: string;
    };
export interface AgentRunner { run(request: RunnerRequest): Promise<RunnerResult>; cancel(agentId: string): Promise<boolean>; isAvailable(): Promise<boolean>; preflight?(request: RunnerPreflightRequest): Promise<RunnerReadinessResult>; }
