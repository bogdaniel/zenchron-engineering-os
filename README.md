# Zenchron Engineering OS

Go control plane, local worker, and React dashboard for coordinating engineering work across Git projects.

## Run the local preview

Start the Go control plane, local worker, and live-reloading dashboard together from the repository root:

```sh
./dev.sh
```

Open <http://127.0.0.1:4173>. Keep dashboard port `4173` and control-plane/worker port `8080` for the latest-source
manual-review preview; focused tests use their own temporary ports. The preview stops all services when you press
Ctrl+C. Set `ZENCHRON_LISTEN_ADDR`, `ZENCHRON_DASHBOARD_PORT`, `ZENCHRON_PROJECTS_ROOT`, or `ZENCHRON_DATA_DIR`
before launch to change the local setup.

On a local address the dashboard opens in **Mock** mode, which shows the approved sample data and never writes to the
control plane. Choose **Live** in the sidebar, or open <http://127.0.0.1:4173/?mode=live>, to work with the control
plane's real data; `?mode=mock` returns to the sample data. Both modes render the same pages. On any other host the
dashboard is always Live and has no selector.

Agent runs execute through the Codex CLI or Claude Code installed and signed in on the worker machine (`codex login`,
`claude auth login`); the worker detects them at startup, and there is no model endpoint or API key to configure.
Agent profiles select one with provider `codex-cli` or `claude-code`; a profile with any other provider can be saved
but not run. A run reads repository data and, when `code.write` is enabled in its profile, edits files on a per-run
isolated branch. Successful reviewable changes are committed locally; when a GitHub origin and control-plane GitHub
authentication are configured, the worker can push only that run branch and the control plane can create or reuse its
pull request. Runs can start from a GitHub issue, run the worker operator's verification commands, and open a linked
pull request; see [Issue to pull request](docs/features/issue-to-pull-request.md). Public GitHub repositories can be read without credentials. For
authenticated access, prefer a GitHub App installed only on the repositories Zenchron should control. Set
`ZENCHRON_GITHUB_APP_ID`, `ZENCHRON_GITHUB_INSTALLATION_ID`, and `ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH` on the control
plane; installation tokens are minted and cached there. Keep the PEM key outside the repository with owner-only file
permissions. Required permissions are Issues: read/write and Pull requests: read/write; Actions: read is needed for
GitHub Actions history in Reports. `ZENCHRON_GITHUB_TOKEN` remains available as a personal-token fallback and takes
precedence if both are set. Neither the worker nor dashboard receives GitHub API credentials.

Example for a local app installation:

```sh
export ZENCHRON_GITHUB_APP_ID="<app ID>"
export ZENCHRON_GITHUB_INSTALLATION_ID="<installation ID>"
export ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH="$HOME/.config/zenchron/github-app.pem"
chmod 600 "$ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH"
./dev.sh
```

On first run, install dashboard dependencies with `cd dashboard && npm ci`. The overview polls the Go service and
displays worker heartbeats and locally discovered Git checkouts. Set `ZENCHRON_PROJECTS_ROOT` before starting the worker
to scan a folder (default `.`).

The API listens on loopback by default; a remote listener requires the GitHub OAuth, allowlist, session, access-file,
and HTTPS public-origin configuration described in
[GitHub sign-in and remote worker authentication](docs/features/github-login-and-remote-worker-auth.md). Objective,
product, workflow, and agent profile data persist under
`<UserConfigDir>/zenchron`; set `ZENCHRON_DATA_DIR` to use another directory. Worker presence resets when the API
restarts. This snapshot store is single-process and capped at 16 MiB per file.

Feature docs:

- [Local worker presence](docs/features/local-worker-presence.md)
- [Control plane overview](docs/features/control-plane-overview.md)
- [Project inventory](docs/features/project-inventory.md)
- [Objective management](docs/features/objective-management.md)
- [Workflow Builder](docs/features/workflow-builder.md)
- [Review workspace](docs/features/review-workspace.md)
- [Agent profiles](docs/features/agent-profiles.md)
- [Agent run queue](docs/features/agent-run-queue.md)
- [Issue to pull request with Codex and Claude Code](docs/features/issue-to-pull-request.md)
- [Worker enrollment and project access](docs/features/worker-enrollment-and-project-access.md)
- [Isolated worktrees](docs/features/isolated-worktrees.md)
- [Settings and integrations](docs/features/system-settings-and-integrations.md)
- [Engineering reports](docs/features/engineering-reports.md)
- [Product workspace](docs/features/product-workspace.md)
- [One-command local preview](docs/features/local-preview.md)
- [GitHub issue sync and pull-request reviews](docs/features/github-review-sync.md)
- [GitHub webhooks: reviews and CI results](docs/features/github-webhooks.md)

See [One dashboard, two data modes](docs/architecture/dashboard-modes.md) for how Mock and Live share one layout, and
[Backend architecture and decisions](docs/architecture/backend-architecture.md) for component ownership, the
control-plane and worker boundary, and what is not implemented, and the
[Control plane roadmap](docs/architecture/roadmap.md) for delivery phases and acceptance evidence.

## Focused checks

```sh
test -z "$(gofmt -l $(git ls-files '*.go'))"
go vet ./...
python3 scripts/check_file_sizes.py
go test ./cmd/zenchron \
  -run 'TestWorkerHeartbeat|TestWorktree' \
  -count=1
go test ./cmd/zenchron-worker \
  -run 'TestSendHeartbeatUsesWorkerEndpoint|TestDiscoverProjects|TestRepositoryLocator|TestGitRemoteScrubsCredentials|TestPrepareWorktree|TestCLI|TestLongCommandKeepsWorkerPresenceAlive' \
  -count=1
(cd dashboard && npm run typecheck)
(cd dashboard && npm run test:e2e -- e2e/overview.spec.ts e2e/home.spec.ts \
  --grep 'dashboard displays|mobile overview|overview lists only agent runs|Projects page shows|agent run branches|Reviews page|workflow graph can be edited|Objectives dashboard fits|objectives can be created|agent profiles')
```

The browser checks use the same dashboard at `127.0.0.1:4173` as manual review; they do not launch a second dashboard
on another port. Focused control-plane checks may start an isolated API and worker on `8083`.
