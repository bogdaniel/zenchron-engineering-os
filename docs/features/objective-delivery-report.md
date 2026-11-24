# Objective delivery report

The Objective Workspace exposes the read-only delivery report for an approved WorkGraph. It summarizes only recorded
plan, unit, agent, handoff, review, decision, integration, publication, duration, usage, and failure evidence.

## Feature diagram

```mermaid
flowchart LR
  Client[Objective Workspace or API client] -->|"GET /api/v1/work-graphs/{id}/report"| Handler[orchestration_api.go]
  Handler --> Graphs[(work-graphs.json<br/>graph and messages)]
  Graphs --> Visibility{Objective visible and repository access?}
  Visibility -->|No: 404| NotFound[Not found]
  Visibility -->|Yes| Runs[(agent-runs.json<br/>runs, attempts, usage)]
  Worker[CLI worker] -->|PUT /api/v1/workers/{workerID}/agent-runs/{requestID}| ResultAPI[agent_run_results.go finish handler]
  ResultAPI -->|Validated result and attempt evidence| Runs
  Graphs --> Compute[work_graph_report.go<br/>pure computation]
  Runs --> Compute
  Compute --> Authority{Exact candidate has durable human authorization?}
  Authority -->|Yes| Recorded[Record actor, time, attempt, plan and graph revision, candidate SHA]
  Authority -->|No| UnknownAuthority[Publication authority remains unknown]
  Compute --> GitHub{Recorded PR URL matches graph repository?}
  GitHub -->|Yes: bounded read-only lookup| API[GitHub pull request API]
  GitHub -->|No or lookup unavailable| UnknownPR[Keep external PR state unknown]
  API -->|Validated state and head SHA| Compute
  Compute -->|GET /repos/{owner}/{repo}/commits/{sha}/check-runs| ChecksAPI[GitHub check runs API]
  ChecksAPI -->|Checks bound to the integrated SHA| Compute
  Compute --> Response[JSON response]
  Response --> ReportUI[ObjectiveDeliveryReport.tsx]
  ReportUI -->|Export JSON; revoke blob URL after download dispatch| Download[Typed report download]
  Compute -.->|no writes| ReadOnly[Stores unchanged]
```

## Behavior

- `GET /api/v1/work-graphs/{id}/report` returns a report from durable records plus a bounded, read-only GitHub lookup
  when a recorded canonical PR URL matches the graph repository. It never reconciles or persists. An unknown graph id
  or a graph the caller may not read returns 404.
- Top-level `graph_id`, `graph_revision`, `objective_id`, `objective_title`, `plan_revision`, and `status` identify the
  exact graph snapshot and its approved objective plan.
- Top-level `units` is an array. Each unit has `key`, `kind`, `agent_name`, and `state`; `candidate` and `verdict` are
  omitted when empty; `run_ids` is always an array. `attempts` sums the `attempts` counter of its runs. A run id
  without a stored run adds nothing. `providers` is always an array of sorted distinct strings, each containing the
  run's provider and, when recorded, a space and its provider version.
- `approved_plan` records the approved revision, content hash, summary, approver, and approval time. Workflow identity
  and version come from the compiled plan and graph. Each execution reports the recorded profile and persona IDs,
  names and versions, model from the frozen profile snapshot, provider, candidate commit and its Git tree SHA when
  reported, worker-reported verification, review verdict, publication state, PR link, attempts, and failures. Tree
  evidence is considered known only when the successful integration run's tree accompanies the selected candidate
  commit. Reviewer runs expose the exact base commit they inspected. Each run also names its accepted result attempt and
  last persisted update time; handoffs carry
  their immutable message ids, and GitHub checks carry their check-run ids. Verification belongs to that run; it
  is not an independent assurance record. `unknown_evidence` includes `policy_backed_assurance` because the current
  WorkGraph has no authoritative policy-backed assurance record bound to a candidate. `publication_authority` is
  recorded only when durable human authorization matches the integrated commit and approved plan revision/hash; it
  includes the graph revision, actor, time, attempt, and source run. Worker verification and green checks do not create or imply
  either fact. The Objective Workspace shows the authorization attempt beside its source run and revision binding.
  Handoffs, decisions and unresolved steps are shown from immutable WorkGraph messages and state.
- `unknown_evidence` names evidence the available sources cannot establish. Candidate tree SHA remains unknown until a
  successful integration run records it for the selected candidate. Publication authority remains unknown until an
  exact candidate-bound authorization is durably recorded. Current PR
  state is read from GitHub only when the recorded canonical PR URL matches the graph repository; unavailable or
  invalid responses leave it unknown. The report includes the observed state, draft/merged flags, head SHA, observation
  time, and whether the PR head matches the integrated candidate when one is recorded. GitHub checks are read by the
  exact integrated candidate SHA and include their own observation time; unavailable or mismatched check results stay
  unknown. This read does not change stored graph or run state.
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
  - `human_actions`: resolved decisions plus the recorded plan approval. `human_actions_complete` is false because
    the system does not record every human action.
  - `remediation_passes`: for each produce unit, each attempt after its first when a finding addressed to that unit
    was created between the previous attempt's start and its own start.
  - `input_tokens` and `output_tokens`: sums from runs that have usage; `runs_with_usage` shows coverage. Missing
    usage for some runs is listed in `measurements.unknown`.
  - `cost_usd`: sum from runs that reported a cost; `runs_with_cost` shows coverage. Missing cost for some runs is
    listed in `measurements.unknown`.
  - `wall_clock_seconds`: elapsed time from graph creation to update, present only when status is `completed`;
    otherwise it is omitted and listed in `measurements.unknown`.
  - `unknown`: always a sorted array. It includes unrecorded supervision duration and untracked human actions.
    Recorded values are not invented; unavailable or partial measurements are named here.
- Top-level `pull_request_url` is included when the integrate unit has one. Otherwise it is omitted and never listed
  in `measurements.unknown`.
- The dashboard labels WorkGraph execution status separately from the recorded pull-request link and observed GitHub
  state. A completed graph without a PR link is not presented as published; it shows the integrate unit's recorded
  reason and says execution completion does not establish publication. Publication authority remains unknown.
- Export JSON defers blob URL revocation by one second so browsers can start the download.

## Verification

| Test | Proves |
|---|---|
| `TestWorkGraphReportMeasuresACompletedRun` | Measures a completed run, reports GitHub PR state, detects head mismatch, keeps failed lookups unknown, and reconstructs the same durable report after reopening graph and run stores. |
| `TestWorkGraphReportOmitsWhatWasNotRecorded` | Omits unrecorded measurements and lists them in `unknown`. |
| `TestWorkGraphReportRequiresExplicitGitHubPRState` | Missing or malformed PR fields and candidate checks remain unknown; explicit false/null PR fields remain valid. |
| `TestWorkGraphReportIsHiddenFromOtherCallers` | A caller who may not read the graph receives no report. |
| `TestPlanPinsProfileConfigurationAndRejectsStaleApproval` | The approved report source keeps profile/persona versions through restart and edits. |

The Objective Workspace offers a typed JSON export. The browser validates its response shape before displaying or
exporting it; partial usage and human-action measurements remain explicitly qualified. The browser acceptance also
checks observed PR state, candidate-head mismatch, and publication authority separately from execution completion.

Commands: `go test ./cmd/zenchron -run 'TestWorkGraphReport|TestPlanPinsProfileConfiguration' -count=1`; the
focused Playwright acceptance lives in `dashboard/e2e/orchestration.spec.ts`.
