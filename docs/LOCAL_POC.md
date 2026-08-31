# Local POC

The local POC runs the React/Fastify control plane and disposable Agent
Runtime containers. The launcher is implemented in Node, so the same npm
commands work on Windows, macOS, and Linux. Only the configured model API
is remote.

## First-time setup

Requirements:

- Node.js 22+
- npm 10+
- Docker Desktop, Colima, or Podman
- A model API key and Responses-capable endpoint

Copy `.env.example` to `.env` using your editor or file manager and fill in
`MODEL_API_KEY`, `MODEL_NAME`, and `MODEL_BASE_URL`. The launcher reads `.env` and `.env.local`
automatically; shell-specific `export` or `KEY=value command` syntax is not
needed.

Then run:

```text
npm ci
npm run demo:setup
npm run poc
```

Open <http://localhost:3000>. `npm run poc` automatically:

- installs npm dependencies if `node_modules` is missing;
- uses `.local/conductor-live` as the persistent local state root;
- detects a running Docker or Podman engine (and can start Colima/Podman
  machines where supported);
- builds the disposable Agent Runtime image if it is missing;
- builds the network-isolated verifier image if it is missing; and
- starts the production-style control plane.

The deterministic browser fixtures need the one-time `npm run demo:setup`
browser install. On Linux, if Chromium reports missing system libraries, use
`npx playwright install --with-deps chromium`.

## Seed without finding a UUID

With the POC running, open a second terminal and run:

```text
npm run demo:seed
```

The command creates a fresh `Demo Builder` Agent, then copies the checked-in
`demo/intent-verification` fixture into that Agent's workspace. It prints the
new UUID for auditability, but you do not need to copy it into another command.
To select and reuse a particular Agent explicitly, the optional form is:

```text
npm run demo:seed -- --agent <agent-uuid>
```

The seeder requires the platform-managed workspace and rejects symlinks. It
overwrites only the fixture's named files and preserves unrelated workspace
files.

## Development changes

You do not need to repeat the full production setup for every source change.
Leave the POC running and use watch mode when actively editing:

```text
npm run poc -- --dev
```

Watch mode reuses the same state and container images, runs Vite on
<http://localhost:5173> with API proxying, and watches the server TypeScript.
Use the plain `npm run poc` when you want the built, production-style screen
for a rehearsal. The runtime image is reused on later starts; use
`npm run poc -- --rebuild-runtime` after changing `Dockerfile.runtime` or the
runtime image inputs.

## Deterministic proof and reset

Run the controlled PASS/FAIL browser proof without spending model budget:

```text
npm run demo:verify
```

The default state can be reset safely with:

```text
npm run demo:reset
```

This removes only `data/`, `workspaces/`, and `codex-home/` below
`.local/conductor-live`. It refuses the repository, home directory, filesystem
root, symlinked paths, and broad or ambiguously named directories. A custom
dedicated root can be selected in `.env.local` with
`LOCAL_POC_DATA_ROOT=C:\path\to\conductor-demo` on Windows or an equivalent
absolute path on macOS/Linux; the same `npm run poc`, `demo:seed`, and
`demo:reset` commands then use it.

## Common options

Use `.env.local` for local-only overrides:

```text
CONTAINER_ENGINE=podman
LOCAL_POC_DATA_ROOT=.local/conductor-live
POC_PORT=3000
```

`--skip-verifier-build` skips the verifier image build only when an existing
verifier image is already available and you intentionally do not want the
launcher to check it. `VERIFIER_PROVIDER=local-process` is a host-only option
for deterministic development checks.

## Runtime details

Each Agent turn mounts only the selected Agent workspace and Codex session
directory. Default limits are 2 CPUs, 2 GiB memory, 256 processes, dropped
capabilities, and `no-new-privileges`.

Codex requests `workspace-write`. If the Linux kernel lacks Landlock, startup
warns and disables only the inner Codex sandbox. The outer container limits
remain active, but this fallback is not tenant isolation.

Mission workspaces live below `<workspace-root>/.missions/<mission-id>` and
checkpoints are stored separately under `.mission-checkpoints`. A Mission retry
uses the current Mission workspace; rollback restores a named Conductor
checkpoint. The source Agent workspace remains unchanged.

## Troubleshooting

Check Runtime readiness with the engine available on your machine:

```text
docker info
docker image inspect volc-agent-runtime:local
```

Use `podman` in place of `docker` when applicable. If a bind mount is rejected,
set `LOCAL_POC_DATA_ROOT` in `.env.local` to a directory shared with the
container VM. The launcher validates workspace write access and reports the
next safe action without exposing model credentials.
