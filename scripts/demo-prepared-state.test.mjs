import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readAndValidateSnapshot, validatePreparedDatabase, validateSnapshot, WORKSPACE_PATH_PLACEHOLDER } from "./demo-prepared-state.mjs";
import { repoDir } from "./local-poc-utils.mjs";

test("the committed reviewer checkpoint is bounded, hash-valid, and contains the required authority chain", async () => {
  const { snapshot, database, bindings } = await readAndValidateSnapshot();
  assert.equal(database.agents[0].workspacePath, WORKSPACE_PATH_PLACEHOLDER);
  assert.ok(database.taskAttempts.every((attempt) => attempt.runtimeThreadId === null));
  assert.equal(snapshot.provenance.agentId, bindings.agentId);
  assert.equal(snapshot.provenance.missionId, bindings.missionId);

  const tampered = structuredClone(snapshot);
  tampered.files[0].contentBase64 = `${tampered.files[0].contentBase64.slice(0, -4)}AAAA`;
  assert.throws(() => validateSnapshot(tampered), /content hash|encoding|byte/i);
});

test("the restore command produces a portable existing prompt and completed Mission without codex-home", async () => {
  const stateRoot = path.join(repoDir, ".local", `conductor-demo-state-test-${process.pid}-${Date.now()}`);
  try {
    const child = spawn(process.execPath, [path.join(repoDir, "scripts", "restore-conductor-demo-state.mjs")], {
      cwd: repoDir,
      env: { ...process.env, LOCAL_POC_DATA_ROOT: stateRoot, POC_PORT: "43999" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, stderr || stdout);
    const database = JSON.parse(await readFile(path.join(stateRoot, "data", "launchpad.json"), "utf8"));
    const bindings = validatePreparedDatabase(database, path.join(stateRoot, "workspaces", database.agents[0].id));
    const marker = JSON.parse(await readFile(path.join(stateRoot, "data", "prepared-reviewer-state.json"), "utf8"));
    assert.equal(marker.provenance.agentId, bindings.agentId);
    assert.equal(marker.provenance.missionId, bindings.missionId);
    await assert.rejects(readFile(path.join(stateRoot, "codex-home", "config.toml")), { code: "ENOENT" });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
