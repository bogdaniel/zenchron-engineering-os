# Zenchron Engineering OS

Go control plane, local worker, and React dashboard for coordinating engineering work across Git projects.

## Install and run the canonical local application

Bootstrap the managed installation from a source checkout once:

```sh
go run ./cmd/zenchron install
```

The installer builds the exact eligible trusted-main revision into an immutable versioned release and registers one
per-user macOS LaunchAgent. The installed command is `~/.local/bin/zenchron-engineering`; on first install, use
`~/.local/bin/zenchron-engineering start` to open the stable dashboard at <http://127.0.0.1:8080/?mode=live> and
`zenchron-engineering status` to inspect the running revision and update state. Run `zenchron-engineering doctor` to
verify which PATH entry is active and whether it resolves to the current release. The service checks trusted GitHub main
every five minutes and updates itself after eligible merges. `./dev.sh` is only a convenience wrapper for that same
installed command; it does not start a source preview.

The one dashboard switches between **Mock** and **Live** at the same URL. Mock shows sample data and does not write to
the control plane. Live uses the managed control plane. When a release changes, the open dashboard reconnects to the
new release and reloads its verified UI while preserving the URL, page and browser session. Unmerged source changes do
not replace the installed application; use the short-lived isolated test fixtures for development checks.

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
permissions. Required permissions are Issues: read/write and Pull requests: read/write; Administration: read,
Commit statuses: read, and Checks: read are needed to verify trusted-main protection. Actions: read is needed for
GitHub Actions history in Reports. `ZENCHRON_GITHUB_TOKEN` remains available as a personal-token fallback and takes
precedence if both are set. Neither the worker nor dashboard receives GitHub API credentials.

Example for a local app installation:

```sh
export ZENCHRON_GITHUB_APP_ID="<app ID>"
export ZENCHRON_GITHUB_INSTALLATION_ID="<installation ID>"
export ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH="$HOME/.config/zenchron/github-app.pem"
chmod 600 "$ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH"
go run ./cmd/zenchron install
```

The installer requires Go, Git, Node/npm and access to the configured GitHub repository. Set `ZENCHRON_PROJECTS_ROOT`
before installation to choose the folder scanned by the worker (default the user's home directory). Development and
browser tests run against short-lived state and separate ports; they never use the managed application's port `8080`
or state directory.

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
- [Canonical managed installation and self-update](docs/features/local-preview.md)
- [GitHub issue sync and pull-request reviews](docs/features/github-review-sync.md)
- [GitHub webhooks: reviews and CI results](docs/features/github-webhooks.md)
- [Objective orchestration: plan, parallel agents, review, integration, one pull request](docs/features/objective-orchestration.md)
- [Objective delivery report](docs/features/objective-delivery-report.md)

See [One dashboard, two data modes](docs/architecture/dashboard-modes.md) for how Mock and Live share one layout, and
[Backend architecture and decisions](docs/architecture/backend-architecture.md) for component ownership, the
control-plane and worker boundary, and what is not implemented,
[Objective orchestration: architecture and decisions](docs/architecture/objective-orchestration.md) for plans,
WorkGraphs, typed messages, and integration, and the
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

The browser checks launch an isolated dashboard on `127.0.0.1:4174` and control plane/worker on `8083`; their state is
under `dashboard/.playwright-state`. They never connect to the managed instance on port `8080`.
