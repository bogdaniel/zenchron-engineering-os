# Control plane overview

The overview dashboard is the live entry point for the local control plane. It follows the supplied Zenchron overview
mockup: workspace navigation, status metrics, workflow visualization, recent activity, plan approvals, run status,
evidence health, local branch reviews, timeline, and analytics. Control-plane health, workers, discovered projects,
objectives, workflow definitions, agent-run history, GitHub pull-request counts, and GitHub Actions health are backed
by current API/provider records. Budget, approvals, evidence, and timeline remain unavailable until their sources
exist. The local `?preview=mock` URL shows the supplied Overview mock content as clearly labeled sample data; it does
not fetch protected dashboard data or require a GitHub session.

## Feature diagram

```mermaid
flowchart LR
    Browser[Desktop or mobile browser] --> Shell[Shared React app shell<br/>Navigation + type scale]
    Shell --> Dashboard[Single OverviewPage layout<br/>Mantine + Tabler]
    Shell --> Theme[Shared Mantine theme<br/>Dark scheme · violet primary]
    Shell --> Pages[Objectives · Agents · Workflows<br/>Projects · Workspace · Reviews · Reports · Settings]
    Pages --> Heading[Shared PageHeading<br/>Eyebrow · title · description]
    Pages --> Metrics[Shared MetricCard<br/>Summary values and labels]
    Pages --> PanelHeading[Shared PanelHeading<br/>Panel + detail titles · descriptions · actions]
    Shell --> TypeScale[Shared CSS type scale<br/>Page title + panel heading tokens]
    Sample[Local ?preview=mock<br/>frontend sample data only] --> Dashboard
    LiveSources[Existing API and provider queries] -->|Live mode| Dashboard
    Dashboard -->|GET /healthz| Health[Go health endpoint]
    Dashboard --> MobileShortcuts[Mobile shortcuts<br/>Overview · My Work · Alerts]
    MobileShortcuts -->|My Work| Objectives
    MobileShortcuts -->|Alerts| Activity[Recent activity]
    Dashboard -->|GET /api/v1/workers<br/>every 5s| Workers[Worker status API]
    Dashboard -->|GET /api/v1/projects<br/>every 5s| Projects[Project inventory API]
    Dashboard -->|GET /api/v1/objectives| Objectives[Objective API]
    Dashboard -->|GET /api/v1/workflows| Workflows[Workflow API]
    Workflows -->|Saved definition| Graph[React Flow + ELK graph]
    Dashboard -->|GET /api/v1/agent-runs<br/>every 3s| Runs[Agent run API]
    Dashboard -->|GET /api/v1/projects/{id}/pull-request-history| PRHistory[GitHub PR history]
    Dashboard -->|GET /api/v1/projects/{id}/workflow-run-history<br/>last 30 days| ActionRuns[GitHub Actions history]
    PRHistory --> PRQueue[Open PR queue count<br/>all history · complete only]
    ActionRuns --> CIHealth[Completed-run success rate<br/>last 30 days · complete only]
    PRHistory --> DeliveryChart[Overview delivery chart<br/>merged PRs · complete history only]
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
- The overview workflow panel renders the saved workflow definition with React Flow and ELK. It labels the graph as a
  definition and states that execution is unavailable while no workflow runner is connected. The live worker and project
  remain visible in recent activity; the Projects page can prepare an isolated worktree separately.
- Agent runs execute through an OpenAI-compatible Chat Completions endpoint when the worker has
  `ZENCHRON_LLM_BASE_URL` configured. The worker edits only an isolated worktree, captures a bounded diff, and reports
  the result. A queued record alone does not mean a model ran; the configured runtime state is visible in Settings.
- Reviews can inspect actual diffs from completed or partially completed agent runs, read open GitHub issues and pull
  requests, and load a bounded diff for a selected pull request. It can submit top-level PR comments and request changes
  using the configured control-plane token; provider approvals, checks, and merge remain unavailable.
- Overview delivery analytics uses the same complete GitHub pull-request history as Reports and charts merged PRs over
  the available history. It shows an empty state when there are no merged records or the history is incomplete.
- Budget usage, approval records, evidence artifacts, and delivery timeline do not have backend sources yet. The live
  Overview uses unavailable or empty states instead of sample values.
- The local `?preview=mock` view uses the same OverviewPage layout as live mode, populated with labeled frontend sample
  content and the sample avatar. It does not query protected project, objective, agent-run, PR, or CI records.
- The overview Reviews card lists only agent runs with captured local diffs and links to the Reviews page for comments
  and request-changes; provider-sourced pull requests and issues appear in their own Reviews queues.
- Local branch runs and their diffs/comments are available in Reviews alongside provider-sourced open items.

## Responsive behavior

At desktop widths the overview uses a fixed left navigation rail, five summary cards with leading icons, a workflow/activity
row, four operational panels, and a three-panel delivery row. At the tall desktop mockup size, the first row stays 204px tall as
live events arrive; compact activity rows keep project and worker updates from pushing the lower panels down. The
operational panels show objective status, approval availability in the empty-state copy, run history, and trusted-branch/evidence availability.
At mobile widths the navigation becomes a five-item bottom tab bar (Home, Workflows, Agents, Reviews, and Profile).
The overview keeps the four cards shown in the phone mock (objectives, agents, CI, and budget) in two columns, followed
by Recent Activity. Its compact view selector links to Overview, Objectives (My Work), and Recent Activity (Alerts).
Desktop-only operational panels stay off the mobile Overview; their full pages remain available from the bottom tabs.
The desktop greeting names the signed-in GitHub account and uses the overview mock’s subtitle; the phone view
uses its shorter mission subtitle. The compact header keeps notifications and hides disabled search/workspace
placeholders. Profile opens the existing Settings route.

The React app shell owns the navigation markup, 247px desktop rail matching the supplied mockups, and top bar; desktop navigation uses 16px medium-weight labels that stay on one line, and mobile switches the rail to a bottom tab bar. Mantine's shared theme uses a dark color scheme and violet primary actions. Page routes share `PageHeading` for the eyebrow, title, and description; `MetricCard` is reused for summary metrics and automatically compacts `Unavailable` values; `PanelHeading` supplies recurring panel and selected-detail headings, including the workspace directory and workflow editor sections, with shared title typography, descriptions, icons, and actions. Shared CSS tokens set page titles to 22px/650 on desktop and 20px on mobile; regular panel titles use 14px/600 on desktop and 13px/600 on mobile. Regular metric cards use 12px labels, 26px values, and 11px detail text on desktop, adjusting to 11px/21px/10px on mobile. The wide desktop Overview follows the supplied mock with 16px panel titles, 14px metric labels, and 30px metric values. Page components retain their own content layouts.

The one OverviewPage preserves the desktop mock's panel widths and vertical spacing at wide viewport heights. Sample and live modes change the card data only; they do not select separate page markup. Shorter windows scroll through the same layout instead of rearranging panels.

## Verification

`cd dashboard && npm run test:e2e -- e2e/shell.spec.ts` checks shared page and panel title sizes across desktop and mobile routes. `cd dashboard && npm run test:e2e -- e2e/home.spec.ts --grep 'dashboard displays|Overview matches|mobile overview|overview lists only agent runs'`
verifies live control-plane health, desktop fit at the reference viewport, the connected worker and repository, the
five-item mobile tab bar, two-column status cards, and filtering the overview to runs with captured diffs.
