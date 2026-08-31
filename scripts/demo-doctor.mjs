import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { chromium } from "playwright";
import {
  apiRequest,
  commandAvailable,
  commandInfo,
  defaultApiBaseUrl,
  hasSymlinkComponent,
  imageExists,
  isDirectChild,
  isUuid,
  loadLocalEnv,
  localStateRoot,
  npmArguments,
  npmCommand,
  pathExists,
  repoDir,
  runProcess,
  samePath,
} from "./local-poc-utils.mjs";
import { BASELINE_PROMPT } from "./demo-scenario.mjs";

const environment = await loadLocalEnv();
const stateRoot = localStateRoot(environment);
const required = [];
let failures = 0;

function report(label, ok, detail) {
  console.log(`${ok ? "OK" : "!!"} ${label}: ${detail}`);
  if (!ok) failures += 1;
}

async function versionOf(command, args = ["--version"]) {
  const result = await runProcess(command, args, { timeoutMs: 5_000 });
  return result.code === 0 ? result.stdout.trim().split(/\r?\n/).at(-1) : null;
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
report("Node.js", nodeMajor >= 22, `${process.version}${nodeMajor >= 22 ? "" : " (Node.js 22+ required)"}`);
const npmVersion = await versionOf(npmCommand(), npmArguments(["--version"]));
report("npm", Boolean(npmVersion), npmVersion || "npm was not found");

const modelKey = environment.MODEL_API_KEY?.trim() || "";
const modelName = environment.MODEL_NAME?.trim() || "";
const keyOk = modelKey.length > 0 && !modelKey.startsWith("replace-");
const modelOk = modelName.length > 0 && !modelName.includes("replace-");
report("Model API key", keyOk, keyOk ? "configured (value hidden)" : "missing or still a placeholder");
report("Model name", modelOk, modelOk ? "configured" : "missing or still a placeholder");

const requestedEngine = environment.CONTAINER_ENGINE?.trim() || "docker";
const engineCandidates = [...new Set([requestedEngine, "docker", "podman"])];
let selectedEngine = null;
for (const candidate of engineCandidates) {
  if (!(await commandAvailable(candidate))) continue;
  const info = await commandInfo(candidate, environment);
  if (info.code === 0) { selectedEngine = candidate; break; }
}
report("Container engine", Boolean(selectedEngine), selectedEngine || `no running ${requestedEngine}, Docker, or Podman engine found`);

if (selectedEngine) {
  const runtimeImage = environment.CONTAINER_RUNTIME_IMAGE?.trim() || "volc-agent-runtime:local";
  const verifierImage = environment.VERIFIER_IMAGE?.trim() || "conductor-verifier:phase10";
  report("Agent Runtime image", await imageExists(selectedEngine, runtimeImage, environment), runtimeImage);
  if ((environment.VERIFIER_PROVIDER?.trim() || "container") === "container") {
    report("Verifier image", await imageExists(selectedEngine, verifierImage, environment), verifierImage);
  } else {
    report("Verifier image", true, "not required for VERIFIER_PROVIDER=local-process");
  }
} else {
  report("Agent Runtime image", false, "cannot inspect without a running container engine");
  if ((environment.VERIFIER_PROVIDER?.trim() || "container") === "container") report("Verifier image", false, "cannot inspect without a running container engine");
}

let chromiumPath = "";
try { chromiumPath = chromium.executablePath(); } catch { /* handled by report */ }
report("Chromium", Boolean(chromiumPath && await pathExists(chromiumPath)), chromiumPath || "run npm run demo:setup");

for (const directory of [stateRoot, path.join(stateRoot, "data"), path.join(stateRoot, "workspaces"), path.join(stateRoot, "codex-home")]) {
  report(`Path ${path.relative(repoDir, directory) || "."}`, path.isAbsolute(directory) && !samePath(directory, path.parse(directory).root), directory);
}
const resetRootSafe = !samePath(stateRoot, repoDir) && !samePath(stateRoot, path.parse(stateRoot).root) && !samePath(stateRoot, os.homedir()) && !(await hasSymlinkComponent(stateRoot));
report("Reset root", resetRootSafe, resetRootSafe ? "eligible for the bounded demo reset" : "refused because it is broad or symlinked");

for (const item of ["package.json", "index.html", "src", "README.md"]) required.push(path.join(repoDir, "demo", "intent-verification", item));
required.push(path.join(repoDir, "Dockerfile.runtime"), path.join(repoDir, "apps", "server", "Dockerfile.verifier"));
for (const item of required) report(`Required file ${path.relative(repoDir, item)}`, await pathExists(item), await pathExists(item) ? "present" : "missing");

const apiUrl = defaultApiBaseUrl(environment);
let serverHealthy = false;
try { serverHealthy = (await fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { /* probe below */ }
if (serverHealthy) {
  report("POC port", true, `${apiUrl} is healthy`);
  try {
    const agentsResult = await apiRequest(environment, "/api/agents");
    const agents = Array.isArray(agentsResult?.agents) ? agentsResult.agents : [];
    const matches = agents.filter((agent) => agent.name === "Demo Builder" && agent.description === "Local Conductor demo Agent");
    const agent = matches.length === 1 && agents.length === 1 ? matches[0] : null;
    report("Prepared Agent", Boolean(agent), agent ? `exactly one Demo Builder (${agent.id})` : `expected exactly one Demo Builder; found ${matches.length} matching and ${agents.length} total Agent(s)`);
    if (agent) {
      report("Prepared Agent lifecycle", agent.status === "ready" && agent.codexThreadId === null, agent.status === "ready" && agent.codexThreadId === null ? "ready with fresh Runtime context" : `${agent.status}; stale Runtime context ${agent.codexThreadId ? "present" : "absent"}`);
      const workspaceRoot = path.join(stateRoot, "workspaces");
      const workspace = path.resolve(agent.workspacePath);
      const workspaceSafe = isUuid(agent.id) && isDirectChild(workspace, workspaceRoot) && path.basename(workspace).toLowerCase() === agent.id.toLowerCase() && await pathExists(workspace) && !(await hasSymlinkComponent(workspace));
      report("Prepared Agent workspace", workspaceSafe, workspaceSafe ? path.relative(repoDir, workspace) : "outside the safe UUID-named local workspace root");
      const [runsResult, messagesResult, admissionsResult, missionsResult] = await Promise.all([
        apiRequest(environment, `/api/agents/${agent.id}/runs`),
        apiRequest(environment, `/api/agents/${agent.id}/messages`),
        apiRequest(environment, `/api/agents/${agent.id}/impact-admissions`),
        apiRequest(environment, "/api/missions"),
      ]);
      const runs = runsResult.runs ?? [];
      const messages = messagesResult.messages ?? [];
      const admissions = admissionsResult.admissions ?? [];
      const relatedMissions = (missionsResult.missions ?? []).filter((mission) => mission.participants?.some((participant) => participant.agentId === agent.id));
      const baselineAdmission = admissions.find((item) => item.prompt === BASELINE_PROMPT && item.status === "promoted" && item.missionId);
      const baselineMission = baselineAdmission ? relatedMissions.find((item) => item.id === baselineAdmission.missionId) : null;
      const baselineDetail = baselineMission ? await apiRequest(environment, `/api/missions/${baselineMission.id}`) : null;
      const realBaselineReady = runs.length === 0
        && messages.some((item) => item.role === "user" && item.content === BASELINE_PROMPT)
        && admissions.length === 1
        && relatedMissions.length === 1
        && baselineMission?.status === "completed"
        && baselineDetail?.publication?.status === "published"
        && baselineDetail?.attempts?.some((item) => item.stage === "design" && item.status === "completed")
        && baselineDetail?.attempts?.some((item) => item.stage === "implement" && item.status === "completed")
        && baselineDetail?.events?.some((item) => item.type === "verification_passed" && item.details?.mode === "final");
      report("Prepared history", Boolean(realBaselineReady), realBaselineReady ? `one real Playground prompt -> completed Mission ${baselineMission.id} -> FINAL PASS -> published workspace` : "complete the documented one-time baseline Playground Mission before recording");
      let sourceText = "";
      try {
        const sourceRoot = path.join(workspace, "src");
        for (const entry of await readdir(sourceRoot, { withFileTypes: true })) if (entry.isFile() && /\.(?:js|jsx|ts|tsx|css|html)$/.test(entry.name)) sourceText += await readFile(path.join(sourceRoot, entry.name), "utf8");
      } catch { /* reported below */ }
      const baselineReady = ["Dashboard", "Agents", "Settings", "Reveal result"].every((marker) => sourceText.includes(marker)) && !/Agent Activity|Filter by status/.test(sourceText);
      report("Prepared baseline app", baselineReady, baselineReady ? "published Agent Operations dashboard is present; Activity is not pre-seeded" : "published baseline markers are missing or the live Activity feature is already present");
    }
  } catch (error) {
    report("Prepared demo state", false, error instanceof Error ? error.message : String(error));
  }
} else {
  const port = Number(environment.POC_PORT?.trim() || environment.PORT?.trim() || 3000);
  const available = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
  report("POC port", available, available ? `${apiUrl} is available` : `${apiUrl} is busy and not serving the POC`);
}

if (failures) {
  console.error(`\nDoctor found ${failures} issue(s). It made no changes and did not start a process or spend model budget.`);
  process.exit(1);
}
console.log("\nDoctor found no blocking issues. It made no changes and did not spend model budget.");
