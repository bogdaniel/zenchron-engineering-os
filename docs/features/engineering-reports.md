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
    Actions --> CIHealth[CI success rate from completed conclusions]
    Scope[Time · product · owner · repository] --> Objectives
    Products --> Scope
    Scope --> Projects
    Scope --> Runs
    Scope -. workflow filter disabled until runs have workflow IDs .-> Workflows
    PRHistory --> OutcomeChart[Work outcomes · selected time range]
    Products --> ProductSummary[Product summary table]
    PRHistory --> ProductSummary
    WorkflowRunHistory --> ProductSummary
    Scope --> ProductSummary
    PRHistory --> WorkspaceSummary[Workspace delivery summary]
    WorkflowRunHistory --> WorkspaceSummary
    Objectives --> WorkspaceSummary
    Scope --> WorkspaceSummary
    Reviews[Provider review events] -. not available .-> Latency[Review latency]
    Usage[Model usage and run evidence] -. not available .-> Autonomy[Agent spend and autonomous completion]
    PRs -. not available .-> Autonomy
    Reports --> Snapshot[Scoped live snapshot]
    Snapshot --> ExecutiveCSV[Executive summary CSV]
    Snapshot --> MetricsCSV[Detailed metrics CSV]
    Snapshot --> WorkspaceCSV[Product and workspace CSV]
    Snapshot --> SpendCSV[Agent spend and utilization CSV]
    SpendCSV -. usage fields unavailable until provider data exists .-> Usage[Model usage records]
```

## Data rules

- Summary counts use named fields from the control-plane APIs and represent current snapshots, not historical trends.
- Time range filters objective creation and agent-run creation; invalid and future timestamps are excluded. Product filters use product repository links, owner filters apply to objectives, and repository filters apply to checkout and run records.
- The workflow selector stays disabled because agent-run records do not contain a workflow ID; the UI does not claim to filter data that has no workflow relationship.
- Desktop layout follows the supplied report mock's 3/4/3 panel rhythm: a report-scope toolbar and seven delivery/autonomy KPI cards; delivery velocity, CI duration, and work outcomes on the first chart row; review latency, agent spend, acceptance/autonomy, and data-driven insights on the second; then product summary, workspace summary, and CSV download panels. Metric chart legends stay visible when their source data is unavailable; Work outcomes shows an explicit status until complete PR history is available. Insights can be filtered by executive summary, delivery, execution, or objectives. KPI values use live source records when available and otherwise stay marked unavailable. Product summary shows linked GitHub delivery measures, while workspace summary uses the selected scope and objective count. When no products exist, the summary explains how many checkouts are available to group. The grid collapses at tablet and phone widths.
- Product summary rows use PR and GitHub Actions history attributed to unique supported GitHub remotes linked to each product. Velocity, cycle time, and acceptance rate follow the same formulas and completeness limits as the workspace KPIs; CI duration is the average of qualifying completed runs. Missing or incomplete history stays unavailable. The workspace summary applies the active report scope and counts objectives as work items. Autonomous completion remains unavailable because agent-run records do not record whether a person had to intervene. The Downloads panel offers executive summary, detailed metrics, agent spend/utilization, and product/workspace CSV files using the applied scope. The product/workspace export includes the same delivery metrics as the summary tables alongside repository and objective counts. Each row shows its format, report name, fully readable source detail, and download action at the shared dashboard text scale; long details wrap and the bottom row can grow at narrower desktop widths. The spend export includes scoped run records while marking spend and usage unavailable until provider usage records exist.
- The Insights & Narrative panel derives its statements and key takeaway from current scoped snapshots and GitHub PR history. The takeaway summarizes merged, closed-unmerged, and open PR counts when history is complete; otherwise it reports the source or completeness state. It does not infer status history or delivery trends from objective/run `updated_at`. Delivery source status reports missing remotes, unsupported remotes, provider errors, and incomplete history.
- The Work outcomes chart uses complete GitHub pull-request history and counts merged PRs by merge time, closed
  unmerged PRs by close time, and still-open PRs by creation time within the selected range. It does not infer review
  decisions from PR state. Incomplete history or a missing GitHub source produces an explicit status instead of a
  partial or fabricated chart.
- Agent-run counts use recorded queue records from the selected time range, including cancelled runs. The execution
  insight and export show success only for terminal succeeded or failed runs; queued, running, and cancelled records
  are not counted as successful work.
- Workflow and agent totals are definition counts; agent definitions do not imply agent execution.
- Delivery velocity, cycle time, and acceptance rate use actual GitHub pull-request history from configured GitHub
  checkouts. Velocity is merged PRs per week over the selected window, cycle time is average creation-to-merge hours,
  and acceptance rate is merged PRs divided by closed PRs in that window. The report endpoint pages by most recently
  updated PR, stops once the selected cutoff is covered, and marks history incomplete beyond 2,000 PRs per repository;
  incomplete histories do not produce metrics. Complete history with no merged PRs shows an explicit empty state instead
  of a blank chart. Duplicate checkouts for one GitHub remote are fetched once.
- CI duration uses completed GitHub Actions workflow runs created in the selected window from configured GitHub
  checkouts. It measures `updated_at - run_started_at`, excludes missing or invalid timestamps and non-completed runs,
  and only reports metrics when provider history is complete. The same history exposes conclusion values so the Overview
  can report the last-30-day completed-run success rate. Histories are capped at 1,000 runs per repository; larger
  histories are marked incomplete. The average is shown in the KPI and runs are grouped into minute ranges in the
  distribution chart. Complete history with no qualifying events shows an explicit empty state instead of a blank chart.
- Provider chart labels use the dashboard's light text palette so axes remain readable against the dark chart surface.
- KPI sparklines summarize the selected-window PR merge, PR cycle-time, PR acceptance, and completed Actions duration
  buckets. They are shown only when the underlying metric has events; unavailable measures do not get invented trends.
- Review latency, model spend, and autonomous completion remain unavailable until their corresponding provider and run
  records exist. Each metric group retains its mockup panel position and names the source needed to populate it. Empty
  chart panels retain a grid plot area and explain the missing connection instead of implying that the source was
  queried and returned no events.
- Work outcomes use Mantine Charts `DonutChart`, with its keyboard-accessible chart surface and tooltip; the adjacent
  legend repeats PR outcomes and counts for quick scanning. The inventory bars use Mantine `Progress`.

## Verification

The focused E2E test creates an objective and an agent run through the control-plane API, verifies the outcome chart
and data-derived insight panel, checks the desktop panel hierarchy, and verifies delivery metrics remain unavailable
without source data:

```sh
cd dashboard && npm run test:e2e -- e2e/home.spec.ts --grep "Reports page"
```

`cd dashboard && npm run test:e2e -- e2e/reports.spec.ts` checks date-window validation, product-scope apply/reset,
product counts, complete and truncated GitHub PR and Actions histories, derived delivery metrics, and all four downloaded
CSV reports against isolated API responses.
`cd dashboard && npm run test:e2e -- e2e/report-summary-metrics.spec.ts` checks per-product and workspace metric
attribution from distinct GitHub PR and Actions histories.
`GOCACHE=/tmp/zenchron-gocache go test ./cmd/zenchron -run 'TestGitHub(WorkflowRunHistory|PullRequestHistory)' -count=1`
checks both history endpoints' pagination, cutoffs, limits, and timestamp validation.
