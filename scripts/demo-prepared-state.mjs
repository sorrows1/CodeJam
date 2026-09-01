import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { BASELINE_PROMPT } from "./demo-scenario.mjs";
import { repoDir } from "./local-poc-utils.mjs";

export const PREPARED_STATE_FORMAT = 1;
export const WORKSPACE_PATH_PLACEHOLDER = "__CONDUCTOR_REVIEWER_AGENT_WORKSPACE__";
export const preparedStatePath = path.join(repoDir, "demo", "prepared-state", "reviewer-baseline-v1.json");

const MAX_FILES = 256;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const SAFE_ROOTS = ["data/", "workspaces/"];
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials?(?:\..*)?|secrets?(?:\..*)?|[^/]*\.sqlite(?:-(?:shm|wal))?|[^/]*\.log)$/i;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portable(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function assertSafeRelative(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\") || path.posix.normalize(relativePath) !== relativePath || path.posix.isAbsolute(relativePath) || relativePath.startsWith("../")) {
    throw new Error(`Prepared-state path is invalid: ${relativePath}`);
  }
  if (!SAFE_ROOTS.some((root) => relativePath.startsWith(root))) throw new Error(`Prepared-state path is outside the allowlist: ${relativePath}`);
  if (relativePath.split("/").some((segment) => segment === ".git" || segment === "node_modules" || segment === "codex-home") || SENSITIVE_PATH.test(relativePath)) {
    throw new Error(`Prepared-state path is forbidden: ${relativePath}`);
  }
}

async function stableRead(filePath) {
  const before = await stat(filePath);
  if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error(`Prepared-state file is unsupported or too large: ${filePath}`);
  const content = await readFile(filePath);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`Prepared-state source changed while being read: ${filePath}`);
  return content;
}

async function visit(root, current, output) {
  const currentStat = await lstat(current);
  if (currentStat.isSymbolicLink()) throw new Error(`Prepared-state source must not contain symlinks: ${current}`);
  if (currentStat.isFile()) {
    const relativePath = portable(path.relative(root, current));
    assertSafeRelative(relativePath);
    output.push({ path: relativePath, content: await stableRead(current) });
    return;
  }
  if (!currentStat.isDirectory()) throw new Error(`Prepared-state source contains an unsupported entry: ${current}`);
  for (const entry of (await readdir(current)).sort()) await visit(root, path.join(current, entry), output);
}

export async function collectPreparedStateFiles(stateRoot) {
  const output = [];
  for (const area of ["data", "workspaces"]) await visit(stateRoot, path.join(stateRoot, area), output);
  if (output.length === 0 || output.length > MAX_FILES) throw new Error(`Prepared-state file count must be between 1 and ${MAX_FILES}.`);
  const totalBytes = output.reduce((sum, item) => sum + item.content.byteLength, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Prepared-state payload exceeds the total byte limit.");
  return output;
}

function requiredArray(database, key) {
  if (!Array.isArray(database?.[key])) throw new Error(`Prepared database is missing ${key}.`);
  return database[key];
}

export function validatePreparedDatabase(database, expectedWorkspacePath = WORKSPACE_PATH_PLACEHOLDER) {
  if (!database || typeof database !== "object" || database.version !== 1) throw new Error("Prepared database must use the current version 1 schema.");
  const agents = requiredArray(database, "agents");
  const messages = requiredArray(database, "messages");
  const runs = requiredArray(database, "runs");
  const missions = requiredArray(database, "missions");
  const attempts = requiredArray(database, "taskAttempts");
  const revisions = requiredArray(database, "designRevisions");
  const verifications = requiredArray(database, "verificationRuns");
  const admissions = requiredArray(database, "playgroundImpactAdmissions");
  const publications = requiredArray(database, "agentWorkspacePublications");
  if (agents.length !== 1 || messages.length !== 1 || missions.length !== 1 || admissions.length !== 1 || publications.length !== 1) throw new Error("Prepared database must contain exactly one Agent, Message, Mission, impact admission, and publication.");
  const agent = agents[0];
  const mission = missions[0];
  const admission = admissions[0];
  const publication = publications[0];
  if (agent.name !== "Demo Builder" || agent.description !== "Local Conductor demo Agent" || agent.status !== "ready" || agent.codexThreadId !== null || agent.workspacePath !== expectedWorkspacePath) throw new Error("Prepared Agent binding is invalid.");
  if (messages[0].agentId !== agent.id || messages[0].role !== "user" || messages[0].content !== BASELINE_PROMPT) throw new Error("Prepared Playground prompt is invalid.");
  if (admission.agentId !== agent.id || admission.prompt !== BASELINE_PROMPT || admission.status !== "promoted" || admission.decision !== "governed" || admission.missionId !== mission.id) throw new Error("Prepared impact admission is invalid.");
  if (mission.status !== "completed" || mission.workflow?.phase !== "completed" || !mission.participants?.some((participant) => participant.agentId === agent.id)) throw new Error("Prepared Mission is not completed for the Demo Builder.");
  const approved = revisions.find((revision) => revision.id === mission.workflow.approvedDesignRevisionId);
  const finalVerification = verifications.find((verification) => verification.id === mission.workflow.currentVerificationRunId);
  if (!approved || approved.status !== "approved" || !finalVerification || finalVerification.status !== "passed") throw new Error("Prepared Mission lacks current approved design and FINAL PASS authority.");
  if (publication.missionId !== mission.id || publication.agentId !== agent.id || publication.designRevisionId !== approved.id || publication.verificationRunId !== finalVerification.id || publication.status !== "published" || publication.threadDisposition !== "reset") throw new Error("Prepared publication binding is invalid.");
  if (!attempts.some((attempt) => attempt.missionId === mission.id && attempt.stage === "design" && attempt.status === "completed") || !attempts.some((attempt) => attempt.missionId === mission.id && attempt.stage === "implement" && attempt.status === "completed")) throw new Error("Prepared Mission lacks completed Design and Builder attempts.");
  if (!database.missionEvents?.some((event) => event.missionId === mission.id && event.type === "verification_passed" && event.details?.mode === "final")) throw new Error("Prepared Mission lacks durable FINAL verification evidence.");
  if (runs.some((run) => run.status !== "completed") || attempts.some((attempt) => attempt.status !== "completed") || verifications.some((verification) => verification.status !== "passed")) throw new Error("Prepared state contains unfinished or failing execution records.");
  return { agentId: agent.id, missionId: mission.id, designRevisionId: approved.id, verificationRunId: finalVerification.id, publicationId: publication.id };
}

function payloadDigest(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(entry.path).update("\0").update(entry.sha256).update("\0").update(String(entry.bytes)).update("\n");
  return hash.digest("hex");
}

export function encodeSnapshot({ createdAt, database, files }) {
  const sanitized = structuredClone(database);
  const bindings = validatePreparedDatabase(sanitized, sanitized.agents[0]?.workspacePath);
  sanitized.agents[0].workspacePath = WORKSPACE_PATH_PLACEHOLDER;
  for (const attempt of sanitized.taskAttempts) attempt.runtimeThreadId = null;
  validatePreparedDatabase(sanitized);
  const encoded = files.map((item) => {
    const content = item.path === "data/launchpad.json" ? Buffer.from(`${JSON.stringify(sanitized, null, 2)}\n`, "utf8") : item.content;
    return { path: item.path, bytes: content.byteLength, sha256: sha256(content), contentBase64: content.toString("base64") };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (!encoded.some((item) => item.path === "data/launchpad.json")) throw new Error("Prepared state is missing data/launchpad.json.");
  return {
    formatVersion: PREPARED_STATE_FORMAT,
    kind: "conductor-recorded-reviewer-baseline",
    createdAt,
    provenance: {
      statement: "Recorded from a baseline completed through the real Playground, governed Mission, approval, Builder, FINAL verification, and publication path. Runtime session identifiers were removed; authority bindings were preserved.",
      ...bindings,
      baselinePrompt: BASELINE_PROMPT,
    },
    payloadSha256: payloadDigest(encoded),
    files: encoded,
  };
}

export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.formatVersion !== PREPARED_STATE_FORMAT || snapshot.kind !== "conductor-recorded-reviewer-baseline" || typeof snapshot.createdAt !== "string" || !Array.isArray(snapshot.files)) throw new Error("Prepared-state snapshot header is invalid.");
  if (snapshot.files.length === 0 || snapshot.files.length > MAX_FILES) throw new Error("Prepared-state snapshot file count is invalid.");
  const seen = new Set();
  let totalBytes = 0;
  const decoded = snapshot.files.map((entry) => {
    assertSafeRelative(entry.path);
    if (seen.has(entry.path)) throw new Error(`Prepared-state snapshot repeats ${entry.path}.`);
    seen.add(entry.path);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256) || typeof entry.contentBase64 !== "string") throw new Error(`Prepared-state metadata is invalid for ${entry.path}.`);
    const content = Buffer.from(entry.contentBase64, "base64");
    if (content.toString("base64") !== entry.contentBase64 || content.byteLength !== entry.bytes || sha256(content) !== entry.sha256) throw new Error(`Prepared-state content hash is invalid for ${entry.path}.`);
    totalBytes += content.byteLength;
    return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256, content };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (totalBytes > MAX_TOTAL_BYTES || payloadDigest(decoded) !== snapshot.payloadSha256) throw new Error("Prepared-state payload digest is invalid.");
  const databaseEntry = decoded.find((entry) => entry.path === "data/launchpad.json");
  if (!databaseEntry) throw new Error("Prepared-state snapshot is missing data/launchpad.json.");
  let database;
  try { database = JSON.parse(databaseEntry.content.toString("utf8")); } catch { throw new Error("Prepared-state database JSON is invalid."); }
  const bindings = validatePreparedDatabase(database);
  for (const [key, value] of Object.entries(bindings)) if (snapshot.provenance?.[key] !== value) throw new Error(`Prepared-state provenance ${key} is invalid.`);
  if (snapshot.provenance?.baselinePrompt !== BASELINE_PROMPT) throw new Error("Prepared-state provenance prompt is invalid.");
  return { decoded, database, bindings };
}

export async function readAndValidateSnapshot() {
  const raw = await readFile(preparedStatePath, "utf8");
  const snapshot = JSON.parse(raw);
  return { snapshot, ...validateSnapshot(snapshot) };
}
