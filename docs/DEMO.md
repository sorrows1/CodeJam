# Conductor demo

## What this demo proves

This walkthrough uses one prepared Agent and one live product request to show
Conductor's complete intent-governance path:

```text
existing ready Agent + real application
-> Playground product request
-> real Agent action + impact evidence
-> exact design + requirements review
-> protected approval
-> Builder implementation
-> Builder success remains blocked from completion
-> independent real-app verification
-> separate FINAL PASS
-> verified publication
-> the same application now contains the approved feature
```

The denial is part of the normal workflow: the Builder can finish successfully,
but its success alone cannot complete the Mission or publish the work.

## 1. Prepare the environment

Requirements:

- Node.js 22+
- npm 10+
- Docker Desktop, Colima, or Podman
- credentials for an OpenAI Responses-compatible model endpoint

Copy `.env.example` to `.env` with your editor or file manager. Configure:

- `MODEL_API_KEY`
- `MODEL_NAME`
- `MODEL_BASE_URL`
- `APP_AUTH_TOKEN` with a unique URL-safe value of at least 24 characters

The DeepSeek and ModelArk examples in `.env.example` show the expected model
configuration. Use scoped development credentials and do not commit `.env`.

Install dependencies and the verification browser once for a new checkout:

```text
npm ci
npm run demo:setup
```

Make sure the POC is stopped, then restore the prepared demo state and start the
production-style local application:

```text
npm run demo:reset
npm run demo:prepare
npm run poc
```

Leave `npm run poc` running. Open <http://localhost:3000> and enter the access
token from `APP_AUTH_TOKEN` if prompted.

In a second terminal, validate the environment and prepared state:

```text
npm run demo:doctor
```

The doctor is read-only: it does not spend model budget, change state, start a
Mission, or print credential values. It should confirm:

- the container Runtime and verifier image are available;
- exactly one ready `Demo Builder` Agent exists with a fresh Runtime context;
- the existing baseline Playground prompt is present;
- the prompt links to a completed governed Mission;
- the Mission has an approved design, FINAL PASS, and published workspace;
- the Agent Operations application contains Dashboard, Agents, and Settings;
- Activity is not present yet.

`demo:prepare` restores a bounded, sanitized checkpoint created through the
real Playground, Mission, approval, Builder, verification, and publication
path. It verifies file hashes and authority bindings, excludes credentials and
Runtime session state, and adjusts only the Agent workspace path for the local
machine. It must run while the POC is stopped and after `demo:reset` has cleared
the bounded demo state.

## 2. Understand the prepared starting state

Select `Demo Builder` in the Agents view. Its Playground already contains this
baseline request:

> **Turn this utility into a clear Agent Operations dashboard with Dashboard, Agents, and Settings navigation while preserving the existing intent result interaction.**

The request's linked Mission is already complete. Open it and inspect the
history to see the design approval, Builder execution, precheck, human
acceptance, FINAL PASS, and publication that produced the starting application.

Return to the Agent and click **Preview current app**. Confirm that the current
application has Dashboard, Agents, and Settings navigation and that Activity
does not exist. Close the preview before starting the live request.

Do not resubmit the baseline request. It exists only to provide a coherent
application and visible governance history before the live workflow begins.

## 3. Submit the live Playground request

In `Demo Builder`'s Playground, submit exactly:

> **Give users a way to review recent agent activity and quickly filter it by status.**

The request intentionally avoids words such as `frontend`, `React`, `UI`,
`CSS`, `page`, and `component`. Conductor must decide from the proposed work and
its actual impact that the change is user-facing or ambiguous and therefore
requires governance.

The intended bounded result is an Activity surface that fits the existing
application, adds a clear navigation entry, and provides one simple status
filter interaction. The Agent should not redesign the entire application.

Do not submit another Playground prompt after this request. Continue through
the Mission controls:

```text
Activity Playground request
-> impact proposal and admission decision
-> Open Mission
-> review design and requirements
-> Mark design + requirements reviewed
-> Approve design
-> Build approved design
-> observe Builder success still blocked
-> automatic app precheck
-> Accept result & run final check
-> automatic FINAL PASS
-> publication back to Demo Builder
```

## 4. Follow the governed Mission

### Inspect the impact decision

Wait for the Playground impact check. The result should explain that the
proposed work changes a user-facing product surface and cannot be published as
ordinary ungoverned work.

If the interface asks for confirmation, click **Protect this change**, then
click **Open Mission**. The Mission should retain the impact evidence and the
exact Activity request.

### Prepare and review the design

Click **Prepare design** if design work does not begin automatically. Wait for
the Designer to finish, then inspect every affected surface.

For each surface:

1. inspect the rendered design in the context of the existing application;
2. open **Review requirements**;
3. confirm the Activity heading, navigation, status controls, interaction, and
   any requirements affecting existing surfaces;
4. click **Mark design + requirements reviewed**.

Use **Request design changes** only if the proposed design is wrong. Feedback
creates a new design revision inside the same Mission; it is not another
Playground request.

### Approve the exact design

After reviewing all affected surfaces, click **Approve design**. Approval binds
the exact current design revision and requirements. It does not grant the
Builder permission to alter the protected reference.

### Run the Builder

Click **Build approved design** and watch the Builder evidence. The Mission
should show meaningful file or tool actions and then report that the Builder
finished.

Stop at this state and confirm the important denial:

```text
Builder completed successfully
!= Mission completed
!= changes published
```

The coding Agent cannot certify its own implementation. Conductor keeps
completion blocked until the captured application passes the independent
checks and the exact result is accepted.

### Inspect the automatic app precheck

The system-owned verifier starts the actual captured application and evaluates:

- required content and elements;
- required interaction behavior;
- browser and runtime errors;
- bounded visual fidelity for contract-significant elements against the
  approved rendered reference.

The visual comparison tolerates small rendering drift but rejects material
changes in protected layout, size, typography, and key colors. It is not a
pixel-perfect comparison or a VLM judgment.

A precheck PASS is non-terminal. It only unlocks review of the built result.

### Review the built result and run the final check

Compare **Approved design** with **Built result**. Exercise the Activity status
filter in the built application preview.

If the implementation is correct, click **Accept result & run final check**.
Acceptance is necessary but still does not complete the Mission. A separate
FINAL verification must pass against the exact accepted workspace revision.

Wait for:

```text
Final check · PASSED
Verified changes published to the Agent
```

Only this current FINAL PASS authorizes Mission completion and transactional
publication back to `Demo Builder`.

## 5. Confirm the published result

Return to `Demo Builder` and click **Preview current app** again.

Confirm that:

1. the original Dashboard, Agents, and Settings application remains intact;
2. Activity now appears in the application navigation;
3. the Activity surface shows recent agent activity;
4. changing the status filter updates the visible results;
5. the Agent is back in a ready and controllable state.

The final application is the same Agent workspace shown at the beginning, now
advanced only through the approved and independently verified publication.

## 6. Corrections and failure behavior

Text entered into **Design changes** or **Changes to the built result** is
correction feedback inside the current Mission. It is not an additional
Playground request.

The Repair policy is intentionally bounded:

- the first semantic precheck failure may trigger at most one automatic Repair;
- after a passing precheck, a person may request at most one additional Repair;
- no more than two Repair cycles are allowed in total;
- a FINAL semantic failure does not trigger automatic Repair;
- verifier infrastructure errors remain retryable and do not become semantic
  product failures.

If the proposed design is no longer acceptable, use redesign rather than
Repair. A new authoritative design invalidates downstream implementation and
verification evidence from the older revision.

## 7. Deterministic checks

The deterministic browser and service checks supplement the live Agent path:

```text
npm run demo:verify
npm run check
git diff --check
```

`npm run demo:verify` exercises controlled PASS/FAIL verification behavior
without spending model budget. It does not replace the live Playground request,
Builder execution, or actual-app verification above.

## 8. Reset and run the demo again

Stop `npm run poc`, then reset and restore the prepared state:

```text
npm run demo:reset
npm run demo:prepare
npm run poc
```

In the second terminal:

```text
npm run demo:doctor
```

Do not run reset or restore against a live POC. Do not manually delete arbitrary
paths or edit the database to create Mission, approval, or verification records.

## 9. Recreate the prepared checkpoint

Most developers should use `demo:prepare`. To rebuild the checkpoint through
the full product workflow after intentionally changing the baseline:

```text
npm run demo:reset
npm run poc

# In a second terminal:
npm run demo:seed
```

Submit the baseline prompt printed by `demo:seed` and complete its governed
Mission through the interface. Then run:

```text
npm run demo:seed
npm run demo:doctor
```

Stop the POC before exporting the validated state:

```text
npm run demo:export-state
```

The exporter accepts only the expected completed baseline, removes Runtime
thread identifiers, rejects configured credentials and host-specific paths,
and never includes `codex-home`.

## 10. Limitations

- The demo uses a bounded local Runtime and control plane, not hardened
  multi-tenant infrastructure.
- The verifier supports the repository's documented application profiles; it
  does not claim universal framework coverage.
- Visual enforcement is deterministic and bounded to contract-significant
  rendered elements. It is not pixel-perfect screenshot equality and does not
  use a VLM as completion authority.
- Repair is bounded; there is no retry-until-green loop.
- The shared local auth boundary is not production identity or RBAC.
