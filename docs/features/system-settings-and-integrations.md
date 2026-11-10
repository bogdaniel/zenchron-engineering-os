# Settings and integrations

The dashboard exposes separate Integrations and Settings routes over one system-status view. Integrations shows the
live API, worker, local-checkout, Git provider, and worker-side OpenAI-compatible endpoint state. The mockup's profile,
policy, permission, budget, notification, and audit panels are read-only status summaries; unavailable capabilities are
labelled instead of shown as configured. GitHub.com repositories support open issue and pull-request sync, plus
top-level pull-request comments and request-changes when a control-plane token has Pull requests write permission.
Workers that have not sent the endpoint-status field are shown as needing an update; their configuration is not guessed.
An unauthenticated localhost session at `/#integrations` uses the same dashboard shell with an illustrative Integrations mock.
Its category filters, connection switches, secret reveal labels, provider menus, and Add Integration flow update local preview
state only; they do not query protected provider settings or save changes. Audit log opens the fixture events and Import / Export
downloads those sample events as JSON. Preview-added providers use placeholder data.

## Feature diagram

```mermaid
flowchart LR
    Preview[Local unauthenticated Integrations state<br/>illustrative sample] -->|Local preview actions only| Mock[Integrations mock layout]
    Browser[Dashboard route] --> APIHealth[GET /healthz]
    Browser --> Workers[GET /api/v1/workers]
    Browser --> Projects[GET /api/v1/projects]
    Worker[Local worker] -->|Heartbeat: endpoint availability boolean only| Workers
    APIHealth --> Integrations[Runtime connection cards]
    Workers --> Integrations
    Projects --> Integrations
    Integrations --> Model[OpenAI-compatible endpoint status]
    Integrations --> GitHub[GitHub.com issue and PR sync]
    GitHub --> PRReview[PR comments and request-changes with token]
    Integrations --> Boundaries[Read-only settings status panels]
    Boundaries --> Secrets[Credentials stay on API and worker]
    Boundaries --> Missing[Policies, roles, budgets, notifications, audit: unavailable]
    Settings[Settings route] --> Boundary[Local or GitHub OAuth API access; JSON snapshots]
    Settings --> Access[OAuth username allowlist; organization roles unavailable]
    Settings --> Audit[Actor audit and run evidence: unavailable]
```

## Authority and empty states

- API and worker status reuse the overview's live TanStack Query results; the page does not create a second data source.
- A sanitized `github.com/owner/repository` locator enables issue and PR sync in Reviews. PR review submission requires
  control-plane GitHub authentication with Pull requests write permission; GitHub records the app or token actor. The
  dashboard session identifies an allowlisted OAuth user, but organization roles are not enforced.
- The worker reports only whether its model endpoint is configured; the endpoint and credentials stay on that worker.
- Settings report the current API security configuration and versioned JSON state boundary. They do not expose write controls for
  settings the service cannot persist or enforce.
- The Integrations overview uses the mockup's configuration rail and settings-panel layout and the shared dashboard
  panel typography. Its rail uses icon-led category labels; connection status stays in the main cards instead of
  repeating in the navigation. The configuration rail filters provider groups or jumps to the related settings card.
  At tablet widths, the page title and status/actions stack so the system-health badge and
  provider status controls stay readable. The local preview supports filtering providers, toggling connection and
  notification/controller switches, revealing placeholder secret labels, adding a preview-only provider, and opening/exporting
  fixture audit events. Organization profile fields, policy/role/secret edits, and persistence remain unavailable without a
  backing API.
- GitHub App credentials or the `ZENCHRON_GITHUB_TOKEN` fallback are configured in the control-plane environment,
  never in the worker or dashboard. Public repository reads work without credentials; private reads and PR review
  submissions require repository permissions.

## Verification

The focused dashboard E2E test checks navigation to both routes, direct hash changes, live worker/check-out status,
integration layout, and unavailable states. Run it with:

```sh
cd dashboard && npm run test:e2e -- e2e/system.spec.ts --grep "settings and integrations"
```

`cd dashboard && npm run test:e2e -- e2e/integrations-preview.spec.ts` verifies the local mock uses frontend data
without protected reads or writes, checks category filtering, local connection updates, preview key labels, adding a
placeholder integration, and viewing/exporting audit fixture data, then checks provider link and badge visibility at desktop
and 682 px and keeps the Connected status dot vertically centered without badge/toggle overlap.
