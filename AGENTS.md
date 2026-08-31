# Conductor repository instructions

## Final release override — 2026-08-31

This section is the current phase authority and **supersedes older phase-sequence
text later in this file and in historical planning/specification documents**.
It does not weaken any settled Conductor invariant below.

Phase 15 plus its cumulative-workspace and Playground thread-continuity
follow-up are implemented. The only remaining executable phase is:

```text
Phase 16 -> recording-ready TechJam release gate
```

The former separate Phase 17 has been merged into Phase 16 and must not be run
as another phase.

Phase 16 is DONE only when the user can immediately start recording the final
three-minute TikTok TechJam Track 1 demo. No additional engineering,
documentation reconciliation, security audit, prepared-state work, acceptance,
or rehearsal may remain after DONE.

The canonical judge path is now explicitly Playground-first:

```text
create/select runnable Agent in frontend
-> invoke real task through Playground
-> show real model/file/tool/Runtime action
-> Conductor impact governance in backend/Runtime/data path
-> frontend/ambiguous work promotes into exact DesignRevision governance
-> protected approval -> Builder -> independent actual-app verification
-> verified state publishes back to source Agent
-> show normal result + meaningful denial/failure/recovery
-> platform remains understandable and controllable
```

Do not make manual Mission creation the canonical opening of the final demo.
Controlled fixtures may supplement deterministic negative evidence but cannot
replace or masquerade as the required real Agent Run.

The final phase must optimize for the Track 1 scoring weights: end-to-end
middleware behavior (40%), technical design/integration (25%), verification and
robustness (20%), demo/reproducibility (15%). Depth, coherence, and a truthful
three-minute proof outrank new feature breadth.

## Mission

This repository extends the Volc Agent Launchpad / CodeJam starter with **Conductor**.

> **Conductor is intent-governance middleware for autonomous coding Agents. It turns human-approved designs into enforceable execution contracts, gates implementation on explicit approval, and independently verifies the real application before completion.**

Short product statement:

> **Agents can write correct code and still build the wrong product. Conductor makes approved intent enforceable.**

The primary problem is **loss of human intent during autonomous software execution**, not lack of another frontend-design skill or another generic orchestration framework.

The completed reliability infrastructure from earlier Conductor phases remains part of the product: durable Missions, authoritative attempts, checkpoints, recovery, budgets, events/evidence, human intervention, participant consistency and stale-result rejection support the intent-governance workflow.

Do not turn Conductor into a generic workflow platform, a Figma clone, a frontend foundation model, a general browser cloud, or a generalized autonomous remediation system.

## Reading hierarchy

For every non-trivial phase, establish context in this order:

1. `AGENTS.md`
2. `docs/CHALLENGE_BRIEF.md`
3. `IMPLEMENTATION_SPEC.md`
4. `docs/CODEX_WORKFLOW.md`
5. `docs/plans/00-INDEX.md`
6. the current phase file
7. accepted DONE handoffs relevant to the phase
8. starter documentation specifically relevant to the phase
9. directly affected source code/tests

Higher items constrain lower items.

### Documentation precedence

1. direct user instruction;
2. `AGENTS.md`;
3. `docs/CHALLENGE_BRIEF.md`;
4. `IMPLEMENTATION_SPEC.md`;
5. current phase specification;
6. accepted architect decisions for the current phase;
7. starter documentation;
8. existing implementation details.

Use current source code over stale documentation when determining actual behavior.

## Repository baseline to preserve

Preserve the starter and completed Conductor infrastructure unless a phase explicitly changes a seam:

- React Agent CRUD / Playground;
- Fastify control plane;
- `AgentService`;
- `JsonStore`;
- `WorkspaceManager`;
- `AgentRunner`;
- `CodexRunner` / `ContainerCodexRunner`;
- local `npm run poc`;
- existing tests and `npm run check`;
- completed Phase 01-12 reliability and intent-governance code where it remains useful;
- Mission/task/attempt authority and stale-result guarantees;
- Mission workspace checkpoints/recovery;
- token-budget accounting and evidence;
- DesignRevision approval and protected-reference integrity;
- Builder admission and exact input binding;
- BrowserVerifier isolation and exact DesignRevision/workspace binding;
- independent PASS/FAIL/ERROR completion authority and durable evidence.

Do not replace the starter with a new Agent framework, message broker, database, arbitrary DAG engine, or orchestration platform.

The old `generic` / `software_delivery` Mission templates and PM -> Coder -> QA product path are **not** compatibility requirements. Do not reintroduce them, and do not introduce a `legacy` workflow kind or `legacy` task stage. Phase 01-09 DONE documents remain historical records, not active product contracts.

### Current baseline and target boundary

The checked-in Phase 12 runtime is the implementation baseline. Phase 09.5,
Phase 10, and Phase 12 are DONE; Phase 11 was intentionally skipped.

The current execution boundaries are:

```text
Ordinary Agent CRUD/Playground
React -> apps/web/src/api.ts -> Fastify -> AgentService
-> JsonStore -> RunExecutionService -> AgentRunner/Codex runner

Intent-governed Mission
MissionPanel -> Fastify Mission routes -> MissionService
-> Design execution / DesignGovernanceService
-> protected DesignRevision materialization
-> human review / exact approval
-> MissionExecutionService implementation admission
-> protected-reference verification
-> RunExecutionService -> AgentRunner/Codex runner
-> immutable Mission workspace revision
-> automated implementation precheck
-> optional one automatic evidence-driven Repair on the initial semantic FAIL
-> human implementation review of approved design versus actual captured app
-> optional one explicitly human-requested Repair (two total Repair cycles maximum)
-> exact human acceptance of a passing precheck revision
-> MissionVerificationService -> isolated BrowserVerifier for FINAL verification
-> actual Node/React/Vite application
-> exact checks + screenshot + bounded runtime evidence
-> only exact FINAL PASS completes / semantic FAIL denies / ERROR remains retryable
```

The checked-in backend already guarantees:

- implementation cannot start without the exact current approved DesignRevision;
- approved reference material is protected outside the mutable Mission workspace and hash-bound;
- Builder attempts are bound to the exact approved design and workspace revision;
- a successful Builder Run does not complete the Mission;
- verification runs the actual supported application and is bound to the exact approved design and implemented workspace revision;
- a precheck PASS is non-terminal and only unlocks human implementation review;
- human acceptance is exact and necessary but not sufficient for completion;
- only a current passing FINAL VerificationRun completes and releases participants;
- semantic FAIL blocks with durable evidence and infrastructure ERROR remains incomplete/retryable;
- stale Agent/verifier results cannot advance authority;
- ordinary Playground state and `Agent.codexThreadId` remain separate from Mission attempts;
- participant reservation, budgets, checkpoints and bounded/redacted evidence remain enforced.

Ordinary Playground runs retain the Agent workspace, `Agent.codexThreadId`, Messages, and ordinary run history. Mission attempts use `threadId: null`, keep runtime thread IDs as evidence, and are denied server-side when an Agent is reserved by a non-terminal Mission. React and Fastify remain presentation/transport layers.

The bounded product additions and Playground thread-continuity follow-up are
complete. Current deterministic tests still do not substitute for the final
live container-backed Agent and actual-app rehearsal.

The final implementation sequence is:

```text
Phase 12     DONE checked-in baseline
Phase 13     completed product-experience implementation baseline
Phase 14     DONE review evidence, safe immutable preview, stable Glass-box history
Phase 15     DONE conditional Playground impact admission + atomic multi-surface design
Phase 16     recording-ready live demo, judging acceptance, and release freeze
```

Phase 10 remains the authority/competition cut line. Phases 14-16 expose,
extend only the explicitly accepted seams, exercise, and accept it; they must
not weaken it or use fabricated authority records for demo convenience.

## Runtime product workflow

The primary intent-governed workflow is:

```text
User intent
  -> Design
  -> Render design
  -> Human review
      -> feedback/revise until accepted
      -> approve
  -> Immutable approved DesignRevision
  -> Implementation admission
  -> Builder Agent
  -> captured implementation workspace revision
  -> Automated implementation precheck of actual application
      -> ERROR -> remain incomplete and retry verifier only
      -> initial semantic FAIL -> at most one automatic evidence-driven Repair
      -> PASS -> human implementation review
  -> Human compares approved design with actual immutable implementation
      -> request at most one explicitly human-requested Repair
      -> accept exact design/workspace/passing-precheck bindings
  -> FINAL independent verification
      -> PASS -> complete
      -> FAIL -> completion denied with evidence; no automatic Repair
      -> ERROR -> remain incomplete and retry verifier only
```

The bounded Repair policy is:

```text
initial precheck FAIL
  -> at most one automatic Repair
  -> precheck
  -> at most one additional human-requested Repair
  -> precheck

maximum total Repair cycles: 2
maximum automatic Repair cycles: 1
no retry-until-green loop
```

Agents are **replaceable stage executors**. Conductor governs the authoritative workflow, artifacts and transitions.

## Foundational intent-governance invariants

1. **No implementation without approval.**
   - An intent-governed implementation attempt may not start without an authoritative approved `DesignRevision`.
   - Hiding a button in React is not enforcement; the backend/control plane must deny unauthorized admission.

2. **The approved reference is immutable to the executor.**
   - The Builder, and optional Repair executor if implemented, cannot modify the design/reference/contract against which it is evaluated.
   - Approved reference content must be hash-bound or equivalently protected.

3. **Agent success is not Mission success.**
   - A successful Builder or optional Repair Agent Run cannot itself complete an intent-governed Mission.
   - Only an independent verification result bound to the authoritative design and workspace revision can authorize completion.

4. **Human approval is authoritative state.**
   - Approval is a durable server-side transition.
   - Approval applies to one exact DesignRevision.
   - Stale/superseded revisions cannot be approved as current.

5. **Design-stage writes are constrained.**
   - The design executor may inspect the application but may write only to the Conductor-controlled design draft area during the design stage.
   - Unauthorized application-source writes must be rejected/restored rather than trusted.

6. **Design history is append-oriented.**
   - New feedback produces a new revision.
   - Approved/superseded revisions are not silently rewritten.

7. **Downstream work is bound to approved intent.**
   - Implementation and optional Repair attempts reference the exact approved DesignRevision.
   - A newer authoritative design makes downstream implementation/verification evidence stale.

8. **Verification is independent.**
   - The Builder does not authoritatively self-evaluate.
   - Verification runs in a system-owned verifier against the real running application.
   - Precheck PASS cannot complete. Only a current passing FINAL VerificationRun after exact human acceptance can complete an intent-governed Mission and release its participants.

9. **Verification is revision-bound.**
   - Every verification identifies both the approved DesignRevision and the implemented Mission workspace revision.
   - A result from different/stale inputs cannot advance Mission state.

10. **Verification evidence is durable and bounded.**
    - Persist safe structured checks, status, actual screenshots, runtime errors and correlation IDs.
    - Do not expose private reasoning or secrets.
    - Pixel-difference scoring and VLM judging are not required for completion authority.

11. **Verification failure is an authoritative denial.**
    - A semantic FAIL leaves the Mission incomplete and visibly blocked with durable evidence.
    - Automatic repair is not required for the core product.
   - The accepted bounded policy allows at most one automatic Repair and one additional explicitly human-requested Repair. A failing precheck cannot be accepted, and final semantic FAIL does not auto-Repair.

12. **Restart does not silently spend model budget.**
    - Interrupted model work becomes recovered/paused unless an already-authorized policy proves another action.
    - Awaiting-approval state remains awaiting approval.
    - Interrupted verification may be retried without re-running completed implementation.

## Preserved Conductor reliability invariants

13. **Existing Agents remain ordinary platform Agents.**
    - Do not introduce Conductor-only Agent types.
    - Designer/Builder roles are task assignments, not new platform identities.

14. **Only one TaskAttempt is authoritative for a task at a time.**
    - Late, superseded or stale attempts cannot advance state.

15. **Mission execution must not corrupt ordinary Playground thread state.**
    - Mission attempts use the existing safe Mission execution semantics and do not silently overwrite normal Agent conversation state.

16. **Participant consistency remains explicit.**
    - Reserved Agents cannot race with conflicting ordinary execution or active Missions.

17. **Shared context remains explicit and bounded.**
    - Use durable goal/artifacts/state/revisions rather than dumping conversations or hidden reasoning.

18. **Retry, rollback, repair and redesign are distinct operations.**
    - Retry repeats an authorized stage on the current inputs.
    - Rollback restores Conductor-owned workspace state.
    - Optional Repair addresses verifier findings without changing approved intent.
    - Redesign creates a new design revision and invalidates downstream evidence.

19. **Human intervention remains first-class.**
    - Record interventions/revisions and downstream invalidation.

20. **Crash recovery preserves ambiguity rather than inventing success.**

21. **Budget accounting remains cumulative and honest.**
    - Use measured usage exposed by the starter.
    - Do not claim exact mid-generation cutoffs unless actually implemented.

22. **Infrastructure failures are not semantic product failures.**
    - Provider/container/checkpoint/server/verifier infrastructure failures should remain distinguishable from semantic verification mismatch or bad Agent work.

23. **Rollback covers Conductor-owned local state only.**

24. **Mission history is auditable.**
    - Do not rewrite old evidence to make a later run appear successful.

25. **Scope beats framework-building.**
    - Sequential workflow is enough.
    - No generic DAG editor, queueing system, universal planner, general model gateway, browser cloud or orchestration DSL.

## Fresh-state persistence policy

Historical Conductor database migrations are no longer part of the product.

After Phase 09.5:

- the current complete database shape is treated as `version: 1`;
- `store-migrations.ts` is deleted;
- `JsonStore.initialize()` loads only the current v1 format or creates an empty v1 database when the file is absent;
- incompatible database formats fail clearly and are not overwritten;
- local generated state is reset explicitly once when adopting this baseline;
- if the schema changes again before submission, update the current schema and reset local development data rather than adding migration code;
- do not add automatic startup deletion of configured data paths.

The starter's Agent/Playground **behavior** remains required even though previous local records are intentionally discarded.

## Middleware architecture

Use a small layered / ports-and-adapters architecture adapted to the starter:

```text
Experience
  React views/components + API client
        |
        v
Transport / API
  Fastify route schemas + HTTP mapping
        |
        v
Application / Control Plane
  Mission and intent-governance use-cases
        |
        v
Domain
  Mission/task/attempt/design/verification transitions and invariants
        ^
        | small ports/contracts
        |
Infrastructure
  JsonStore, workspace/checkpoints, Agent execution, design artifacts,
  verifier runtime, screenshots/evidence
        |
        v
Runtime
  Codex/Agent Runtime + isolated browser verifier
```

Rules:

- routes stay thin;
- React never owns authoritative workflow decisions;
- deterministic transitions have one server-side source of truth;
- separate decisions from side effects where useful;
- use small contracts at real volatile boundaries;
- avoid god services, interface-per-class, generic repositories and DI frameworks;
- tests must cover invariants without requiring a live model/browser whenever possible.

## Development phase discipline

Use the phase sequence in `docs/plans/00-INDEX.md`.

Do not implement later phases merely because they are convenient.

For architecture/state/persistence/runtime-boundary changes, use the architect gate from `docs/CODEX_WORKFLOW.md`.

Phase 11 remains skipped as historical planning. The accepted final bounded
Repair amendment is already part of the current workflow: at most one
automatic plus one human-requested Repair. Do not expand it during Phases
14-16 merely to add demo spectacle.

The final phase sequence is:

```text
14 DONE -> review evidence/capture, safe immutable preview, and durable Glass-box history
15 DONE -> architecture-gated pre-write impact admission and atomic multi-surface design
16      -> real Agent/container rehearsal, judging acceptance, documentation
           reconciliation, reproducible preparation, and release freeze
```

Phase 14 may improve how existing durable evidence is selected and displayed,
but preview remains ephemeral/non-authoritative and history must stay bound to
its own immutable run/revision records.

Phase 15 must not trust an Agent proposal or React to decide governance. If a
read-only proposal/write admission split cannot be enforced before source
writes, stop with an explicit blocker rather than approximate it. Multi-surface
approval is one exact atomic protected bundle, not a workflow engine.

Phase 16 must exercise at least one real configured Agent Run and one actual-app
verification. Controlled fixtures supplement this proof; they do not replace or
masquerade as the real Agent path.

Phase 16 adds no product breadth. It freezes scope and accepts the exact
three-minute demo against the hackathon contract. There is no later phase.

Every phase finishes with a concise DONE handoff and either:

`DONE`

or

`STOPPED WITH EXPLICIT BLOCKERS`
