import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import deepseekModelCatalog from "./deepseek-model-catalog.json" with { type: "json" };

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  VERIFIER_PROVIDER: z.enum(["local-process", "container"]).default("container"),
  VERIFIER_IMAGE: z.string().min(1).default("conductor-verifier:phase10"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  MODEL_API_KEY: z.string().optional(),
  MODEL_NAME: z.string().optional(),
  MODEL_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    verifierProvider: env.VERIFIER_PROVIDER,
    verifierImage: env.VERIFIER_IMAGE,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    modelApiKey: env.MODEL_API_KEY?.trim() ?? "",
    modelName: env.MODEL_NAME?.trim() ?? "",
    modelBaseUrl: env.MODEL_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
  };
}

export function isModelConfigured(config: AppConfig): boolean {
  return (
    config.modelApiKey.length > 0 &&
    !config.modelApiKey.startsWith("replace-") &&
    config.modelName.length > 0 &&
    !config.modelName.includes("replace-")
  );
}

export function resolveCodexModelCatalog(
  baseUrl: string,
  modelName: string,
): string | null {
  try {
    const endpoint = new URL(baseUrl);
    if (
      endpoint.hostname.toLowerCase() === "api.deepseek.com" &&
      modelName === "deepseek-v4-flash"
    ) {
      return "deepseek-model-catalog.json";
    }
  } catch {
    return null;
  }
  return null;
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const catalogName = resolveCodexModelCatalog(
    config.modelBaseUrl,
    config.modelName,
  );
  const catalogPath = catalogName
    ? path.join(config.codexHome, catalogName)
    : null;
  const catalogConfigPath = catalogName
    ? config.runtimeProvider === "container"
      ? path.posix.join("/codex-home", catalogName)
      : catalogPath
    : null;
  if (catalogPath) {
    await writeFile(catalogPath, JSON.stringify(deepseekModelCatalog, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.modelName || "model-not-configured"),
    'model_provider = "configured"',
    ...(catalogConfigPath ? ["model_catalog_json = " + JSON.stringify(catalogConfigPath)] : []),
    "",
    "[model_providers.configured]",
    'name = "Configured Provider"',
    "base_url = " + JSON.stringify(config.modelBaseUrl),
    'env_key = "MODEL_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
