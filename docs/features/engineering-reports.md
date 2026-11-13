# Engineering reports

The Reports route summarizes current objective state, saved workflow definitions, local worker inventory, repositories,
and agent runs. Delivery velocity, cycle time, and acceptance rate use GitHub PR history when a supported remote is
configured, CI duration uses GitHub Actions history, and agent spend uses the cost providers report on agent runs;
review latency and autonomous completion remain unavailable until their evidence exists. The page has one layout, the
approved design, fed by `mockReports` (fixtures) in Mock and `useLiveReports` (control plane) in Live; see
`docs/architecture/dashboard-modes.md`.

## Feature diagram

```mermaid
flowchart LR
    Page[ReportsPage · reports.tsx<br/>one layout] -->|Mock| MockPreview[mockReports · reports-preview.tsx<br/>fixtures, no requests]
    Page -->|Live| Reports[useLiveReports · reportsView.tsx]
    Reports --> Objectives[GET /api/v1/objectives]
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
    Actions --> Duration[CI duration distribution and p50/p95]
    Actions --> CIHealth[CI success rate from completed conclusions]
    Scope[Time · product · owner · repository] --> Objectives
    Products --> Scope
    Scope --> Projects
    Scope --> Runs
    Scope -. live workflow filter disabled until runs have workflow IDs .-> Workflows
    Scope -. local preview fixture filter .-> MockPreview
    PRHistory --> OutcomeChart[Work outcomes · selected time range]
    Products --> ProductSummary[Product summary table]
    Projects -. no products configured .-> ProductSummary
    PRHistory --> ProductSummary
    WorkflowRunHistory --> ProductSummary
    Scope --> ProductSummary
    PRHistory --> WorkspaceSummary[Workspace delivery summary]
    WorkflowRunHistory --> WorkspaceSummary
    Objectives --> WorkspaceSummary
    Scope --> WorkspaceSummary
    Reviews[Provider review events] -. not available .-> Latency[Review latency]
    Runs -->|usage.cost_usd| Spend[Agent spend KPI and chart]
    Evidence[Completion evidence] -. not available .-> Autonomy[Autonomous completion]
    PRs -. not available .-> Autonomy
    Reports --> Snapshot[Scoped live snapshot]
    Snapshot --> ExecutiveCSV[Executive summary CSV]
    Snapshot --> MetricsCSV[Detailed metrics CSV]
    Snapshot --> WorkspaceCSV[Product and workspace CSV]
    Snapshot --> SpendCSV[Agent spend and utilization CSV]
    Runs -->|usage per run, Unavailable where absent| SpendCSV
```

## Data rules

- Summary counts use named fields from the control-plane APIs and represent current snapshots, not historical trends.
- Time range filters objective creation and agent-run creation; invalid and future timestamps are excluded. Product filters use product repository links, owner filters apply to objectives, and repository filters apply to checkout and run records.
- One layout serves both modes. Labels, class names, chart types, and responsive rules are the approved design's; only values, capabilities, and the reasons for missing data come from the source. The root carries `data-preview="mock"` in Mock.
- In Live the Workflow selector is disabled, with the reason as its accessible name and tooltip, because agent-run records do not contain a workflow ID. The Team selector lists objective owners. After Apply Filters a status line reads `Scope applied: …` (Mock: `Preview scope applied: …`). The local mock has explicit illustrative workflow-to-product and repository-to-product links, which scope its summary rows without making backend requests.
- The shared header search keeps the mock label `Search Zenchron…` on Reports while retaining the accessible name `Search pages`.
- Desktop layout follows the supplied report mock's panel proportions: a report-scope toolbar and seven delivery/autonomy KPI cards; delivery velocity, CI duration, and work outcomes on the first chart row; review latency, agent spend, acceptance/autonomy, and a narrower insights rail on the second; then product summary, workspace summary, and CSV download panels, with downloads directly beside the insights rail. The Insights heading uses the shared panel-title scale and keeps its filter readable. Metric chart legends stay visible when their source data is unavailable; Work outcomes shows an explicit status until complete PR history is available. Insights can be filtered by executive summary, delivery, execution, or objectives. KPI values use live source records when available and otherwise stay marked unavailable. Product summary shows linked GitHub delivery measures. If no products are configured but checkouts exist, it shows one `Unassigned repositories` row with delivery metrics aggregated from the scoped checkouts; exports label it the same way. With no checkouts, it explains how many are available to group. Workspace summary uses the selected scope and objective count. The grid collapses at tablet and phone widths.
- Mock (local addresses only) feeds the layout static sample values and does not query protected report APIs. Time range, product, team, workflow, and repository controls update local preview scope; Apply filters narrows Product and Workspace summary rows, and Reset restores all sample rows. The applied time range and workflow appear on the Work Outcomes heading. Other chart values remain the aggregate illustrative fixture. Preview downloads stay disabled because the current app has no local PDF/XLSX generator; each disabled control explains this. Live downloads are CSV and are enabled.
- In the local mock, delivery charts show point markers and axis labels for PRs per week and cycle time, with dates through Jan 28 and Jan 30. The Jan 30 cycle-time tooltip agrees with the 13.6 h KPI. Live draws the same shaded, dotted, axis-titled charts from provider history.
- The mock's delivery, review latency, agent spend, and acceptance/autonomy charts show all 11 date labels. The CI distribution labels both Runs and CI Duration (minutes), while its plot remains full height.
- Work Outcomes shows a caption inline in its heading: the selected workflow in Mock, `Pull requests · <range>` in Live. The total sits in the donut with its unit (`Work Items` in Mock, `Pull Requests` in Live).
- The sample review-latency chart uses the mock's labeled 0–20 hour axis for P50/P75 and expands to 0–25 hours for P95 so upper-tail sample points remain visible.
- At the 1672×941 mock viewport, the Insights panel has no subtitle and uses tight Insights and download typography/spacing so the takeaway and all four report cards remain inside their panels. Its 126px Insights selector shows the full selected value without clipping.
- The Insights panel highlights the lead finding with the mock's green callout, varies the finding icons by category, separates the remaining findings, and keeps the Key Takeaway heading inline with its text.
- Product and Workspace summary rows show a small icon beside the name: the mock's category icons on fixture rows, a product, repository, or workspace glyph on Live rows. Total rows exist only in the fixtures.
- At widths above 1600px, the report grid uses 24 proportional tracks to match the reference mock's wider delivery chart, narrower Insights rail, and compact Downloads panel. The preview keeps the Insights heading on one line and renders the Work Items donut label as HTML over the SVG chart. The 1201–1600px layout remains unchanged.
- At phone widths, Product Summary and Workspace Summary keep their columns readable in keyboard-focusable horizontal
  scroll regions; the page itself remains within the viewport width.
- Product summary rows use PR and GitHub Actions history attributed to unique supported GitHub remotes linked to each product. Velocity, cycle time, and acceptance rate follow the same formulas and completeness limits as the workspace KPIs; CI duration is the average of qualifying completed runs. Missing or incomplete history stays unavailable. The workspace summary applies the active report scope and counts objectives as work items. Autonomous completion remains unavailable because agent-run records do not record whether a person had to intervene. The Downloads panel offers executive summary, detailed metrics, agent spend/utilization, and product/workspace CSV files using the applied scope. The product/workspace export includes the same delivery metrics as the summary tables alongside repository and objective counts. Each row shows a 30px CSV file icon, a 12px report name, 10px source detail, and a 24px download action; details wrap and the bottom row can grow at narrower desktop widths. The spend export lists scoped run records with the cost and token usage the provider reported, and marks them unavailable on runs without a usage record.
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
  The distribution header shows nearest-rank p50 and p95 durations from the same scoped completed runs when samples exist.
- Provider chart labels use the dashboard's light text palette so axes remain readable against the dark chart surface.
- The CI distribution has labeled Runs and CI Duration (minutes) axes and no legend. Bars are colored in four bands by their share of the value scale: the fixed 0–2.5K scale in Mock, the tallest bucket in Live.
- Delivery Velocity/Cycle Time, Review Latency, and Acceptance/Autonomous Completion are shaded under their trend lines in both modes. Live Acceptance draws only the acceptance series and its legend reads `Autonomous completion · unavailable`.
- The Mock Agent Spend chart uses explicit currency ticks ($0K–$20K) and completion-rate ticks (40%–90%) to match the mock. Live sums `usage.cost_usd` of the scoped agent runs into the KPI (`$1.75`) and into bars per period (5, 7, or 12 periods, as the pull-request trend), with data-driven dollar ticks and no autonomy line. When no scoped run reports a cost, or runs are loading or failed to load, the KPI reads Unavailable and the plot gives the reason.
- KPI cards omit source descriptions; Delivery Velocity keeps its `PRs / week` unit as shown in the mock. Live values carry their unit (`42h`, `10m`, `67%`) and no trend delta, because no previous-period history is fetched.
- Scope and Insights selectors use the mock's single down-chevron indicator.
- The scope action is labelled `Apply Filters`, matching the supplied mock.
- KPI sparklines summarize the selected-window PR merge, PR cycle-time, PR acceptance, and completed Actions duration
  buckets. They are shown only when the underlying metric has events; unavailable measures do not get invented trends.
- Review latency and autonomous completion remain unavailable until their corresponding provider and run records
  exist. Each metric group retains its mockup panel, heading, and legend; the Review Latency percentile buttons are
  disabled with the reason. Empty chart panels retain a grid plot area and explain the missing connection instead of
  implying that the source was queried and returned no events. Live never draws a chart from constant arrays.
- Work outcomes use Mantine Charts `DonutChart`, with its keyboard-accessible chart surface and tooltip; the adjacent
  legend repeats PR outcomes and counts for quick scanning.

## Verification

The focused E2E test creates an objective and an agent run through the control-plane API, verifies the outcome chart
and data-derived insight panel, checks the desktop panel hierarchy, and verifies delivery metrics remain unavailable
without source data:

```sh
cd dashboard && npm run test:e2e -- e2e/home.spec.ts --grep "Reports page"
```

`cd dashboard && npm run test:e2e -- e2e/reports.spec.ts` checks date-window validation, product-scope apply/reset,
product counts, complete and truncated GitHub PR and Actions histories, derived delivery metrics, provider-reported
agent spend, the disabled and Unavailable parts of the frame, and all four downloaded CSV reports against isolated API
responses.
`cd dashboard && npm run test:e2e -- e2e/report-summary-metrics.spec.ts` checks per-product and workspace metric
attribution from distinct GitHub PR and Actions histories.
`cd dashboard && npm run test:e2e -- e2e/reports-preview.spec.ts` checks that the local mock route uses frontend fixtures
without protected reads or exports, verifies preview scope selection, apply, and reset behavior, and ensures the full
download descriptions wrap without truncation in the mock layout. It also checks the 0h–20h P50/P75 review-latency
axis and the 0h–25h P95 axis at desktop size, checks the Insights callout, icon colors, and inline takeaway, then
checks the preview row-icon counts, mock P50 ticks, and page width at phone size. The desktop check also guards the shared `Search Zenchron…` placeholder shown in the mock.
`GOCACHE=/tmp/zenchron-gocache go test ./cmd/zenchron -run 'TestGitHub(WorkflowRunHistory|PullRequestHistory)' -count=1`
checks both history endpoints' pagination, cutoffs, limits, and timestamp validation.
