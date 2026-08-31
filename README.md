# Conductor

Conductor is intent-governance middleware for autonomous coding Agents:

> Agents can write correct code and still build the wrong product. Conductor makes approved intent enforceable.

The Starter Kit remains the ordinary Agent platform. Conductor adds a server-side decision and adoption boundary around work that may change the user-facing product:

```text
Playground request
-> impact evidence
   -> proven nonvisual: publish normally
   -> frontend / ambiguous: protected Mission
-> review exact design + requirements
-> approve
-> Builder
-> independent real-app checks
-> review built result
-> separate final PASS
-> verified publication back to the Agent
```

A Builder success is deliberately not completion. The coding Agent can produce the implementation, but it cannot approve its own interpretation or certify its own result for publication.

## Quick start

Requirements: Node.js 22+, npm 10+, Docker Desktop/Colima/Podman, and an OpenAI Responses-compatible model endpoint for live Agent Runs. The POC launcher is Node-based and works from PowerShell, Command Prompt, macOS/Linux shells, and Git Bash.

```bash
npm ci
```

Before the first run, copy `.env.example` to `.env`, replace the demo access-token placeholder with a unique URL-safe value of at least 24 characters, and fill in the model values:

```text
APP_AUTH_TOKEN
MODEL_API_KEY
MODEL_NAME
MODEL_BASE_URL
```

`npm run poc` loads that file automatically, uses `.local/conductor-live` for its state, selects a running Docker/Podman engine, installs dependencies when needed, and builds/reuses the local images.

Install the browser used by deterministic verification once for a new checkout:

```bash
npm run demo:setup
```

For every clean recording rehearsal, stop any running POC, reset the bounded
local demo state, and then start the production-style POC:

```bash
npm run demo:reset
npm run poc
```

Open <http://localhost:3000>. In a second terminal, prepare the supported demo state:

```bash
npm run demo:seed
```

For a new reset, complete the one-time real baseline Playground Mission shown
in [docs/DEMO.md](docs/DEMO.md). Then rerun the seed and validation commands:

```bash
npm run demo:seed
npm run demo:doctor
npm run demo:verify
```

The first seed creates the source Agent/app. The second seed recognizes and
preserves the exact completed baseline Mission instead of overwriting it. No
UUID copying, automated human approval, or manual JsonStore authority
fabrication is part of the demo flow.

To choose an Agent explicitly:

```text
npm run demo:seed -- --agent <agent-uuid>
```

On Linux, if Playwright system dependencies are missing, use `npx playwright install --with-deps chromium`.

The model API key is supplied only through the server/runtime environment. Never put it in source, browser storage, Mission data, logs, or screenshots.

For active development, use `npm run poc -- --dev`. Use `npm run poc` for the stable production-style rehearsal and recording.

For the exact three-minute scenario, see [docs/DEMO.md](docs/DEMO.md). For fresh state, use [FRESH_STATE_RESET.md](FRESH_STATE_RESET.md). If setup is unclear, run `npm run demo:doctor`; it performs read-only checks and never prints the model API key, starts a Mission, or resets state.

## Three-minute proof

The recording uses **one complete scenario**:

1. select one ready Agent and briefly show its already-built real application;
2. submit one ambiguous product request through Playground;
3. show a real Agent/model/file/tool/Runtime action and Conductor's impact evidence;
4. show the request enter a protected Mission because its real impact is user-facing or ambiguous;
5. review and approve the exact proposed design plus acceptance requirements;
6. run the Builder and visibly show that **Builder success is still not completion**;
7. run independent checks against the actual captured application;
8. review the built result, then show the separate final PASS authorize publication;
9. return to the same application and demonstrate the newly published feature;
10. show the Agent/platform ready and controllable afterward.

The recommended demo task is:

> **Give users a way to review recent agent activity and quickly filter it by status.**

It intentionally does not say `frontend`, `React`, `UI`, `CSS`, `page`, or `component`; the demo proves that Conductor governs the actual work rather than relying only on prompt keywords.

The deterministic browser proof can be run without another model call:

```bash
npm run demo:verify
```

It supplements the live Agent scenario; it does not replace the required real Agent Run.

## What Conductor governs

### Playground impact

Playground first plans impact without authoritative source writes. If execution is needed to resolve impact, Conductor uses an isolated candidate workspace. The complete actual diff is the final evidence:

- proven nonvisual work can publish transactionally through the ordinary Playground path;
- frontend-affecting or ambiguous work is prevented from silently publishing and is promoted into the protected Mission path.

### Exact design approval

The Designer can inspect the real application and propose a rendered design plus acceptance requirements. Conductor validates, bounds, hashes, and protects that exact reference.

The user deliberately reviews every affected surface and its requirements before approval. Merely opening a surface does not count as review. The Builder is denied server-side until the exact current design is approved.

### Builder isolation and non-terminal success

The Builder receives the protected approved reference as read-only input and executes in Mission context rather than the Agent's ordinary Playground thread.

A successful Builder Run is captured as a bound workspace revision, but success is non-terminal: it cannot by itself complete or publish the Mission.

### Independent actual-app verification

The system-owned BrowserVerifier runs the actual captured application and checks:

- required content and accessible elements;
- required interactions and observable results;
- runtime/page errors;
- bounded visual fidelity for contract-significant elements against the protected rendered design.

For visual fidelity, the browser measures objective rendered facts such as geometry, typography, and key colors on the approved reference and the built app. Small rendering drift is tolerated; material deviation fails verification. The protected design remains the source of truth.

This is not pixel-perfect screenshot equality, whole-DOM matching, or VLM judging.

The first PASS allows the user to review the exact built result but does not complete the Mission. User acceptance is also non-terminal. A separate current final verifier PASS is required before the exact verified workspace can be transactionally published back to the source Agent.

### Failure and recovery

- semantic/interaction/visual FAIL keeps completion blocked;
- verifier infrastructure ERROR is separate and retryable against the same captured implementation without rerunning Builder;
- one automatic Repair may follow the initial failed app check;
- one additional Repair may be explicitly requested by the user when eligible;
- no third Repair, retry-until-green loop, failing-result acceptance, or final-failure auto-Repair exists;
- stale/superseded attempts, approvals, verification results, and publication state cannot grant completion.

The existing Agent CRUD and Playground remain ordinary platform paths. Messages and Runs remain durable. Agents are rejected server-side only when an unfinished Mission legitimately reserves them. Successful publication resets unsafe stale Runtime thread context while preserving the authoritative filesystem and durable Playground history.

## Development and checks

```bash
npm ci
npm run demo:setup
npm run demo:reset
npm run poc
# in a second terminal after the POC is healthy:
npm run demo:seed
# Complete Prompt A once through Playground and its governed Mission, then:
npm run demo:seed
npm run demo:doctor
npm run demo:verify
npm run check
git diff --check
```

`npm run check` runs workspace typechecks, server tests, and both builds. See [docs/DEMO.md](docs/DEMO.md) for the production-style live rehearsal.

## Architecture and limitations

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the one-page data-flow/trust-boundary diagram.

Conductor is intentionally a bounded local POC rather than a deployment platform. Runtime containers are not hardened multi-tenant sandboxes; the shared browser token is not production identity/RBAC. Verification supports the application profiles documented by the current source rather than claiming universal framework coverage.

There is no pixel/VLM judge, whole-DOM visual matcher, deployment system, generalized workflow engine, migration framework, or autonomous retry-until-green loop.

See [SECURITY.md](SECURITY.md) for trust-boundary and secret-handling limitations.

## License

[MIT](LICENSE)
