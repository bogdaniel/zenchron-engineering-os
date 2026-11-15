# Control plane overview

The overview dashboard is the live entry point for the local control plane. It follows the supplied Zenchron overview
mockup: workspace navigation, status metrics, workflow visualization, recent activity, plan approvals, run status,
evidence health, local branch reviews, timeline, and analytics. Control-plane health, workers, discovered projects,
objectives, workflow definitions, agent-run history, GitHub pull-request counts, and GitHub Actions health are backed
by current API/provider records. Budget, approvals, evidence, and timeline remain unavailable until their sources
exist. The page has one layout fed by one `OverviewSource`: **Mock** (`mockOverview`, the supplied screen fixtures,
local addresses only) or **Live** (`useLiveOverview`, the control plane); see
[One dashboard, two data modes](../architecture/dashboard-modes.md). Mock does not fetch protected dashboard records or
perform writes. The **Sign in** link opens `/#login`. The shared header page search keeps the mock’s rounded,
dark-gradient finish in both modes.

## Feature diagram

```mermaid
flowchart LR
    Browser[Desktop or mobile browser] --> Shell[Shared React app shell<br/>Navigation + type scale]
    Shell -->|sampleData = mode is mock| Dashboard[Single OverviewPage layout<br/>Mantine + Tabler]
    Dashboard -->|reads| Source{OverviewSource}
    Source -->|Mock| Fixtures[mockOverview<br/>overview-preview-data.tsx]
    Source -->|Live| LiveHook[useLiveOverview<br/>overviewView.tsx]
    Shell --> Theme[Shared Mantine theme<br/>Dark scheme · violet primary]
    Shell --> Pages[Objectives · Agents · Workflows<br/>Projects · Workspace · Reviews · Reports · Settings]
    Pages --> Heading[Shared PageHeading<br/>Eyebrow · title · description]
    Pages --> Metrics[Shared MetricCard<br/>Summary values and labels]
    Pages --> PanelHeading[Shared PanelHeading<br/>Panel + detail titles · descriptions · actions]
    Shell --> TypeScale[Shared CSS type scale<br/>Page title + panel heading tokens]
    Sample[Mock mode on a local address<br/>frontend sample data only] --> Fixtures
    Sample --> ObjectivesPreview[Objectives sample data<br/>KPI · table · details · milestones]
    Sample --> WorkflowPreview[Workflow Builder sample data<br/>Canvas · router settings · sample run timeline · phone run detail]
    Sample --> ReviewsPreview[Reviews sample data<br/>PR queue · diff · evidence summary]
    Sample --> ReportsPreview[Reports sample data<br/>metrics · charts · summaries]
    Sample --> IntegrationsPreview[Integrations sample data<br/>providers · policies · settings]
    Sample --> ProductWorkspacePreview[Product Workspace sample data<br/>roadmap · repositories · releases · decisions]
    LiveSources[Shell queries passed as props] -->|Live mode| LiveHook
    LiveHook -->|GET /api/v1/agent-runs/{id}/diff<br/>latest run with a diff| RunDiff[Local branch diff]
    RunDiff --> ReviewFrame[Code Review frame<br/>first changed lines · +/− totals]
    Dashboard -->|GET /healthz| Health[Go health endpoint]
    Dashboard --> MobileShortcuts[Mobile shortcuts<br/>Overview · My Work · Alerts]
    MobileShortcuts -->|My Work| Objectives
    MobileShortcuts -->|Alerts| Activity[Recent activity]
    Dashboard -->|GET /api/v1/workers<br/>every 5s| Workers[Worker status API]
    Dashboard -->|GET /api/v1/projects<br/>every 5s| Projects[Project inventory API]
    Dashboard -->|GET /api/v1/objectives| Objectives[Objective API]
    Dashboard -->|GET /api/v1/workflows| Workflows[Workflow API]
    Workflows -->|Saved definition| Graph[React Flow stage summary<br/>approved stage positions]
    Dashboard -->|GET /api/v1/agent-runs<br/>every 3s| Runs[Agent run API]
    Dashboard -->|GET /api/v1/projects/{id}/pull-request-history| PRHistory[GitHub PR history]
    Dashboard -->|GET /api/v1/projects/{id}/workflow-run-history<br/>last 30 days| ActionRuns[GitHub Actions history]
    PRHistory --> PRQueue[Open PR queue count<br/>all history · complete only]
    ActionRuns --> CIHealth[Completed-run success rate<br/>last 30 days · complete only]
    PRHistory --> DeliveryChart[Overview analytics<br/>merged PRs · cycle time · complete history only]
    ActionRuns --> DeliveryChart
    Worker[Local Go worker] -->|Heartbeat + checkout names/opaque IDs| Registry[(Transient worker registry)]
    Registry --> Workers
    Registry --> Projects
    Objectives --> ObjectiveState[(Versioned JSON snapshot)]
    Workflows --> WorkflowState[(Versioned JSON snapshot)]
    Runs --> RunState[(Versioned JSON snapshot)]
    Dashboard --> Empty[Budgets, approvals, evidence,<br/>timeline: not wired yet]
```

## Live data and empty states

- Control plane status comes from `GET /healthz`.
- Connected worker count and recent activity come from `GET /api/v1/workers`.
- Project inventory comes from `GET /api/v1/projects`; worker status and the sanitized Git `origin` locator are shown with each project. Local paths and remote credentials stay on the worker.
- Objective status is loaded from `GET /api/v1/objectives`.
- Running-agent count and the Agents/Overview run history come from `GET /api/v1/agent-runs`, polled every 3 seconds.
- The Overview PR queue count uses complete GitHub pull-request history across supported checkouts; incomplete or
  missing provider history stays unavailable. The CI health KPI is the share of completed GitHub Actions runs with a
  `success` conclusion in the last 30 days; its detail shows the passed and completed counts. Both reuse the Reports
  history endpoints and their completeness limits.
- Objectives and workflow definitions persist as versioned JSON snapshots; worker presence remains transient.
- Workflow definitions can be edited and saved on the Workflows page; workflow execution is not connected.
- The overview workflow panel summarizes the saved workflow definition as up to six stages drawn with React Flow at
  the approved stage positions. Its subtitle names the workflow and its status, its badge reads "Execution
  unavailable" while no workflow runner is connected, and the Workflow options menu states the component and
  connection counts. Stage completion marks appear only for the fixture run. The live worker and project remain
  visible in recent activity; the Projects page lists each checkout's agent run branches.
- Agent runs execute through the Codex or Claude Code CLI that the worker reports installed and signed in. The CLI
  edits only an isolated worktree; the worker captures a bounded diff and reports the result. A queued record alone
  does not mean a model ran; which coding CLIs are ready on online workers is visible in Settings.
- Reviews can inspect actual diffs from completed or partially completed agent runs, read open GitHub issues and pull
  requests, and load a bounded diff for a selected pull request. It can submit top-level PR comments and request changes
  using the configured control-plane token; provider approvals, checks, and merge remain unavailable.
- Overview analytics uses the same complete GitHub histories as Reports. Its metric menu switches between merged PRs
  and average cycle time over the available pull-request history and average CI duration over the last 30 days, and
  links to Reports. A metric with no records, an incomplete history, or a failed request shows an empty state with the
  reason. In Mock the same menu switches between illustrative views. All Activity opens a dialog with every item; the
  panel shows the first five.
- Budget usage, approval records, trusted-main and evidence health, and the sprint timeline do not have backend
  sources yet. Live shows "Unavailable", "Not configured", or an empty state with the reason in the same cards. The
  control plane keeps no history for objective or agent counts, so Live KPI cards carry a current figure in the badge
  and draw no sparkline or bars.
- Mock uses the same OverviewPage layout, populated from `mockOverview` and the sample avatar; it does not query
  protected records or perform writes. A failed Live request is reported in its card and never replaced by fixtures.
- The Code Review card shows the most recent agent run with a captured local diff in the design's review frame: its
  pull-request number or "Local diff", comment count, the number of reviewable diffs, run status, task, branches, the
  first changed lines from `GET /api/v1/agent-runs/{id}/diff`, and added/removed totals when the diff is not truncated.
  It links to the Reviews page for comments and request-changes; provider-sourced pull requests and issues appear in
  their own Reviews queues.
- Local branch runs and their diffs/comments are available in Reviews alongside provider-sourced open items.

## Responsive behavior

At desktop widths the overview uses a fixed left navigation rail, five summary cards with leading icons, a workflow/activity
row, four operational panels, and a three-panel delivery row. At the tall desktop mockup size, the first row stays 204px tall as
live events arrive; compact activity rows keep project and worker updates from pushing the lower panels down. The
operational panels show objective status, approval availability in the empty-state copy, run history, and trusted-branch/evidence availability.
At mobile widths the navigation becomes a five-item bottom tab bar (Home, Workflows, Agents, Reviews, and Profile); Profile uses a person icon while desktop Settings keeps its gear icon.
The overview keeps the four cards shown in the phone mock (objectives, agents, CI, and budget) in two columns, followed
by Recent Activity. Its compact view selector links to Overview, Objectives (My Work), and Recent Activity (Alerts).
Desktop-only operational panels stay off the mobile Overview; their full pages remain available from the bottom tabs.
The desktop greeting names the signed-in GitHub account and uses the overview mock’s subtitle; the phone view
uses its shorter mission subtitle. The compact header keeps notifications and hides disabled search/workspace
placeholders. Profile opens the existing Settings route.

The React app shell owns the navigation markup, 247px desktop rail matching the supplied mockups, and top bar; desktop navigation uses 16px medium-weight labels that stay on one line, and mobile switches the rail to a bottom tab bar. Mantine's shared theme uses a dark color scheme and violet primary actions. Page routes share `PageHeading` for the eyebrow, title, and description; `MetricCard` is reused for summary metrics and automatically compacts `Unavailable` values; `PanelHeading` supplies recurring panel and selected-detail headings, including the workspace directory and workflow editor sections, with shared title typography, descriptions, icons, and actions. Shared CSS tokens set page titles to 22px/650 on desktop and 20px on mobile; regular panel titles use 14px/600 on desktop and 13px/600 on mobile. Regular metric cards use 12px labels, 26px values, and 11px detail text on desktop, adjusting to 11px/21px/10px on mobile. The wide desktop Overview follows the supplied mock with 16px panel titles, 14px metric labels, and 30px metric values. Page components retain their own content layouts.

The one OverviewPage preserves the desktop mock's panel widths and vertical spacing at wide viewport heights. Code Review and Sprint Timeline both use the shared PanelCard and PanelHeading components, with their rendered title/icon gaps aligned despite the larger calendar glyph. In the workflow preview, a low-opacity glow spans the upper-left and top edge, fading toward the middle over the dotted dark surface; the play glyph stays centered and inside its circular icon, sample completion marks align with node titles, and connector glow stays restrained. The Sprint Timeline subtitle sits tightly below its title, date labels use the mock's brighter text color, its icon centers on the title at tall and compact desktop heights, and task bars align to their day columns. The Analytics metric keeps visible padding before its trend text. Mock and Live change the card data only; they do not select separate page markup or styling. Shorter windows scroll through the same layout instead of rearranging panels.

## Verification

`cd dashboard && npx playwright test e2e/overview-live.spec.ts` checks the Live Overview: control-plane records in
the approved panels, GitHub-backed PR queue, CI health and analytics, honest unavailable states, failed requests, no
write requests, and the phone summary.

`cd dashboard && npx playwright test e2e/overview.spec.ts` checks the wide-desktop Mock Overview, including workflow title/status alignment and glow, Analytics trend spacing, and Sprint Timeline heading and day-column alignment at 941px, 856px, and 749px desktop heights.

`cd dashboard && npm run test:e2e -- e2e/shell.spec.ts` checks shared page and panel title sizes across desktop and mobile routes. `cd dashboard && npm run test:e2e -- e2e/home.spec.ts --grep 'overview lists only agent runs'` verifies that the Code
Review frame features only a run with a captured diff and shows its numbered diff excerpt.
