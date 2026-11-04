# Engineering reports

The Reports route summarizes current objective state, saved workflow definitions, local worker inventory, repositories,
and agent runs. Delivery velocity, cycle time, and acceptance rate use GitHub PR history when a supported remote is
configured; the other delivery and usage measures remain unavailable until their provider evidence exists.

## Feature diagram

```mermaid
flowchart LR
    Reports[Reports route] --> Objectives[GET /api/v1/objectives]
    Reports --> Workflows[GET /api/v1/workflows]
    Reports --> Agents[GET /api/v1/agents]
    Reports --> Workers[GET /api/v1/workers]
    Reports --> Projects[GET /api/v1/projects]
    Reports --> Runs[GET /api/v1/agent-runs]
    Reports --> Products[GET /api/v1/products]
    Reports --> Health[GET /healthz]
    Reports --> PRHistory[GET /api/v1/projects/{id}/pull-request-history]
    Reports --> WorkflowRunHistory[GET /api/v1/projects/{id}/workflow-run-history]
    Health --> Insights[Insights and narrative]
    Workers --> Insights
    Projects --> Insights
    Objectives --> Insights
    Runs --> Insights
    PRHistory --> PRs[GitHub PR history]
    PRs --> Velocity[Delivery velocity and cycle time]
    PRs --> Acceptance[Acceptance rate]
    WorkflowRunHistory --> Actions[GitHub Actions workflow runs]
    Actions --> Duration[CI duration distribution]
    Scope[Time · product · owner · repository] --> Objectives
    Products --> Scope
    Scope --> Projects
    Scope --> Runs
    Scope -. workflow filter disabled until runs have workflow IDs .-> Workflows
    Runs --> OutcomeChart[Work outcomes · selected time range]
    Products --> ProductSummary[Product summary table]
    Scope --> ProductSummary
    Workflows --> Inventory[Current inventory bars]
    Agents --> Inventory
    Projects --> Inventory
    Workers --> Inventory
    Reviews[Provider review events] -. not available .-> Latency[Review latency]
    Usage[Model usage and run evidence] -. not available .-> Autonomy[Agent spend and autonomous completion]
    PRs -. not available .-> Autonomy
    Reports --> Snapshot[Scoped live snapshot]
    Snapshot --> CSV[Downloadable CSV report]
```

## Data rules

- Summary counts use named fields from the control-plane APIs and represent current snapshots, not historical trends.
- Time range filters objective creation and agent-run creation; invalid and future timestamps are excluded. Product filters use product repository links, owner filters apply to objectives, and repository filters apply to checkout and run records.
- The workflow selector stays disabled because agent-run records do not contain a workflow ID; the UI does not claim to filter data that has no workflow relationship.
- Desktop layout follows the supplied report mock's 3/4/3 panel rhythm: a report-scope toolbar and seven delivery/autonomy KPI cards; delivery velocity, CI duration, and work outcomes on the first chart row; review latency, agent spend, acceptance/autonomy, and data-driven insights on the second; then product summary, workspace inventory, and CSV download panels. KPI values use live source records when available and otherwise stay marked unavailable. Current objective, workflow, run, and checkout counts remain in the insights, product summary, and workspace inventory. The grid collapses at tablet and phone widths.
- Product summary rows join persisted product repository IDs to current scoped checkout, objective, and run records. Download CSV exports the scoped summary, product rows, and all seven KPI values; unsupported delivery measures remain explicitly unavailable.
- The Insights & Narrative panel derives its statements from current scoped snapshots and GitHub PR history. It does not infer status history or delivery trends from objective/run `updated_at`. Delivery source status reports missing remotes, unsupported remotes, provider errors, and incomplete history.
- Agent-run counts and status distribution use recorded queue records from the selected time range, including cancelled
  runs. Success rate includes only terminal succeeded or failed runs; queued, running, and cancelled records are not
  counted as successful work.
- Workflow and agent totals are definition counts; agent definitions do not imply agent execution.
- Delivery velocity, cycle time, and acceptance rate use actual GitHub pull-request history from configured GitHub
  checkouts. Velocity is merged PRs per week over the selected window, cycle time is average creation-to-merge hours,
  and acceptance rate is merged PRs divided by closed PRs in that window. The report endpoint pages by most recently
  updated PR, stops once the selected cutoff is covered, and marks history incomplete beyond 2,000 PRs per repository;
  incomplete histories do not produce metrics. Duplicate checkouts for one GitHub remote are fetched once.
- CI duration uses completed GitHub Actions workflow runs created in the selected window from configured GitHub
  checkouts. It measures `updated_at - run_started_at`, excludes missing or invalid timestamps and non-completed runs,
  and only reports metrics when provider history is complete. Histories are capped at 1,000 runs per repository; larger
  histories are marked incomplete. The average is shown in the KPI and runs are grouped into minute ranges in the
  distribution chart.
- Review latency, model spend, and autonomous completion remain unavailable until their corresponding provider and run
  records exist. Each metric group retains its mockup panel position and names the source needed to populate it. Empty
  chart panels retain a grid plot area and explain the missing connection instead of implying that the source was
  queried and returned no events.
- Work outcomes use Mantine Charts `DonutChart`, with its keyboard-accessible chart surface and tooltip; the adjacent
  legend repeats run statuses and counts for quick scanning. The inventory bars use Mantine `Progress`.

## Verification

The focused E2E test creates an objective and an agent run through the control-plane API, verifies the outcome chart
and data-derived insight panel, checks the desktop panel hierarchy, and verifies delivery metrics remain unavailable
without source data:

```sh
cd dashboard && npm run test:e2e -- e2e/home.spec.ts --grep "Reports page"
```

`cd dashboard && npm run test:e2e -- e2e/reports.spec.ts` checks date-window validation, product-scope apply/reset,
product counts, complete and truncated GitHub PR and Actions histories, derived delivery metrics, and downloaded CSV
contents against isolated API responses.
`GOCACHE=/tmp/zenchron-gocache go test ./cmd/zenchron -run 'TestGitHub(WorkflowRunHistory|PullRequestHistory)' -count=1`
checks both history endpoints' pagination, cutoffs, limits, and timestamp validation.
