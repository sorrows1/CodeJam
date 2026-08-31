# Conductor architecture

Conductor keeps the Starter Kit's Agent frontend, Playground, Fastify control plane, JsonStore, workspace manager, and Agent Runner. The middleware decision and all authority-granting transitions stay server-side; React only presents state and sends explicit user actions.

## One-page architecture

```mermaid
%%{init: {"themeVariables": {"fontSize": "19px"}, "flowchart": {"nodeSpacing": 42, "rankSpacing": 52, "curve": "linear"}}}%%
flowchart TB
  User["1 · User submits one Playground request"] --> UI["Agent UI + Playground"]
  UI --> API["Fastify · validated commands"]

  subgraph Trusted["CONDUCTOR · TRUSTED SERVER-SIDE BOUNDARY"]
    API --> Impact["2 · Read-only impact plan<br/>and isolated candidate evidence"]
    Impact --> Decision{"What can the work affect?"}

    Decision -->|"proven nonvisual"| Ordinary["Ordinary transactional publication"]
    Decision -->|"frontend or ambiguous"| Mission["3 · Governed Mission"]

    Mission --> Design["4 · Designer proposes rendered design<br/>and testable requirements"]
    Design --> Review["5 · User reviews every affected surface<br/>and approves the exact revision"]
    Review --> Protected["Protected hash-bound reference<br/>+ server-side build gate"]

    Protected --> Builder["6 · Builder Agent runs<br/>inside the isolated Runtime"]
    Builder --> Captured["Captured immutable workspace"]
    Captured --> Denial["DENIAL · Builder success<br/>is not Mission completion"]

    Denial --> Precheck["7 · Independent BrowserVerifier<br/>runs the actual captured app"]
    Protected -. "exact approved reference" .-> Precheck
    Precheck --> Result{"App-check result"}
    Result -->|"FAIL"| Repair["Bounded repair<br/>maximum two cycles"]
    Repair --> Precheck
    Result -->|"ERROR"| Retry["Retry verifier only<br/>same captured workspace"]
    Retry --> Precheck
    Result -->|"PASS"| BuiltReview["8 · User reviews and accepts<br/>the exact built result"]

    BuiltReview --> Final["9 · Separate FINAL BrowserVerifier"]
    Protected -. "same approved reference" .-> Final
    Captured -. "same accepted workspace" .-> Final
    Final -->|"PASS"| Verified["10 · Publish exact verified workspace"]
    Final -->|"FAIL"| Blocked["Completion remains blocked"]

    Impact -.-> Evidence["Bounded JsonStore evidence"]
    Precheck -.-> Evidence
    Final -.-> Evidence
  end

  Ordinary --> AgentWorkspace["Source Agent workspace"]
  Verified --> AgentWorkspace
  AgentWorkspace --> UI

  classDef primary fill:#4f46e5,color:#fff,stroke:#312e81,stroke-width:2px;
  classDef guard fill:#fff4cc,color:#4a3600,stroke:#d49b00,stroke-width:2px;
  classDef alternate fill:#eef0f3,color:#30343b,stroke:#8b929c;
  classDef failure fill:#fde2e2,color:#7f1d1d,stroke:#c94a4a,stroke-width:2px;
  class Mission,Design,Review,Protected,Builder,Captured,Precheck,BuiltReview,Final,Verified primary;
  class Decision,Result,Denial guard;
  class Ordinary,Evidence alternate;
  class Repair,Retry,Blocked failure;
```

The numbered purple path is the recorded demo. The gray branch is ordinary
nonvisual Playground work. Yellow diamonds and the Builder denial are the
authority gates; red nodes are bounded failure/recovery paths.

## What Conductor decides

The Playground remains the ordinary invocation surface. Conductor first plans impact without allowing authoritative writes. When execution is needed to resolve impact, it uses a disposable candidate workspace. The **complete actual candidate diff** is the final admission evidence:

- proven nonvisual work can publish transactionally back to the Agent without a Mission;
- frontend-affecting or ambiguous work cannot silently publish and is promoted into the governed Mission path.

This keeps ordinary backend/nonvisual work lightweight while protecting product-intent changes.

## Approval boundary

For governed work, the Designer can inspect the real application but its product proposal becomes authoritative only after Conductor validates and protects the exact DesignRevision.

The user reviews:

- the rendered affected surface(s);
- the acceptance requirements for those surfaces.

A deliberate approval action binds the exact protected revision. Merely visiting a surface does not count as review. Builder execution is denied server-side until the current protected revision is approved.

## Builder boundary

The Builder receives the approved reference as read-only input and works only in the Mission workspace. It cannot modify the protected reference or grant itself completion.

A successful Builder Agent Run is intentionally **non-terminal**. Conductor captures the resulting application as a bound workspace revision before verification.

This non-terminal success is the primary live denial shown in the TechJam demo: an Agent can claim success, but that claim does not authorize product adoption.

## Independent verification

The system-owned BrowserVerifier starts the actual captured application and evaluates the protected contract/reference at the same logical viewport.

It checks:

- required text and accessible elements;
- required interactions and expected observable results;
- runtime/console errors;
- bounded visual fidelity for contract-significant elements.

Visual fidelity is derived from browser-observable facts in the protected rendered reference and the real implementation, including bounded geometry, typography, and key color differences. The browser is only the measurement mechanism; the protected DesignRevision remains the source of truth.

This is deliberately **not** pixel-perfect screenshot equality, whole-DOM matching, or VLM judging. Small browser rendering drift can pass; material changes to protected elements fail verification.

## Adoption boundary

The first verification is a precheck. A PASS does not complete the Mission; it only allows the user to inspect the exact built result.

User acceptance is also non-terminal. A separate current final verifier run must PASS against the same approved design and captured implementation. Only then can Conductor transactionally publish that exact workspace back to the source Agent.

Final semantic FAIL denies completion. Verifier infrastructure ERROR is distinct and retryable against the same captured implementation without rerunning the Builder.

## Recovery and stale-result safety

Conductor keeps exact attempt/revision/workspace bindings and rejects stale or superseded authority results. Recovery is bounded and idempotent. Restart recovery does not automatically spend new model budget unless the accepted semantics explicitly authorize another model attempt.

Publication failure cannot invent success: the Agent remains reserved until the verified workspace is safely published or an explicit supported recovery action is taken.

Successful Agent publication resets unsafe stale ordinary Runtime thread context while preserving durable Playground Messages/Runs and the authoritative filesystem.

## Evidence and secrets

Conductor records bounded, redacted observable evidence such as:

- Run/action summaries;
- changed-file manifests;
- impact/admission evidence;
- design/revision hashes;
- verifier checks;
- reference/actual screenshots;
- correlations and recovery events.

It does not expose chain-of-thought, raw private reasoning, or provider credentials in Mission artifacts/events/UI.

## Deliberate scope

The POC is intentionally local and bounded. It has no arbitrary DAG/workflow builder, broker requirement, browser cloud, deployment platform, universal framework verifier, pixel/VLM judge, migration framework, production identity/RBAC, or retry-until-green repair loop.
