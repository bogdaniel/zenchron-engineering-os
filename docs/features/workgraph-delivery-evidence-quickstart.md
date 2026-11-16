# WorkGraph delivery evidence quickstart

Use the WorkGraph delivery report to inspect what Zenchron has recorded for one graph. The report is a read-only API response built from stored graph and run data; the dashboard shows graph status in an objective's Plan tab, but does not display this report.

## Where to look

In the dashboard, open **Objectives**, select an objective, then open **Plan**. The Plan panel shows the current graph and its unit states. For the detailed delivery report, send an authenticated `GET /api/v1/work-graphs/{id}/report` request to the control plane, replacing `{id}` with the graph ID. The caller must be allowed to view the objective and access its repository; inaccessible and unknown graphs both return `404`. A worker credential cannot read this endpoint.

The endpoint reads the existing graph and stored runs without reconciling or persisting changes. Its fields describe recorded evidence, not a claim that all delivery data is complete.

## Interpret the response

| Field | What it reports |
|---|---|
| `graph_id`, `objective_id`, `objective_title`, `plan_revision`, `status` | Graph and objective identity, the plan revision used, and the graph's current status. |
| `units` | One entry per graph unit: `key`, `kind`, `agent_name`, `state`, `run_ids`, summed stored-run `attempts`, and sorted distinct `providers`. `candidate` and `verdict` appear only when recorded. Missing stored run records do not erase their IDs, but add no attempts or provider data. |
| `pull_request_url` | Included only when the integrate unit has a recorded URL. Its presence does not mean the pull request was merged. |
| `measurements` | Counts and optional measurements described below. |

### Counts recorded from graph and attempt history

These counts are computed from the graph and stored attempt records:

- `unit_count` counts graph units; `run_count` counts unit run IDs, including IDs whose run record is missing; `attempt_count` sums stored run attempt counters.
- `failed_attempts` counts finished attempts whose status is not `succeeded`. `max_concurrency` is the peak overlap of recorded attempts; unfinished attempts have no end time.
- `review_rounds` counts run IDs attached to review units. `findings`, `decisions_requested`, and `decisions_resolved` count graph messages of those types.
- `remediation_passes` counts a produce unit's later attempt when a finding addressed to it was created between the previous and current attempts' start times.
- `human_actions` is the number of resolved decisions plus one for the plan approval that created the graph. It is not a measure of time spent supervising work.

### Recorded, partial, and unknown values

- `input_tokens` and `output_tokens` are emitted when at least one stored run has usage data. They sum reported usage across runs that have it. If other runs have no usage record, their missing usage is not estimated and the response has no completeness marker: treat the totals as **partial**. If no run reports usage, both fields are omitted and listed in `measurements.unknown`.
- `cost_usd` sums cost values reported by runs. A reported cost of zero is still a recorded value. If only some runs report cost, the sum covers only those runs and has no completeness marker: treat it as **partial**. If no run reports cost, the field is omitted and listed in `unknown`.
- `wall_clock_seconds` is emitted only for a graph whose status is `completed`; it is the elapsed time from graph creation to its last update. For every other status, it is omitted and listed in `unknown`.
- `supervision_minutes` is always listed in `unknown`; the stored records do not measure how long a person supervised a run. It is never emitted as a value.
- `unknown` is a sorted list of unavailable measurements. An omitted measurement listed there is unknown, not zero. A numeric zero in an emitted field is a recorded zero.

The report does not claim provider costs are complete, and it does not establish human supervision time. A report can include a pull request URL, but it does not report merge status.

## Feature diagram

```mermaid
flowchart LR
  Operator[Operator] -->|Objectives, select objective, Plan tab| Dashboard[ObjectivePlanPanel and WorkGraphView]
  Dashboard -->|GET /api/v1/work-graphs| API[orchestration_api.go]
  Operator -->|Authenticated GET /api/v1/work-graphs/{id}/report| API
  API -->|visibility and repository access check| Access{Readable graph?}
  Access -->|No: 404| NotFound[Not found]
  Access -->|Yes| Graphs[(work-graphs.json)]
  Graphs -->|graph, units, messages| Report[work_graph_report.go]
  Runs[(agent-runs.json)] -->|stored runs and usage| Report
  Report -->|JSON response; no writes| Operator
```

## Related documentation

- [Objective orchestration](objective-orchestration.md) describes plan approval, graph lifecycle, units, and messages.
- [Objective delivery report](objective-delivery-report.md) documents the report fields and their computation in detail.

## Source checks

The endpoint and report calculations are implemented in `cmd/zenchron/orchestration_api.go` and `cmd/zenchron/work_graph_report.go`. The dashboard Plan path is implemented in `dashboard/src/ObjectiveDetail.tsx` and `dashboard/src/ObjectivePlanPanel.tsx`; live graph loading is in `dashboard/src/orchestration.ts`.

The existing focused API checks are `TestWorkGraphReportMeasuresACompletedRun`, `TestWorkGraphReportOmitsWhatWasNotRecorded`, and `TestWorkGraphReportIsHiddenFromOtherCallers` in `cmd/zenchron/work_graph_report_test.go`.
