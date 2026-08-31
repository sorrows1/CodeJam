import path from "node:path";
import { spawn } from "node:child_process";
import {
  buildImage,
  cleanupRuntimeContainers,
  commandLabel,
  ensureDirectories,
  imageExists,
  loadLocalEnv,
  npmArguments,
  npmCommand,
  pathExists,
  pocEnvironment,
  repoDir,
  runProcess,
  selectContainerEngine,
} from "./local-poc-utils.mjs";

let fatalReported = false;
const reportFatal = (error) => {
  if (fatalReported) return;
  fatalReported = true;
  console.error(`[local-poc] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
};
process.on("uncaughtException", reportFatal);
process.on("unhandledRejection", reportFatal);

const args = new Set(process.argv.slice(2));
const development = args.has("--dev") || args.has("--watch");
const rebuild = args.has("--rebuild-runtime") || args.has("--rebuild");
const skipVerifierBuild = args.has("--skip-verifier-build");

if ([...args].some((value) => value.startsWith("-") && !["--dev", "--watch", "--rebuild-runtime", "--rebuild", "--skip-verifier-build"].includes(value))) {
  console.error("Usage: npm run poc [-- --dev] [--rebuild-runtime] [--skip-verifier-build]");
  process.exit(2);
}

const loadedEnvironment = await loadLocalEnv();
if (!loadedEnvironment.MODEL_API_KEY?.trim() || !loadedEnvironment.MODEL_NAME?.trim() || loadedEnvironment.MODEL_API_KEY.trim().startsWith("replace-") || loadedEnvironment.MODEL_NAME.trim().includes("replace-")) {
  throw new Error("MODEL_API_KEY and MODEL_NAME are required. Put them in .env or .env.local, then rerun npm run poc.");
}
const engine = await selectContainerEngine(loadedEnvironment);
const { environment, stateRoot } = pocEnvironment(loadedEnvironment, engine, { development });
const runtimeImage = environment.CONTAINER_RUNTIME_IMAGE?.trim() || "volc-agent-runtime:local";
const verifierImage = environment.VERIFIER_IMAGE?.trim() || "conductor-verifier:phase10";

console.error(`[local-poc] Using ${commandLabel(engine)} as the Agent Runtime engine.`);
console.error(`[local-poc] Persistent state: ${stateRoot}`);
if (!(await pathExists(path.join(repoDir, "node_modules")))) {
  console.error("[local-poc] Installing application dependencies.");
  const install = await runProcess(npmCommand(), npmArguments(["ci"]), { cwd: repoDir, env: { ...environment, NODE_ENV: "development" }, stdio: "inherit" });
  if (install.code !== 0) process.exit(install.code ?? 1);
}
await ensureDirectories(environment);

if (rebuild || !(await imageExists(engine, runtimeImage, environment))) {
  console.error(`[local-poc] Building ${runtimeImage} from Dockerfile.runtime.`);
  await buildImage(
    engine,
    runtimeImage,
    path.join(repoDir, "Dockerfile.runtime"),
    repoDir,
    environment,
    [
      ["NODE_IMAGE", environment.CONTAINER_RUNTIME_BASE_IMAGE?.trim() || "node:22-bookworm-slim"],
      ["DEBIAN_MIRROR", environment.CONTAINER_APT_MIRROR?.trim() || ""],
      ["DEBIAN_SECURITY_MIRROR", environment.CONTAINER_APT_SECURITY_MIRROR?.trim() || ""],
      ["RUNTIME_APT_PACKAGES", environment.CONTAINER_RUNTIME_APT_PACKAGES?.trim() || "ca-certificates git ripgrep"],
    ],
  );
} else {
  console.error(`[local-poc] Reusing existing ${runtimeImage} (use --rebuild-runtime after runtime changes).`);
}

if (!skipVerifierBuild && environment.VERIFIER_PROVIDER === "container" && (rebuild || !(await imageExists(engine, verifierImage, environment)))) {
  console.error(`[local-poc] Building ${verifierImage} for independent verification.`);
  await buildImage(engine, verifierImage, path.join(repoDir, "apps", "server", "Dockerfile.verifier"), path.join(repoDir, "apps", "server"), environment);
} else if (!skipVerifierBuild && environment.VERIFIER_PROVIDER === "container") {
  console.error(`[local-poc] Reusing existing ${verifierImage}.`);
}

const preflightUserArgs = ["--user", environment.CONTAINER_USER];
if (commandLabel(engine).toLowerCase() === "podman") preflightUserArgs.push("--userns", "keep-id");
const preflight = await runProcess(engine, [
  "run", "--rm", ...preflightUserArgs,
  "--mount", `type=bind,src=${environment.AGENT_WORKSPACE_ROOT},dst=/workspace`,
  "--mount", `type=bind,src=${environment.CODEX_HOME},dst=/codex-home`,
  runtimeImage,
  "sh", "-lc", "touch /workspace/.launchpad-write-test /codex-home/.launchpad-write-test && rm /workspace/.launchpad-write-test /codex-home/.launchpad-write-test",
], { env: environment, stdio: "inherit" });
if (preflight.code !== 0) {
  throw new Error(`The container engine could not bind-mount ${stateRoot}. Try setting LOCAL_POC_DATA_ROOT in .env.local to a directory shared with Docker/Colima/Podman.`);
}

if (environment.CODEX_SANDBOX_MODE === "workspace-write") {
  const sandboxCheck = await runProcess(engine, ["run", "--rm", runtimeImage, "codex", "sandbox", "linux", "--full-auto", "--", "true"], { env: environment, timeoutMs: 20_000 });
  if (sandboxCheck.code !== 0) {
    console.error("[local-poc] Codex Landlock is unavailable; using the disposable container boundary without the inner sandbox.");
    environment.CODEX_SANDBOX_MODE = "danger-full-access";
  }
}

await cleanupRuntimeContainers(engine, environment);

if (!development) {
  console.error("[local-poc] Building the local Web and API.");
  const build = await runProcess(npmCommand(), npmArguments(["run", "build"]), { cwd: repoDir, env: environment, stdio: "inherit" });
  if (build.code !== 0) process.exit(build.code ?? 1);
}

console.error(development ? `[local-poc] Open http://localhost:5173 (watch mode).` : `[local-poc] Open http://localhost:${environment.PORT}.`);
console.error(development ? "[local-poc] Source changes reload automatically; stop with Ctrl+C." : "[local-poc] Stop with Ctrl+C. Use npm run poc -- --dev for hot reload during development.");

let stopping = false;
let serverProcess;
const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  if (serverProcess?.pid && !serverProcess.killed) {
    if (process.platform === "win32") await runProcess("taskkill", ["/pid", String(serverProcess.pid), "/t", "/f"], { stdio: "ignore", timeoutMs: 5_000 });
    else serverProcess.kill(signal);
  }
  await cleanupRuntimeContainers(engine, environment);
};
process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

const command = development ? ["run", "dev"] : ["start"];
const result = await new Promise((resolve) => {
  serverProcess = spawn(npmCommand(), npmArguments(command), {
    cwd: repoDir,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
  serverProcess.once("error", (error) => resolve({ code: 1, error }));
  serverProcess.once("close", (code) => resolve({ code: code ?? 1 }));
});
await shutdown();
if (result.code !== 0 && result.error) console.error(`[local-poc] ${result.error.message}`);
process.exit(result.code ?? 1);
