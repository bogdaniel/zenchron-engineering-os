# Settings and integrations

The dashboard exposes separate Integrations and Settings routes over one system-status view. Integrations shows the
live API, worker, local-checkout, Git provider, and worker-side OpenAI-compatible endpoint state. The mockup's profile,
policy, permission, budget, notification, and audit panels are read-only status summaries; unavailable capabilities are
labelled instead of shown as configured. GitHub.com repositories support open issue and pull-request sync, plus
top-level pull-request comments and request-changes when a control-plane token has Pull requests write permission.
Workers that have not sent the endpoint-status field are shown as needing an update; their configuration is not guessed.

## Feature diagram

```mermaid
flowchart LR
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
    Settings[Settings route] --> Boundary[Loopback API and JSON snapshot boundary]
    Settings --> Access[Identity and authorization: unavailable]
    Settings --> Audit[Actor audit and run evidence: unavailable]
```

## Authority and empty states

- API and worker status reuse the overview's live TanStack Query results; the page does not create a second data source.
- A sanitized `github.com/owner/repository` locator enables issue and PR sync in Reviews. PR review submission requires
  control-plane GitHub authentication with Pull requests write permission; GitHub records the app or token actor because
  dashboard user identity and authorization are not implemented.
- The worker reports only whether its model endpoint is configured; the endpoint and credentials stay on that worker.
- Settings report the current loopback-only API and versioned JSON state boundary. They do not expose write controls for
  settings the service cannot persist or enforce.
- The Integrations overview uses the mockup's configuration rail and settings-panel layout, but keeps panels read-only
  where no backing API exists.
- GitHub App credentials or the `ZENCHRON_GITHUB_TOKEN` fallback are configured in the control-plane environment,
  never in the worker or dashboard. Public repository reads work without credentials; private reads and PR review
  submissions require repository permissions.

## Verification

The focused dashboard E2E test checks navigation to both routes, direct hash changes, live worker/check-out status,
integration layout, and the unavailable states. Run it with:

```sh
cd dashboard && npm run test:e2e -- e2e/system.spec.ts --grep "settings and integrations"
```
