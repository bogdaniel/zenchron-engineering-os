# Local WorkGraph quickstart

Run Zenchron on loopback, create an objective, review a proposed plan, approve it, and follow the resulting WorkGraph.
The steps below describe the local development setup in this checkout.

## Feature diagram

```mermaid
flowchart LR
    Operator[Operator] -->|Open local dashboard in Live mode| UI[Objectives page · #objectives]
    UI -->|"POST /api/v1/objectives/{id}/plans"| API[Local control plane]
    UI -->|"POST /api/v1/objectives/{id}/plans/{revision}/approve"| API
    API -->|Queue planning and unit runs| Runs[(Agent runs)]
    Worker[Local worker] -->|Claim and report runs| API
    API -->|"GET /api/v1/objectives/{id}/plans<br/>GET /api/v1/work-graphs"| UI
```

## Start locally

1. From the repository root, install dashboard dependencies once with `cd dashboard && npm ci`.
2. Install and sign in to the Codex CLI or Claude Code CLI on this same machine. The local worker discovers these
   providers when it starts.
3. Run `./dev.sh` from the repository root. It starts the control plane at `127.0.0.1:8080`, the local worker, and
   the dashboard at `127.0.0.1:4173`; press Ctrl+C to stop the services.
4. Open <http://127.0.0.1:4173/?mode=live#objectives>. Local dashboard addresses default to Mock mode; Live selects
   data from the local control plane. Mock displays fixtures and does not save changes.

Sources: `README.md`, `dev.sh`, `dashboard/src/main.tsx`, `docs/features/local-preview.md`.

## Create an objective and select workflow guidance

1. In **Objectives**, choose **New Objective**, enter a title, and optionally add a description, owner, product, and
   due date; submit **Create objective**.
2. Select the objective and open its **Plan** tab.
3. In **Agents**, create or select an active Codex CLI or Claude Code producer profile with `code.write` permission.
   Plan execution requires at least one producer that can change the checked-out repository.
4. In **Propose a plan**, choose an online **Repository checkout** and an active, read-only Codex CLI or Claude Code
   **Planning agent**. If there is no suitable profile, create one under **Agents** with code-write permission off.
5. Optionally choose a saved workflow. This gives the planner workflow steps as guidance; workflows do not execute
   plans. If needed, view or create a saved workflow on **Workflows** first, then return to the objective's Plan tab.
6. Choose **Propose plan**. When planning completes, inspect the proposal summary, unit order and dependencies,
   assigned agents, instructions, acceptance criteria, and any listed problems. Only a valid proposed revision can
   be approved.

Sources: `dashboard/src/objectives.tsx`, `dashboard/src/ObjectiveDetail.tsx`,
`dashboard/src/ObjectivePlanPanel.tsx`, `dashboard/src/orchestration.ts`, `cmd/zenchron/orchestration_api.go`,
`cmd/zenchron/work_graph_context.go`, `docs/features/objective-orchestration.md`,
`docs/features/workflow-builder.md`.

## Approve and follow the WorkGraph

1. Select **Approve plan and start** on the latest proposed revision. Approval creates a WorkGraph and starts its
   units; if approval is unavailable, read the displayed reason or plan problems. For a changed plan, an existing
   executing graph for that objective must first be cancelled.
2. The graph appears above **Plan revisions** in the same Plan tab. Its overall state is `active`, `blocked`,
   `completed`, `failed`, or `cancelled`. Each unit shows its state, any waiting reason or failure, candidate commit,
   review verdict, run count, and pull-request link when present. The page refreshes graph state every three seconds.
3. If a unit is blocked on a person, read its decision request and submit a resolution. Retry is available for failed
   units; **Cancel work** cancels an unfinished graph. Handoffs, findings, and decisions appear in the graph's message
   list.
4. To inspect the local API's graph data directly, `GET /api/v1/work-graphs` lists graphs; plan revisions are served
   by `GET /api/v1/objectives/{id}/plans`.

Sources: `dashboard/src/ObjectivePlanPanel.tsx`, `dashboard/src/WorkGraphView.tsx`,
`dashboard/src/orchestration.ts`, `cmd/zenchron/orchestration_api.go`, `cmd/zenchron/work_graph_reconcile.go`,
`docs/features/objective-orchestration.md`.

## Verification references

The existing focused checks cover the end-to-end dashboard flow and the control-plane lifecycle:

- `(cd dashboard && npx playwright install chromium)` (once per machine)
- `(cd dashboard && ZENCHRON_E2E_DASHBOARD_PORT=4174 npm run test:e2e -- e2e/orchestration.spec.ts)`
  Choose an unused port; this prevents Playwright from reusing a running dashboard and writing into its local data.
- `go test ./cmd/zenchron -run 'TestObjectiveRunsParallelProducersThroughReviewRemediationIntegrationAndOnePullRequest|TestDecisionRequestBlocksItsUnitUntilAPersonResolvesIt' -count=1`

These commands are listed with orchestration coverage in `docs/features/objective-orchestration.md`; they were not run
as part of this documentation change.
