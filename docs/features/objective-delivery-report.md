# Objective delivery report

The delivery report is a backend-only, read-only report for one WorkGraph; no dashboard page calls it yet. It
summarizes recorded graph, unit, message, attempt, and run usage data without reconciling or persisting anything.

## Feature diagram

```mermaid
flowchart LR
  Client[Operator or API client] -->|GET /api/v1/work-graphs/{id}/report| Handler[orchestration_api.go]
  Handler --> Visibility{Objective visible and repository access?}
  Visibility -->|No: 404| NotFound[Not found]
  Visibility -->|Yes| Graphs[(work-graphs.json<br/>graph and messages)]
  Visibility -->|Yes| Runs[(agent-runs.json<br/>runs, attempts, usage)]
  Graphs --> Compute[work_graph_report.go<br/>pure computation]
  Runs --> Compute
  Compute --> Response[JSON response]
  Compute -.->|no writes| ReadOnly[Stores unchanged]
```

## Behavior

- `GET /api/v1/work-graphs/{id}/report` returns a report from durable records only. It never reconciles or persists.
  An unknown graph id or a graph the caller may not read returns 404.
- Top-level `graph_id`, `objective_id`, `objective_title`, `plan_revision`, and `status` identify the graph and its
  objective and report the graph's plan revision and status.
- Top-level `units` is an array. Each unit has `key`, `kind`, `agent_name`, and `state`; `candidate` and `verdict` are
  omitted when empty; `run_ids` is always an array. `attempts` sums the `attempts` counter of its runs. A run id
  without a stored run adds nothing. `providers` is always an array of sorted distinct strings, each containing the
  run's provider and, when recorded, a space and its provider version.
- Top-level `measurements` contains:
  - `unit_count`: number of units.
  - `run_count`: number of all run ids, including ids without a stored run.
  - `attempt_count`: sum of unit attempt counts.
  - `failed_attempts`: finished attempts whose status is not `succeeded`.
  - `max_concurrency`: largest number of attempts overlapping in their half-open
    `[started_at, finished_at)` intervals. An unfinished attempt is open-ended.
  - `review_rounds`: number of run ids belonging to review units.
  - `findings`, `decisions_requested`, and `decisions_resolved`: counts of messages of type `finding`,
    `decision_request`, and `decision_resolution`, respectively.
  - `human_actions`: `decisions_resolved` plus one for the plan approval that created the graph.
  - `remediation_passes`: for each produce unit, each attempt after its first when a finding addressed to that unit
    was created between the previous attempt's start and its own start.
  - `input_tokens` and `output_tokens`: sums from runs that have usage. Both are omitted and listed in
    `measurements.unknown` when no run has usage.
  - `cost_usd`: sum from runs that reported a cost. It is omitted and listed in `measurements.unknown` when no run
    reported a cost.
  - `wall_clock_seconds`: elapsed time from graph creation to update, present only when status is `completed`;
    otherwise it is omitted and listed in `measurements.unknown`.
  - `unknown`: always a sorted array. It always contains `supervision_minutes`, which is never a field. Recorded
    values are not invented; unavailable measurements are omitted and listed here as specified above.
- Top-level `pull_request_url` is included when the integrate unit has one. Otherwise it is omitted and never listed
  in `measurements.unknown`.

## Verification

| Test | Proves |
|---|---|
| `TestWorkGraphReportMeasuresACompletedRun` | Measures a completed run. |
| `TestWorkGraphReportOmitsWhatWasNotRecorded` | Omits unrecorded measurements and lists them in `unknown`. |
| `TestWorkGraphReportIsHiddenFromOtherCallers` | A caller who may not read the graph receives no report. |

Command: `go test ./cmd/zenchron -run TestWorkGraphReport -count=1`
