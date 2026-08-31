# Health endpoint fixture

This dependency-free fixture is intentionally missing `GET /health` so its
baseline test fails. The Coder Agent adds the endpoint, then verifies it with:

```bash
npm test
```

This historical deterministic fixture is not the prepared TechJam demo state.
The supported `npm run demo:seed` command copies only the
`demo/intent-verification` application through the running control-plane API.
