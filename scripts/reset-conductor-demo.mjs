import { lstat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hasSymlinkComponent, loadLocalEnv, localStateRoot, repoDir, samePath } from "./local-poc-utils.mjs";

function isWithin(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function safeResetRoot(target, defaultRoot) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const home = os.homedir();
  const allowedDefault = samePath(resolved, defaultRoot);
  const nameAllowed = /^(?:conductor-demo|conductor-live)(?:-[^\\/]*)?$/i.test(path.basename(resolved));
  if (samePath(resolved, root) || samePath(resolved, repoDir) || samePath(resolved, home) || (isWithin(resolved, repoDir) && !allowedDefault) || (!allowedDefault && !nameAllowed)) {
    throw new Error("Refusing reset: use the default .local/conductor-live root or a dedicated conductor-demo/conductor-live directory.");
  }
  if (await hasSymlinkComponent(resolved)) throw new Error("Refusing reset: the demo root or one of its parent directories is symlinked.");
  try {
    if (!(await lstat(resolved)).isDirectory()) throw new Error("Refusing reset: the demo root must be a directory.");
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log(`Nothing to reset; ${resolved} does not exist.`);
      return;
    }
    throw error;
  }

  for (const item of ["data", "workspaces", "codex-home"]) {
    const targetPath = path.join(resolved, item);
    try {
      if ((await lstat(targetPath)).isSymbolicLink()) throw new Error(`Refusing reset: ${targetPath} is symlinked.`);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  for (const item of ["data", "workspaces", "codex-home"]) {
    const targetPath = path.join(resolved, item);
    await rm(targetPath, { recursive: true, force: true });
  }
  console.log(`Reset Conductor demo state under ${resolved} (data, workspaces, codex-home).`);
  console.log("The demo-root directory and unrelated files were preserved.");
}

const argv = process.argv.slice(2);
if (argv.length > 1) {
  console.error("Usage: npm run demo:reset [-- [demo-root]]");
  process.exit(2);
}

try {
  const environment = await loadLocalEnv();
  const defaultRoot = localStateRoot(environment);
  await safeResetRoot(argv[0] || defaultRoot, defaultRoot);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
