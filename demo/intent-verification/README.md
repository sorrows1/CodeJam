# Intent verification fixture

This Vite fixture is the clean application seed for the Conductor demo. It
contains a visible required result and a deterministic button interaction, so
the independent verifier can capture both exact checks and a screenshot.

It is copied into a freshly created demo Agent workspace by:

```bash
npm run demo:seed
```

To reuse a particular existing Agent, use
`npm run demo:seed -- --agent <agent-uuid>`. The seeder resolves and validates
the platform-managed workspace through the running control-plane API; do not
pass a filesystem path or edit JsonStore directly.
