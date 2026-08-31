import { copyFile, mkdir, readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import {
  apiRequest,
  formatPathForMessage,
  isDirectChild,
  isSymlink,
  isUuid,
  loadLocalEnv,
  localStateRoot,
  pathExists,
  repoDir,
} from "./local-poc-utils.mjs";

const fixtureDir = path.join(repoDir, "demo", "intent-verification");
const fixtureItems = ["package.json", "index.html", "src", "README.md"];
const demoAgent = { name: "Demo Builder", description: "Local Conductor demo Agent" };

function selectedAgentId(argv) {
  const index = argv.indexOf("--agent");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || !isUuid(value)) throw new Error("--agent must be followed by a valid Agent UUID.");
  return value;
}

async function assertNoSymlinks(target) {
  if (await isSymlink(target)) throw new Error(`Refusing seed: ${target} is symlinked.`);
  const stat = await lstat(target);
  if (!stat.isDirectory()) return;
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing seed: ${child} is symlinked.`);
    if (entry.isDirectory()) await assertNoSymlinks(child);
  }
}

async function copyTree(source, destination) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Refusing seed: ${source} is symlinked.`);
  if (stat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) await copyTree(path.join(source, entry), path.join(destination, entry));
  } else {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

async function chooseAgent(environment, requestedId) {
  const listed = await apiRequest(environment, "/api/agents");
  const agents = Array.isArray(listed?.agents) ? listed.agents : [];
  if (requestedId) {
    const agent = agents.find((item) => item.id === requestedId);
    if (!agent) throw new Error(`Agent ${requestedId} was not found.`);
    return { agent, reused: true };
  }
  const matches = agents.filter((item) => item.name === demoAgent.name && item.description === demoAgent.description);
  if (matches.length > 1) throw new Error("Multiple prepared Demo Builder Agents exist. Run npm run demo:reset before preparing the recording baseline again.");
  if (matches.length === 1) {
    const agent = matches[0];
    if (agent.status !== "ready") throw new Error("The prepared Demo Builder Agent is not ready. Stop active work or run npm run demo:reset before seeding.");
    const [runsResult, messagesResult, admissionsResult, missionsResult] = await Promise.all([
      apiRequest(environment, `/api/agents/${agent.id}/runs`),
      apiRequest(environment, `/api/agents/${agent.id}/messages`),
      apiRequest(environment, `/api/agents/${agent.id}/impact-admissions`),
      apiRequest(environment, "/api/missions"),
    ]);
    const hasHistory = (runsResult.runs?.length ?? 0) > 0
      || (messagesResult.messages?.length ?? 0) > 0
      || (admissionsResult.admissions?.length ?? 0) > 0
      || (missionsResult.missions ?? []).some((mission) => mission.participants?.some((participant) => participant.agentId === agent.id));
    if (hasHistory) throw new Error("The prepared Demo Builder Agent has execution history. Run npm run demo:reset instead of overwriting authoritative demo state.");
    return { agent, reused: true };
  }
  const created = await apiRequest(environment, "/api/agents", {
    method: "POST",
    body: JSON.stringify(demoAgent),
  });
  return { agent: created.agent, reused: false };
}

const argv = process.argv.slice(2);
if (argv.length > 2 || (argv.length > 0 && argv[0] !== "--agent") || (argv.length === 2 && !isUuid(argv[1]))) {
  console.error("Usage: npm run demo:seed [-- --agent <agent-uuid>]");
  process.exit(2);
}

try {
  const environment = await loadLocalEnv();
  const selected = await chooseAgent(environment, selectedAgentId(argv));
  const agent = selected.agent;
  if (!isUuid(agent.id)) throw new Error("The control plane returned an invalid Agent ID.");
  const workspaceRoot = path.join(localStateRoot(environment), "workspaces");
  const destination = path.resolve(agent.workspacePath);
  if (!isDirectChild(destination, workspaceRoot) || path.basename(destination).toLowerCase() !== agent.id.toLowerCase()) {
    throw new Error("Refusing seed: the Agent workspace is outside the configured local POC workspace root.");
  }
  if (!(await pathExists(destination)) || await isSymlink(destination)) throw new Error("Refusing seed: the Agent workspace does not exist or is symlinked.");
  const instructionsPath = path.join(destination, "AGENTS.md");
  if (!(await pathExists(instructionsPath)) || await isSymlink(instructionsPath) || !(await readFile(instructionsPath, "utf8")).includes("Platform-managed Agent instructions")) {
    throw new Error("Refusing seed: platform-managed AGENTS.md was not found.");
  }
  await assertNoSymlinks(fixtureDir);
  for (const item of fixtureItems) {
    const source = path.join(fixtureDir, item);
    const target = path.join(destination, item);
    if (!(await pathExists(source)) || await isSymlink(source)) throw new Error(`Refusing seed: fixture path ${item} is missing or symlinked.`);
    if (await isSymlink(target)) throw new Error(`Refusing seed: fixture target ${item} is symlinked.`);
    if (await pathExists(target)) await assertNoSymlinks(target);
    await copyTree(source, target);
  }
  console.log(`Seeded the intent-verification fixture into Agent "${agent.name}" (${agent.id}).`);
  if (selected.reused) console.log("Reused the existing clean prepared Agent; no duplicate Agent was created.");
  console.log(`Workspace: ${formatPathForMessage(destination)}`);
  console.log("No UUID or LOCAL_POC_DATA_ROOT value is required; both were resolved automatically.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
