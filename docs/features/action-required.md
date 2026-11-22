# Action Required

The Live Overview lists unresolved typed WorkGraph decision requests from the existing control plane. It omits
cancelled graphs, reports loading, empty, and unavailable states, and links each row to the specific objective, graph,
and decision. The destination focuses the existing authorized resolution field; no second authority model or queue is
stored. A successful replacement-plan approval clears the old graph and decision from the deep link so the refreshed
plan view follows the newly approved graph. Product Workspace decision links use the same exact deep link and label
decisions in cancelled graphs as cancelled.

## Feature diagram

```mermaid
flowchart LR
    Link["Action Required deep link<br/>objective · tab · graph · decision"] -->|Retain selection until navigation or approval| Overview
    Overview[Live Overview] -->|GET /api/v1/work-graphs| CP[(Existing Go control plane)]
    CP -->|authorized durable WorkGraphs and typed decision requests| Overview
    Overview -->|objective_id, graph_id, decision_id| Objective[Existing Objective Plan view]
    Objective -->|POST /api/v1/work-graphs/{graph}/decisions/{decision}| CP
    Product[Product Workspace] -->|GET /api/v1/products/{id}/environment| CP
    Product -->|exact decision link with graph status| Objective
    Objective -->|successful plan approval · refresh| CP
    CP -->|newest objective WorkGraph| Objective
    Objective -->|clear obsolete graph_id and decision| Link[Current navigation]
    Mock[Mock Overview] -. makes no queue request .-> CP
```

## Verification

`cd dashboard && npm run test:e2e -- e2e/action-required.spec.ts e2e/workspace.spec.ts` checks the exact graph and
decision deep link at desktop and phone sizes, focused resolution UI, cancelled-graph filtering, empty and error
states, and Product Workspace links. `go test ./cmd/zenchron -run 'TestProductEnvironmentReferencesOnlyItsOwnObjectivesGraphsAndDecisions' -count=1`
checks the typed graph status in the product projection.
