import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { buildCodexArgs } from "./codex-runner.js";
import { codexProtocolResult, consumeCodexProtocolLine, createCodexProtocolState } from "./codex-protocol.js";
import { RunCancelledError, RunnerExecutionError } from "./errors.js";
import type {
  AgentRunner,
  RunnerPreflightRequest,
  RunnerReadinessResult,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

interface ActiveContainer {
  child: ChildProcess;
  containerName: string;
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  settled: Promise<void>;
  termination: Promise<void> | null;
}

export function containerName(agentId: string, instanceId = "default"): string {
  const safeInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return "launchpad-" + safeInstance + "-" + safeAgent;
}

export function buildContainerRunArgs(
  request: RunnerRequest,
  config: AppConfig,
): string[] {
  const name = containerName(request.agentId, config.runtimeInstanceId);
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    "io.codejam.launchpad=agent-runtime",
    "--label",
    "io.codejam.agent-id=" + request.agentId,
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    "bridge",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    config.containerUser,
    "--env",
    "MODEL_API_KEY",
    "--env",
    "CODEX_HOME=/codex-home",
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    "--mount",
    "type=bind,src=" + request.workspacePath + ",dst=/workspace" + (request.accessMode === "read_only" ? ",readonly" : ""),
    "--mount",
    "type=bind,src=" + config.codexHome + ",dst=/codex-home",
    "--workdir",
    "/workspace",
    config.containerRuntimeImage,
    "codex",
    ...buildCodexArgs(request, config.codexSandboxMode, "/workspace"),
  ];
}

export function buildContainerPreflightArgs(workspacePath: string, config: AppConfig): string[] {
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  return [
    'run', '--rm', '--init',
    '--label', 'io.codejam.launchpad=runtime-preflight',
    '--label', 'io.codejam.instance-id=' + config.runtimeInstanceId,
    ...(engineName === 'podman' ? ['--userns', 'keep-id'] : []),
    '--network', 'none',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--cpus', String(config.containerCpuLimit),
    '--memory', config.containerMemoryLimit,
    '--pids-limit', String(config.containerPidsLimit),
    '--user', config.containerUser,
    '--env', 'CODEX_HOME=/codex-home',
    '--env', 'HOME=/tmp',
    '--env', 'NO_COLOR=1',
    '--mount', 'type=bind,src=' + workspacePath + ',dst=/workspace',
    '--mount', 'type=bind,src=' + config.codexHome + ',dst=/codex-home',
    '--workdir', '/workspace',
    config.containerRuntimeImage,
    'sh', '-c',
    'test -d /workspace && test -r /workspace/AGENTS.md && test -w /workspace && test -d /codex-home && test -r /codex-home/config.toml && command -v codex >/dev/null && codex --version',
  ];
}

export class ContainerCodexRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveContainer>();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.containerEngine, ["version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      await execFileAsync(
        this.config.containerEngine,
        ["image", "inspect", this.config.containerRuntimeImage],
        { timeout: 5_000, env: this.childEnvironment() },
      );
      return true;
    } catch {
      return false;
    }
  }

  async preflight(request: RunnerPreflightRequest): Promise<RunnerReadinessResult> {
    try {
      await execFileAsync(this.config.containerEngine, buildContainerPreflightArgs(request.workspacePath, this.config), {
        timeout: 15_000,
        env: this.childEnvironment(),
        maxBuffer: 16 * 1024,
      });
      return { ok: true };
    } catch (error) {
      const candidate = error as NodeJS.ErrnoException & { stderr?: string };
      if (candidate.code === 'ENOENT') return { ok: false, category: 'runtime_unavailable', message: 'Container Runtime executable is unavailable' };
      return { ok: false, category: 'runtime_config_unavailable', message: 'Mission Runtime preflight could not access the workspace, Codex configuration, or executable' };
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) return false;

    active.cancelled = true;
    await this.removeContainer(active);
    await active.settled;
    return true;
  }

  private removeContainer(active: ActiveContainer): Promise<void> {
    if (!active.termination) {
      active.termination = execFileAsync(
        this.config.containerEngine,
        ["rm", "--force", active.containerName],
        { timeout: 8_000, env: this.childEnvironment() },
      )
        .then(() => undefined)
        .catch(() => {
          active.child.kill("SIGTERM");
          const forceKill = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
          forceKill.unref();
        });
    }
    return active.termination;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Runtime container");
    }

    const child = spawn(
      this.config.containerEngine,
      buildContainerRunArgs(request, this.config),
      {
        cwd: request.workspacePath,
        env: this.childEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active: ActiveContainer = {
      child,
      containerName: containerName(request.agentId, this.config.runtimeInstanceId),
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      termination: null,
    };
    this.active.set(request.agentId, active);

    const parsed = createCodexProtocolState(request.threadId);
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        void this.removeContainer(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          const observation = consumeCodexProtocolLine(line, parsed);
          if (observation) request.onObservation?.(observation);
        }
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      void this.removeContainer(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) {
        const observation = consumeCodexProtocolLine(stdout.trim(), parsed);
        if (observation) request.onObservation?.(observation);
      }
      if (active.cancelled) throw new RunCancelledError();
      if (active.timedOut) {
        throw new RunnerExecutionError("Runtime timed out after " + this.config.codexTimeoutMs + " ms", codexProtocolResult(parsed).usage);
      }
      if (active.outputExceeded) {
        throw new RunnerExecutionError("Codex output exceeded CODEX_MAX_OUTPUT_BYTES", codexProtocolResult(parsed).usage);
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
        throw new RunnerExecutionError(
          this.config.containerEngine +
            " Runtime exited with code " +
            exitCode +
            ": " +
            detail, codexProtocolResult(parsed).usage,
        );
      }
      const result = codexProtocolResult(parsed);
      if (parsed.errors.length) throw new RunnerExecutionError(parsed.errors.at(-1)!, result.usage);
      if (parsed.recognizableEventCount === 0) throw new RunnerExecutionError("Codex completed without recognizable protocol activity", result.usage);
      return result;
    } finally {
      clearTimeout(timeout);
      this.active.delete(request.agentId);
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      MODEL_API_KEY: this.config.modelApiKey,
      NO_COLOR: "1",
    };
    for (const name of [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "XDG_RUNTIME_DIR",
    ] as const) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
