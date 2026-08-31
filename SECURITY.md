# Security policy

Conductor is a hackathon proof of concept. Only the latest revision on the
default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- Shared demo token; no user identity, authorization, RBAC, or tenant isolation
- No CSRF protection
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Broad outbound network access
- Prompt-triggered command and file execution
- Model API key available to the server and active Runtime container
- Model API key stored in Terraform POC state
- Redaction is bounded pattern-based protection, not a guarantee against every
  possible secret-like string. Use dedicated demo credentials and data roots.
- Full client-side routing inside interactive previews is supported only by the
  loopback POC. Non-loopback deployments retain the opaque preview fallback.

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable model API key and a unique `APP_AUTH_TOKEN`.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.

The intent-verification fixture contains no credentials, `.env`, `.codex`,
logs, or committed generated output. Seed it through the bounded control-plane
path with `npm run demo:seed`, or select an existing Agent with
`npm run demo:seed -- --agent <agent-uuid>`. Do not pass a workspace path or
edit JsonStore directly. The visible pre-recording Mission must be completed
through the real Playground, approval, verification, and publication path;
the seeder preserves that authority history but never fabricates it.
Mission artifacts, errors, events, and traces are bounded observable evidence;
they do not contain raw prompts or private model reasoning.

Interactive built/current-app previews use a short-lived, per-session loopback
origin. This lets the saved application use normal root routes without sharing
the Launchpad origin. Assets remain immutable and bounded; access uses a unique
HttpOnly cookie, CSP permits only the exact Launchpad frame ancestor, and the
preview server is closed on stop, expiry, replacement, or shutdown.

## Secret audit

Before submission, inspect the current tree and reachable Git history without
printing candidate values. Check `.env.example`, Runtime argv/environment
handling, logger redaction, generated clean-demo JsonStore state, Mission
artifacts/events/revisions, browser storage/network/DOM, terminal output, and
committed screenshots. `gitleaks` is useful when installed; otherwise record a
bounded pattern scan and its limitations in `docs/SECURITY_AUDIT.md`.

The model API key must flow only through the server/Runtime environment. It must not
appear in API responses, `/api/system`, JsonStore, Mission evidence, browser
storage, logs, or screenshots. The shared auth token is held in browser memory
and authorization/cookie headers are logger-redacted.
