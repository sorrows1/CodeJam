import path from "node:path";
import {
  buildImage,
  commandLabel,
  imageExists,
  loadLocalEnv,
  pocEnvironment,
  repoDir,
  runProcess,
  selectContainerEngine,
} from "./local-poc-utils.mjs";

const environment = await loadLocalEnv();
const requestedEngine = environment.CONTAINER_ENGINE?.trim();
const engine = await selectContainerEngine(environment);
const { environment: pocEnv } = pocEnvironment(environment, engine);
const image = pocEnv.VERIFIER_IMAGE?.trim() || "conductor-verifier:phase10";
const force = process.argv.includes("--rebuild");

if (!force && await imageExists(engine, image, pocEnv)) {
  console.log(`Verifier image ${image} is already available with ${commandLabel(engine)}.`);
} else {
  if (requestedEngine && requestedEngine !== engine) console.log(`Requested container engine was unavailable; using ${commandLabel(engine)}.`);
  await buildImage(engine, image, path.join(repoDir, "apps", "server", "Dockerfile.verifier"), path.join(repoDir, "apps", "server"), pocEnv);
  console.log(`Built Conductor verifier image ${image} with ${commandLabel(engine)}.`);
}

const fixture = path.join(repoDir, "apps", "server", "test-fixtures", "verification-pass");
const correlationId = "verifier-image-smoke";
const input = JSON.stringify({
  missionId: "00000000-0000-4000-8000-000000000001",
  designRevisionId: "00000000-0000-4000-8000-000000000002",
  workspaceRevisionId: "00000000-0000-4000-8000-000000000003",
  correlationId,
  workspacePath: "/workspace",
  contract: {
    schemaVersion: 1,
    viewport: { width: 800, height: 600 },
    requiredText: ["Intent complete"],
    requiredElements: [{ role: "button", name: "Reveal result" }],
    interactions: [{ id: "reveal", action: "click", target: { role: "button", name: "Reveal result" }, expected: { requiredText: ["Verified"], requiredElements: [] } }],
  },
});
const smoke = await runProcess(engine, [
  "run", "--rm", "-i", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m", "--cpus", "2", "--memory", "2g", "--pids-limit", "256",
  "--mount", `type=bind,source=${fixture},target=/workspace,readonly`, image,
], { env: pocEnv, timeoutMs: 120_000, input });
if (smoke.code !== 0) throw new Error(`Verifier image smoke test failed with exit code ${smoke.code}: ${smoke.stderr || smoke.stdout}`);
let result;
try { result = JSON.parse(smoke.stdout); }
catch { throw new Error(`Verifier image smoke test returned invalid JSON: ${smoke.stdout || smoke.stderr}`); }
if (result.correlationId !== correlationId || result.status !== "passed") throw new Error(`Verifier image smoke test did not PASS: ${JSON.stringify(result)}`);
console.log(`Verifier image ${image} passed the isolated runtime smoke test.`);
