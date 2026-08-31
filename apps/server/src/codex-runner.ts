import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import {
  codexProtocolResult,
  consumeCodexProtocolLine,
  createCodexProtocolState,
} from "./codex-protocol.js";
import { RunCancelledError, RunnerExecutionError } from "./errors.js";
import type {
  AgentRunner,
  RunnerPreflightRequest,
  RunnerReadinessResult,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
): string[] {
  const effectiveSandboxMode = request.accessMode === "read_only" ? "read-only" : sandboxMode;
  const args = [
    "exec",
    "--json",
    "--sandbox",
    effectiveSandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async preflight(request: RunnerPreflightRequest): Promise<RunnerReadinessResult> {
    try {
      if (!(await stat(request.workspacePath)).isDirectory()) throw new Error('not a directory');
      await access(path.join(request.workspacePath, 'AGENTS.md'), constants.R_OK);
      if (!(await stat(this.config.codexHome)).isDirectory()) throw new Error('CODEX_HOME is not a directory');
      await access(path.join(this.config.codexHome, 'config.toml'), constants.R_OK);
    } catch (error) {
      const configPath = path.join(this.config.codexHome, 'config.toml');
      const configMissing = await access(configPath, constants.R_OK).then(() => false).catch(() => true);
      return configMissing
        ? { ok: false, category: 'runtime_config_unavailable', message: 'Codex Runtime configuration is unavailable' }
        : { ok: false, category: 'workspace_unavailable', message: 'Mission workspace or AGENTS.md is unavailable' };
    }
    try {
      await execFileAsync(this.config.codexBin, ['--version'], { timeout: 5_000, env: this.childEnvironment() });
      return { ok: true };
    } catch {
      return { ok: false, category: 'runtime_unavailable', message: 'Codex executable is unavailable' };
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Codex process");
    }

    const args = buildCodexArgs(request, this.config.codexSandboxMode);
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: this.childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
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
        this.terminate(active);
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
        if (stderr.length > 16_384) {
          stderr = stderr.slice(-16_384);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
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
      if (active.cancelled) {
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        throw new RunnerExecutionError("Codex timed out after " + this.config.codexTimeoutMs + " ms", codexProtocolResult(parsed).usage);
      }
      if (active.outputExceeded) {
        throw new RunnerExecutionError("Codex output exceeded CODEX_MAX_OUTPUT_BYTES", codexProtocolResult(parsed).usage);
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
        throw new RunnerExecutionError("Codex exited with code " + exitCode + ": " + detail, codexProtocolResult(parsed).usage);
      }
      const result = codexProtocolResult(parsed);
      if (parsed.errors.length) throw new RunnerExecutionError(parsed.errors.at(-1)!, result.usage);
      if (parsed.recognizableEventCount === 0) throw new RunnerExecutionError("Codex completed without recognizable protocol activity", result.usage);
      return result;
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: this.config.codexHome,
      MODEL_API_KEY: this.config.modelApiKey,
      NO_COLOR: "1",
    };
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
