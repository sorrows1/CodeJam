import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { MissionService } from "./mission-service.js";
import { RunExecutionService } from "./run-execution.js";
import { FileDesignReferenceStore } from "./file-design-reference-store.js";
import { createVerifier } from "./verification.js";
import { ContainerRevisionPreviewRuntime } from './revision-preview-service.js';
import { PlaygroundImpactService } from './playground-impact-service.js';

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const redactionSecrets = [config.modelApiKey, config.authToken].filter((secret) => secret.length > 0);
const execution = new RunExecutionService(store, runner, redactionSecrets);
const references = new FileDesignReferenceStore(path.join(config.dataDirectory, 'design-references'));
await references.initialize();
const verifier = createVerifier({ provider: config.verifierProvider, image: config.verifierImage, engine: config.containerEngine, timeoutMs: config.codexTimeoutMs, cpuLimit: config.containerCpuLimit, memoryLimit: config.containerMemoryLimit, pidsLimit: config.containerPidsLimit });
const previewRuntime = new ContainerRevisionPreviewRuntime({ engine: config.containerEngine, image: config.verifierImage, user: config.containerUser, timeoutMs: 60_000, cpuLimit: 1, memoryLimit: '512m', pidsLimit: 64 });
const missions = new MissionService(store, workspaces, execution, references, redactionSecrets, verifier, previewRuntime);
const impact = new PlaygroundImpactService(store, workspaces, execution, missions, redactionSecrets);
const service = new AgentService(config, store, workspaces, execution, impact);
await service.initialize();
await missions.reconcileStartup();

const app = await createApp(config, service, missions);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
