# Zenchron Engineering OS

Go control plane, local worker, and React dashboard for coordinating engineering work across Git projects.

## Run the local preview

Start the Go control plane, local worker, and live-reloading dashboard together from the repository root:

```sh
./dev.sh
```

Open <http://127.0.0.1:4173>. The preview stops all three services when you press Ctrl+C. Set
`ZENCHRON_LISTEN_ADDR`, `ZENCHRON_DASHBOARD_PORT`, `ZENCHRON_PROJECTS_ROOT`, or `ZENCHRON_DATA_DIR` before launch to
change the local setup.

To enable queued agent runs, set an OpenAI-compatible Chat Completions endpoint before starting the preview. The
root `./dev.sh` passes these settings only to the local worker; the API and dashboard do not inherit the model key. Keep
the optional API key on the worker machine, use HTTPS for remote endpoints, and loopback HTTP for local models:

```sh
export ZENCHRON_LLM_BASE_URL="https://llm.example/v1"
export ZENCHRON_LLM_API_KEY="<worker-local key>"
./dev.sh
```

The first runtime can read repository data and, when `code.write` is enabled in a profile, write files on a per-run
isolated branch. Successful reviewable changes are committed locally; when a GitHub origin and control-plane token are
configured, the worker can push only that run branch and the control plane can create or reuse its pull request. Test
execution remains unavailable. Public GitHub repositories can be read without credentials. Private issue and pull-request reads need
the corresponding repository read permissions. To submit pull-request comments or request changes, set
`ZENCHRON_GITHUB_TOKEN` on the control plane with the repository's `Pull requests: write` permission; GitHub records
those reviews under the token owner. The dashboard never receives the token.

On first run, install dashboard dependencies with `cd dashboard && npm ci`. The overview polls the Go service and
displays worker heartbeats and locally discovered Git checkouts. Set `ZENCHRON_PROJECTS_ROOT` before starting the worker
to scan a folder (default `.`).

The API listens on loopback. Objective, product, workflow, and agent profile data persist under
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
- [Isolated worktrees](docs/features/isolated-worktrees.md)
- [Settings and integrations](docs/features/system-settings-and-integrations.md)
- [Engineering reports](docs/features/engineering-reports.md)
- [Product workspace](docs/features/product-workspace.md)
- [One-command local preview](docs/features/local-preview.md)
- [GitHub issue sync and pull-request reviews](docs/features/github-review-sync.md)

See [Control plane roadmap](docs/architecture/roadmap.md) for the system boundary, delivery phases, and acceptance
evidence.

## Focused checks

```sh
go test ./cmd/zenchron \
  -run 'TestWorkerHeartbeat|TestWorktree' \
  -count=1
go test ./cmd/zenchron-worker \
  -run 'TestSendHeartbeatUsesWorkerEndpoint|TestDiscoverProjects|TestRepositoryLocator|TestGitRemoteScrubsCredentials|TestPrepareWorktree|TestWorkerClaimsAgentRun|TestAgentRuntimeConfiguration|TestSafeRepositoryPath|TestLongCommandKeepsWorkerPresenceAlive' \
  -count=1
cd dashboard && npm run typecheck
cd dashboard && npm run test:e2e -- e2e/home.spec.ts \
  --grep 'dashboard displays|mobile overview|overview lists only agent runs|Projects page shows|worker prepares|Reviews page|workflow graph can be edited|Objectives dashboard fits|objectives can be created|agent profiles'
```

The focused browser check starts an isolated control plane, worker, and dashboard on ports 8081/4174 with temporary
state, so E2E mutations do not affect the live preview on 8080/4173.
