# Intent verification fixture

This credential-free Vite fixture is the source application used when a
maintainer recreates the recorded reviewer checkpoint. It contains a visible
required result and deterministic button interaction. A real baseline
Playground Mission turns it into the Agent Operations dashboard; the live demo
Mission later adds Activity.

It is copied into a freshly created demo Agent workspace by:

```bash
npm run demo:seed
```

To reuse a particular existing Agent, use
`npm run demo:seed -- --agent <agent-uuid>`. The seeder resolves and validates
the platform-managed workspace through the running control-plane API; do not
pass a filesystem path or edit JsonStore directly.

Reviewers do not run this baseline Mission. They use `npm run demo:prepare` to
restore its bounded, sanitized, recorded checkpoint with the existing prompt
and completed Mission already visible. The exact live prompt and Mission
controls are documented in `docs/DEMO.md`.
