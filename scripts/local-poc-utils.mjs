import { spawn } from "node:child_process";
import { access, lstat, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function parseEnvFile(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) values[match[1]] = parseEnvValue(match[2]);
  }
  return values;
}

export async function loadLocalEnv() {
  const loaded = {};
  for (const filename of [".env", ".env.local"]) {
    try {
      Object.assign(loaded, parseEnvFile(await readFile(path.join(repoDir, filename), "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { ...loaded, ...process.env };
}

export function localStateRoot(environment) {
  const configured = environment.LOCAL_POC_DATA_ROOT?.trim();
  return path.resolve(repoDir, configured || path.join(".local", "conductor-live"));
}

function repoHash() {
  let hash = 2166136261;
  for (const character of repoDir) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function pocEnvironment(environment, engine, { development = false } = {}) {
  const stateRoot = localStateRoot(environment);
  const result = { ...environment };
  result.LOCAL_POC_DATA_ROOT = stateRoot;
  result.APP_DATA_DIR = path.join(stateRoot, "data");
  result.AGENT_WORKSPACE_ROOT = path.join(stateRoot, "workspaces");
  result.CODEX_HOME = path.join(stateRoot, "codex-home");
  result.HOST = result.POC_HOST?.trim() || "127.0.0.1";
  result.PORT = result.POC_PORT?.trim() || result.PORT?.trim() || "3000";
  result.NODE_ENV = development ? "development" : "production";
  result.RUNTIME_PROVIDER = "container";
  result.VERIFIER_PROVIDER = result.VERIFIER_PROVIDER?.trim() || "container";
  result.CONTAINER_ENGINE = engine;
  const configuredInstance = result.POC_RUNTIME_INSTANCE_ID?.trim() || result.RUNTIME_INSTANCE_ID?.trim();
  result.RUNTIME_INSTANCE_ID = configuredInstance && configuredInstance !== "default"
    ? configuredInstance
    : `local-${process.platform}-${repoHash()}`;
  if (!result.CONTAINER_USER?.trim()) {
    result.CONTAINER_USER = typeof process.getuid === "function" && typeof process.getgid === "function"
      ? `${process.getuid()}:${process.getgid()}`
      : "1000:1000";
  }
  return { environment: result, stateRoot };
}

export function npmCommand() {
  return process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
}

export function npmArguments(args = []) {
  return process.platform === "win32" ? ["/d", "/s", "/c", ["npm.cmd", ...args].join(" ")] : args;
}

export function commandLabel(command) {
  return path.basename(command).replace(/\.exe$/i, "");
}

export function runProcess(command, args = [], options = {}) {
  const { cwd = repoDir, env = process.env, stdio = "pipe", timeoutMs = 0, input } = options;
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill(process.platform === "win32" ? undefined : "SIGTERM");
    }, timeoutMs) : null;
    if (timer?.unref) timer.unref();
    if (input !== undefined) {
      child.stdin?.end(input);
    }
    if (child.stdout) child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    if (child.stderr) child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error, timedOut });
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, error: null, timedOut });
    });
  });
}

export async function commandAvailable(command) {
  const result = await runProcess(command, ["--version"], { timeoutMs: 5_000 });
  return result.code === 0;
}

export async function commandInfo(command, environment) {
  return runProcess(command, ["info"], { env: environment, timeoutMs: 8_000 });
}

async function maybeStartVirtualMachine(engine, environment) {
  if (engine === "docker" && process.platform !== "win32" && await commandAvailable("colima")) {
    const info = await commandInfo(engine, environment);
    if (info.code !== 0) {
      console.error("[local-poc] Docker is not reachable; starting Colima.");
      await runProcess("colima", ["start"], { env: environment, stdio: "inherit" });
    }
  }
  if (engine === "podman" && (process.platform === "darwin" || process.platform === "win32")) {
    const info = await commandInfo(engine, environment);
    if (info.code !== 0) {
      console.error("[local-poc] Podman is not reachable; starting its machine.");
      await runProcess(engine, ["machine", "start"], { env: environment, stdio: "inherit" });
    }
  }
}

export async function selectContainerEngine(environment) {
  const requested = environment.CONTAINER_ENGINE?.trim();
  const candidates = [...new Set([requested, "docker", "podman"].filter(Boolean))];
  for (const candidate of candidates) {
    if (!(await commandAvailable(candidate))) continue;
    await maybeStartVirtualMachine(candidate, environment);
    const info = await commandInfo(candidate, environment);
    if (info.code === 0) return candidate;
  }
  throw new Error("No running Docker, Colima, or Podman engine was found. Install one, start it, and rerun npm run poc.");
}

export async function imageExists(engine, image, environment) {
  const result = await runProcess(engine, ["image", "inspect", image], { env: environment, timeoutMs: 8_000 });
  return result.code === 0;
}

export async function buildImage(engine, image, dockerfile, context, environment, buildArgs = []) {
  const args = ["build", "--file", dockerfile, ...buildArgs.flatMap(([name, value]) => ["--build-arg", `${name}=${value}`]), "--tag", image, context];
  const result = await runProcess(engine, args, { cwd: repoDir, env: environment, stdio: "inherit" });
  if (result.code !== 0) throw new Error(`${commandLabel(engine)} image build failed${result.error ? `: ${result.error.message}` : ` with exit code ${result.code}`}`);
}

export async function cleanupRuntimeContainers(engine, environment) {
  const result = await runProcess(engine, ["ps", "--all", "--quiet", "--filter", "label=io.codejam.launchpad=agent-runtime", `--filter=label=io.codejam.instance-id=${environment.RUNTIME_INSTANCE_ID}`], { env: environment, timeoutMs: 8_000 });
  if (result.code !== 0) return;
  for (const id of result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    await runProcess(engine, ["rm", "--force", id], { env: environment, timeoutMs: 8_000 });
  }
}

export async function ensureDirectories(environment) {
  await Promise.all([
    mkdir(environment.APP_DATA_DIR, { recursive: true }),
    mkdir(environment.AGENT_WORKSPACE_ROOT, { recursive: true }),
    mkdir(environment.CODEX_HOME, { recursive: true }),
  ]);
}

export async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function isSymlink(target) {
  try {
    return (await lstat(target)).isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function hasSymlinkComponent(target) {
  let current = path.resolve(target);
  while (true) {
    if (await isSymlink(current)) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function samePath(left, right) {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === "win32" ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

export function isDirectChild(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.includes(path.sep);
}

export function defaultApiBaseUrl(environment) {
  return (environment.POC_BASE_URL?.trim() || `http://127.0.0.1:${environment.POC_PORT?.trim() || environment.PORT?.trim() || "3000"}`).replace(/\/$/, "");
}

export async function apiRequest(environment, pathname, options = {}) {
  const headers = { ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...(options.headers || {}) };
  if (environment.APP_AUTH_TOKEN?.trim()) headers.authorization = `Bearer ${environment.APP_AUTH_TOKEN.trim()}`;
  let response;
  try {
    response = await fetch(`${defaultApiBaseUrl(environment)}${pathname}`, { ...options, headers });
  } catch (error) {
    throw new Error(`Cannot reach the local control plane at ${defaultApiBaseUrl(environment)}. Start it with npm run poc first. ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) throw new Error(`Control plane returned ${response.status}: ${payload?.error || text || response.statusText}`);
  return payload;
}

export function formatPathForMessage(target) {
  return path.relative(repoDir, target) || ".";
}

export function hostIdentity() {
  return { platform: `${process.platform} ${process.arch}`, node: process.version, home: os.homedir() };
}
