# Intent verification fixture

This Vite fixture is the source application seed for the Conductor demo. It
contains a visible required result and a deterministic button interaction. A
real pre-recording Playground Mission turns it into the published Agent
Operations dashboard shown at the start of the recording; the live Mission
then adds Activity.

It is copied into a freshly created demo Agent workspace by:

```bash
npm run demo:seed
```

To reuse a particular existing Agent, use
`npm run demo:seed -- --agent <agent-uuid>`. The seeder resolves and validates
the platform-managed workspace through the running control-plane API; do not
pass a filesystem path or edit JsonStore directly.

The exact pre-recording prompt and Mission controls are documented in
`docs/DEMO.md`. After that Mission reaches FINAL PASS and publication, rerun
`npm run demo:seed`: it preserves the real history and published workspace
rather than copying this fixture over them.
