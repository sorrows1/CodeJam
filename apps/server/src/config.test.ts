import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isModelConfigured,
  loadConfig,
  resolveCodexModelCatalog,
  writeCodexConfig,
} from "./config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("configured Codex provider", () => {
  it("writes one generic provider for any configured endpoint", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-config-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: root,
      MODEL_API_KEY: "test-key",
      MODEL_NAME: "test-model",
      MODEL_BASE_URL: "https://example.com/v1",
    });

    expect(isModelConfigured(config)).toBe(true);
    await writeCodexConfig(config);
    const toml = await readFile(path.join(root, "config.toml"), "utf8");
    expect(toml).toContain('model = "test-model"');
    expect(toml).toContain('model_provider = "configured"');
    expect(toml).toContain("[model_providers.configured]");
    expect(toml).toContain('base_url = "https://example.com/v1"');
    expect(toml).toContain('env_key = "MODEL_API_KEY"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).not.toContain("model_catalog_json");
  });

  it("selects DeepSeek metadata only for its supported model and hostname", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-config-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: root,
      MODEL_API_KEY: "test-key",
      MODEL_NAME: "deepseek-v4-flash",
      MODEL_BASE_URL: "https://api.deepseek.com",
    });

    expect(resolveCodexModelCatalog(config.modelBaseUrl, config.modelName)).toBe(
      "deepseek-model-catalog.json",
    );
    await writeCodexConfig(config);
    const toml = await readFile(path.join(root, "config.toml"), "utf8");
    expect(toml).toContain('model_provider = "configured"');
    expect(toml).toContain("model_catalog_json");
    expect(
      JSON.parse(await readFile(path.join(root, "deepseek-model-catalog.json"), "utf8")),
    ).toMatchObject({ models: [{ slug: "deepseek-v4-flash", minimal_client_version: "0.144.0" }] });
  });

  it("writes the DeepSeek catalog path as the mounted container path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-config-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: root,
      RUNTIME_PROVIDER: "container",
      MODEL_API_KEY: "test-key",
      MODEL_NAME: "deepseek-v4-flash",
      MODEL_BASE_URL: "https://api.deepseek.com",
    });

    await writeCodexConfig(config);
    const toml = await readFile(path.join(root, "config.toml"), "utf8");
    expect(toml).toContain('model_catalog_json = "/codex-home/deepseek-model-catalog.json"');
    expect(toml).not.toContain(root.replaceAll("\\", "\\\\"));
  });

  it("does not select DeepSeek metadata for ModelArk", () => {
    expect(
      resolveCodexModelCatalog(
        "https://ark.cn-beijing.volces.com/api/v3",
        "ep-test",
      ),
    ).toBeNull();
  });
});
