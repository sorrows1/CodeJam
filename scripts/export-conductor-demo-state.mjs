import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectPreparedStateFiles, encodeSnapshot, preparedStatePath, validateSnapshot } from "./demo-prepared-state.mjs";
import { defaultApiBaseUrl, loadLocalEnv, localStateRoot } from "./local-poc-utils.mjs";

const environment = await loadLocalEnv();
const stateRoot = localStateRoot(environment);

async function assertPocStopped() {
  try {
    const response = await fetch(`${defaultApiBaseUrl(environment)}/api/health`, { signal: AbortSignal.timeout(750) });
    if (response.ok) throw new Error("Stop the POC before exporting prepared state so the snapshot cannot race with live writes.");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Stop the POC")) throw error;
  }
}

function assertSensitiveValuesAbsent(decodedFiles) {
  const sensitiveValues = [];
  for (const name of ["MODEL_API_KEY", "APP_AUTH_TOKEN"]) {
    const value = environment[name]?.trim();
    if (value && !value.startsWith("replace-") && value.length >= 8) sensitiveValues.push({ name, value: Buffer.from(value, "utf8") });
  }
  for (const file of decodedFiles) {
    for (const secret of sensitiveValues) {
      if (file.content.includes(secret.value)) throw new Error(`Refusing export: ${secret.name} appears in ${file.path}.`);
    }
    if (file.content.includes(0)) continue;
    const text = file.content.toString("utf8");
    if (/[A-Za-z]:\\(?:Users|Documents)\\/i.test(text) || /\/(?:Users|home)\/[^/\s]+\//.test(text)) throw new Error(`Refusing export: a host user path remains in ${file.path}.`);
    if (/(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(text)) throw new Error(`Refusing export: credential-shaped content remains in ${file.path}.`);
  }
}

await assertPocStopped();
const files = await collectPreparedStateFiles(stateRoot);
if (files.some((item) => item.path === "data/prepared-reviewer-state.json")) throw new Error("Refusing export: this state was restored from a recorded checkpoint. Recreate the baseline through the real Playground/Mission path before exporting.");
const databaseFile = files.find((item) => item.path === "data/launchpad.json");
if (!databaseFile) throw new Error("The prepared local state has no launchpad database.");
const database = JSON.parse(databaseFile.content.toString("utf8"));
const snapshot = encodeSnapshot({ createdAt: new Date().toISOString(), database, files });
const validated = validateSnapshot(snapshot);
assertSensitiveValuesAbsent(validated.decoded);
const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
await mkdir(path.dirname(preparedStatePath), { recursive: true });
await writeFile(preparedStatePath, serialized, "utf8");
console.log(`Exported the recorded reviewer baseline to ${path.relative(process.cwd(), preparedStatePath)}.`);
console.log(`Files: ${snapshot.files.length}; payload SHA-256: ${snapshot.payloadSha256}`);
console.log("Excluded: codex-home, credentials, sessions, logs, memories, installation identity, and Runtime thread identifiers.");
