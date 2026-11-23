# Action Required

The Live Overview projects the latest proposed plan approvals and unresolved typed WorkGraph decision requests from
the existing control-plane stores through `GET /api/v1/action-required`. It omits cancelled graphs and plans outside
the caller's existing objective/repository visibility. Plan rows link to the existing Plan tab and its latest plan
approval control; graph rows link to the exact objective, graph, and decision. Rows show objective, plan revision,
stage/unit/run where present, exact subject, recorded waiting reason, and decision options; missing values remain
explicitly unrecorded. Plan approval is not a separate authorization system: the existing plan endpoint rechecks
whether the caller may start work. Graph resolution remains owned by the existing decision endpoint. A successful
replacement-plan approval clears the old graph and decision from the deep link so the refreshed plan view follows the
newly approved graph. Product Workspace decision links use the same exact deep link and label decisions in cancelled
graphs as cancelled.

## Feature diagram

```mermaid
flowchart LR
    Link["Action Required deep link<br/>objective · tab · graph · decision"] -->|Retain selection until navigation or approval| Overview
    Overview[Live Overview] -->|GET /api/v1/action-required| CP[(Existing Go control plane)]
    CP -->|visible proposed plans and unresolved typed decisions| Overview
    Overview -->|objective_id · plan revision| Objective[Existing Objective Plan view]
    Objective -->|POST /api/v1/objectives/{id}/plans/{revision}/approve| CP
    Overview -->|objective_id · graph_id · decision_id| Objective
    Objective -->|POST /api/v1/work-graphs/{graph}/decisions/{decision}| CP
    Product[Product Workspace] -->|GET /api/v1/products/{id}/environment| CP
    Product -->|exact decision link with graph status| Objective
    Objective -->|successful plan approval · refresh| CP
    CP -->|newest objective WorkGraph| Objective
    Objective -->|clear obsolete graph_id and decision| Link[Current navigation]
    Mock[Mock Overview] -. makes no queue request .-> CP
```

## Verification

`cd dashboard && npm run test:e2e -- e2e/action-required.spec.ts` checks exact graph decision context, proposed-plan
review navigation, desktop and phone layouts, cancelled-graph filtering, empty and error states, and unknown fields.
`cd dashboard && npm run test:e2e -- e2e/orchestration.spec.ts --grep 'an objective plan approved in the dashboard runs through decision'`
checks plan approval and graph decisions through the real control plane and worker. `go test ./cmd/zenchron -run
'TestActionRequiredProjectsCurrentPlanAndGraphDecisionsAcrossRestart|TestProductEnvironmentReferencesOnlyItsOwnObjectivesGraphsAndDecisions' -count=1`
checks projection durability, approval removal, decision recovery, caller visibility, and product scoping.
