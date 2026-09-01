import { lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readAndValidateSnapshot, validatePreparedDatabase, WORKSPACE_PATH_PLACEHOLDER } from "./demo-prepared-state.mjs";
import { defaultApiBaseUrl, hasSymlinkComponent, loadLocalEnv, localStateRoot, repoDir, samePath } from "./local-poc-utils.mjs";

function isWithin(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertSafeTarget(target) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const defaultRoot = path.join(repoDir, ".local", "conductor-live");
  const localRoot = path.join(repoDir, ".local");
  const allowedDefault = samePath(resolved, defaultRoot);
  const nameAllowed = /^(?:conductor-demo|conductor-live)(?:-[^\\/]*)?$/i.test(path.basename(resolved));
  const dedicatedLocalRoot = samePath(path.dirname(resolved), localRoot) && nameAllowed;
  const dedicatedExternalRoot = !isWithin(resolved, repoDir) && nameAllowed;
  if (samePath(resolved, root) || samePath(resolved, repoDir) || samePath(resolved, os.homedir()) || (!allowedDefault && !dedicatedLocalRoot && !dedicatedExternalRoot)) throw new Error("Refusing restore: use the default .local/conductor-live root or a dedicated conductor-demo/conductor-live directory.");
  if (await hasSymlinkComponent(resolved)) throw new Error("Refusing restore: the demo root or one of its parent directories is symlinked.");
  return resolved;
}

async function assertPocStopped(environment) {
  try {
    const response = await fetch(`${defaultApiBaseUrl(environment)}/api/health`, { signal: AbortSignal.timeout(750) });
    if (response.ok) throw new Error("Stop the POC before restoring the reviewer checkpoint.");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Stop the POC")) throw error;
  }
}

async function assertEmptyTarget(stateRoot) {
  await mkdir(stateRoot, { recursive: true });
  for (const name of ["data", "workspaces", "codex-home"]) {
    const target = path.join(stateRoot, name);
    try {
      const targetStat = await lstat(target);
      if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) throw new Error(`Refusing restore: ${target} is not a normal directory.`);
      if ((await readdir(target)).length > 0) throw new Error(`Refusing restore: ${target} is not empty. Stop the POC and run npm run demo:reset first.`);
      await rmdir(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function renameWithRetry(source, destination) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES'].includes(error?.code) || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

const environment = await loadLocalEnv();
const stateRoot = await assertSafeTarget(localStateRoot(environment));
await assertPocStopped(environment);
await assertEmptyTarget(stateRoot);
const { snapshot, decoded, database, bindings } = await readAndValidateSnapshot();
const restoredWorkspacePath = path.join(stateRoot, "workspaces", bindings.agentId);
if (database.agents[0].workspacePath !== WORKSPACE_PATH_PLACEHOLDER) throw new Error("Prepared-state workspace placeholder is missing.");
database.agents[0].workspacePath = restoredWorkspacePath;
validatePreparedDatabase(database, restoredWorkspacePath);

const stagingRoot = await mkdtemp(path.join(stateRoot, `.restore-${randomUUID()}-`));
const installed = [];
try {
  for (const entry of decoded) {
    const destination = path.join(stagingRoot, ...entry.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    const content = entry.path === "data/launchpad.json" ? Buffer.from(`${JSON.stringify(database, null, 2)}\n`, "utf8") : entry.content;
    await writeFile(destination, content);
  }
  await writeFile(path.join(stagingRoot, "data", "prepared-reviewer-state.json"), `${JSON.stringify({ formatVersion: snapshot.formatVersion, kind: snapshot.kind, payloadSha256: snapshot.payloadSha256, importedAt: new Date().toISOString(), provenance: snapshot.provenance }, null, 2)}\n`, "utf8");
  for (const area of ["data", "workspaces"]) {
    const destination = path.join(stateRoot, area);
    await renameWithRetry(path.join(stagingRoot, area), destination);
    installed.push(destination);
  }
} catch (error) {
  for (const destination of installed.reverse()) await rm(destination, { recursive: true, force: true });
  throw error;
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

console.log(`Restored recorded reviewer checkpoint ${snapshot.payloadSha256.slice(0, 12)} into ${stateRoot}.`);
console.log(`Prepared Agent: ${bindings.agentId}; existing Mission: ${bindings.missionId}.`);
console.log("Start the POC, run npm run demo:doctor, then begin with the live Activity prompt.");
