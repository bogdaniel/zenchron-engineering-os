# Backend architecture and decisions

This records what the backend is after the autonomous-runtime work, why each existing component was kept, changed,
or deferred, and which parts of the private-cloud target are implemented versus still open. It supersedes the open
questions in the [architecture checkpoint](architecture-checkpoint.md) for the areas listed here. Feature behavior
lives in [Issue to pull request](../features/issue-to-pull-request.md),
[Worker enrollment and project access](../features/worker-enrollment-and-project-access.md),
[GitHub webhooks](../features/github-webhooks.md), and [Isolated worktrees](../features/isolated-worktrees.md).

## Shape

One Go module, two processes, one shared wire contract:

- `cmd/zenchron` is the control plane: a modular monolith that owns identity, authorization, GitHub, run state, and
  the dashboard API. It never touches a developer's filesystem or processes.
- `cmd/zenchron-worker` is the local worker: it owns checkouts, worktrees, provider processes, verification, commits,
  and pushes. It makes no authorization decisions beyond refusing work outside its own configuration.
- `internal/workerapi` is the only definition of what the two exchange.

```mermaid
flowchart LR
  subgraph Cloud["Private cloud (or loopback in development)"]
    UI[React dashboard]
    API[Go control plane]
    State[(JSON state files)]
    Access[[Access policy file + audit log]]
    UI -->|session cookie, /api/v1| API
    API --> State
    API --> Access
  end
  subgraph Dev["Developer machine or execution host"]
    Worker[zenchron-worker]
    Config[[Worker config]]
    Repo[(Git checkouts)]
    Trees[(Per-run worktrees)]
    Codex[Codex CLI]
    Claude[Claude Code CLI]
    Worker --> Config
    Worker --> Repo
    Worker --> Trees
    Guard[zenchron-worker guard]
    Worker -->|"worktree owner: lock + process record"| Guard
    Guard -->|"sandboxed, allowlisted environment"| Codex
    Guard -->|"sandboxed, allowlisted environment"| Claude
  end
  Worker -->|"outbound HTTPS only: heartbeat, claim, progress, result"| API
  API -->|"issues, pull requests, checks, reviews (App or token)"| GitHub[(GitHub API)]
  GitHub -->|"signed webhook: reviews, check runs"| API
  Worker -->|"git push of the run branch (local Git credentials)"| GitRemote[(GitHub Git remote)]
```

Nothing connects inward to a worker. The control plane holds the GitHub API credential; the worker holds Git push
credentials and the provider sign-ins. Neither side receives the other's secrets.

## Ownership

| Responsibility | Owner | Where |
|---|---|---|
| User identity (GitHub OAuth, sessions) | Control plane | `auth.go` |
| Worker identity, repository access for users and workers, administrators | Control plane | `access.go`, applied in `auth.go` |
| Grant management API and audit log | Control plane | `access_admin.go` |
| GitHub webhook intake, delivery idempotency, review and check observations | Control plane | `github_webhook.go` |
| Product, objective, workflow, agent profile definitions | Control plane | `products.go`, `objectives.go`, `workflows.go`, `agents.go` |
| GitHub provider integration | Control plane | `github*.go`, `github_delivery.go` |
| Worker registration and presence | Control plane | `workers.go` |
| Run orchestration, leases, attempts, persistence | Control plane | `agent_runs.go`, `agent_run_results.go`, `agent_run_progress.go` |
| Issue snapshot, pull-request status, review import | Control plane | `agent_run_issues.go`, `agent_reviews.go` |
| Checkout discovery and repository allowlist | Worker | `projects.go`, `verification.go` (`workerConfig`) |
| Worktree creation (only by the run pipeline), locking, cleanup | Worker | `worktrees.go` |
| Exclusive worktree ownership, process guard, process record | Worker | `worktree_owner.go`, `process_tree.go` |
| Provider sandbox rules, Codex self-test, process environment | Worker | `cli_confinement.go`, `cli_adapters.go`, `cli_provider.go` |
| Run execution pipeline | Worker | `agent_runner.go` |
| Agent execution: the CLI process runner and its two adapters, the only implementation | Worker | `cli_provider.go`, `cli_adapters.go` |
| Verification and evidence | Worker | `verification.go`, `agent_run_progress.go` |

## Identities and relationships

```mermaid
erDiagram
  USER ||--o{ REPOSITORY_GRANT : "may touch"
  USER ||--o{ WORKER : owns
  WORKER ||--o{ REPOSITORY_GRANT : "approved for"
  WORKER ||--o{ PROJECT : "reports checkout"
  REPOSITORY ||--o{ PROJECT : "checked out as"
  REPOSITORY ||--o{ REPOSITORY_GRANT : "granted by"
  PRODUCT }o--o{ PROJECT : groups
  AGENT_PROFILE ||--o{ RUN : "snapshotted into"
  PROJECT ||--o{ RUN : "executes in"
  WORKER ||--o{ RUN : "assigned"
  ISSUE |o--o{ RUN : "resolved by"
  RUN ||--|{ ATTEMPT : has
  RUN ||--|| WORKTREE : "one per run"
  RUN ||--|| BRANCH : "zenchron/agent-run/<run id>"
  RUN |o--o| PULL_REQUEST : publishes
  PULL_REQUEST }o--|| ISSUE : closes
```

- **Repository** is identified by its sanitized locator, for example `github.com/acme/api`. It is the unit of
  authorization.
- **Project** is one worker's checkout of a repository. Its id is derived from the worker id and the local path, which
  never leaves the worker.
- **Worker** has a stable id derived from its hostname and configuration directory, an owner, and approved repositories.
- **Run** stores its repository, issue number, worker, profile snapshot, provider and version, base commit, branch,
  result commit, verification, publication, pull request, and one record per attempt.
- **Organization** is not modeled. One control plane serves one organization; see the open items below.

## Data flow between modules

```mermaid
flowchart TB
  subgraph CP["cmd/zenchron (control plane)"]
    Auth["auth.go<br/>session, worker token, webhook bypass"] --> Access["access.go<br/>requestAccess for every request"]
    Admin["access_admin.go<br/>/api/v1/admin + audit"] --> Access
    Access --> Defs["products / objectives / workflows / agents"]
    Access --> Registry["workers.go<br/>workers, projects"]
    Access --> Runs["agent_runs*.go<br/>queue, lease, attempts, events"]
    Hook["github_webhook.go"] --> Runs
    Runs --> GH["github*.go<br/>issues, pull requests, checks, reviews"]
  end
  subgraph W["cmd/zenchron-worker"]
    Loop["main.go, commands.go<br/>heartbeat, claim"] --> Runner["agent_runner.go<br/>one attempt"]
    Runner --> Trees["worktrees.go"]
    Runner --> Owner["worktree_owner.go + process_tree.go"]
    Owner --> Provider["cli_provider.go + cli_adapters.go + cli_confinement.go"]
    Owner --> Verify["verification.go"]
    Runner --> Report["agent_run_progress.go<br/>events, redaction"]
  end
  API["internal/workerapi<br/>heartbeat, command, progress, result"]
  Loop <--> API
  Report --> API
  API <--> Registry
  API <--> Runs
```

## Crash, cancellation, and lease recovery

```mermaid
sequenceDiagram
  participant API as Control plane
  participant Worker as zenchron-worker
  participant Guard as guard (process group leader)
  participant CLI as Provider and its tool commands
  Worker->>API: claim (attempt N, lease 3 min)
  Worker->>Guard: start with liveness pipe, lock, process record
  Guard->>CLI: start provider (inherits the lock only)
  loop every 2 s
    Worker->>API: progress (renews lease, returns cancel flag)
  end
  loop every 0.5 s
    Guard->>Guard: record every descendant (pid, start time)
  end
  alt worker killed or crashed
    Guard->>CLI: liveness pipe closed: SIGTERM group, then SIGKILL every recorded process
    API->>API: lease expires: attempt N closed as lease_expired, run queued again (failed after 3 attempts)
    Worker->>API: restarted worker claims attempt N+1
    Worker->>Worker: kill survivors named in the record, take the lock, or fail the attempt
  else cancellation or time limit
    Worker->>Guard: SIGTERM to the guard only
    Guard->>CLI: SIGTERM group, SIGKILL recorded processes after the grace period
    Worker->>API: result cancelled or failed, partial diff kept
  else control plane restarted
    API->>API: running attempts are requeued at startup
    Worker->>API: next progress answered 409: worker stops the attempt and does not push
  end
```

## Decisions

| Component | Decision | Evidence and rationale | Consequence |
|---|---|---|---|
| Run queue, leases, attempt fencing (`agent_runs.go`) | KEEP, extend | Fencing by worker id and attempt already rejected stale and duplicate completions and had tests. | Extended with an attempt log, a single lease-expiry rule, and lease renewal on progress. |
| Duplicate lease-expiry logic at startup and at claim | REFACTOR | The same rule was written twice. | One `expireLease`; both paths use it. |
| Wire types defined separately in both binaries | REPLACE | `agentRunCommand` and the result body existed twice and could drift silently. | `internal/workerapi` is the single contract. Old and new binaries are not wire-compatible: the control plane rejects a heartbeat that still carries `agent_runtime_enabled`, so workers are upgraded together with it. |
| Cancellation polling endpoint and worker poller | REMOVE | A second channel that only carried one boolean, while long runs had no way to renew a three-minute lease. | One `progress` call renews the lease, carries events, and returns the cancel flag. `GET .../cancellation` is gone. |
| Two-minute run deadline | REPLACE | A real coding task cannot finish in two minutes; the first live runs took three to four. | Operator-configurable wall-clock, inactivity, tool-activity, and verification limits with named termination reasons. |
| Worker run function with ten positional result arguments | REFACTOR | The result could not grow to carry verification, usage, or reasons. | `agentRunner` with one `workerapi.AgentRunResult`. |
| Chat-completions tool loop (`openai.go`, `agent_tools.go`) | REMOVE | Codex and Claude own their reasoning and tool loops, so this was a second, weaker agent implementation kept only for the dashboard E2E suite. No product requirement needs direct-API execution. | Deleted with `ZENCHRON_LLM_BASE_URL`, `ZENCHRON_LLM_API_KEY`, the heartbeat's `agent_runtime_enabled`, and the `runExecutor` interface. The CLI process runner is the only execution path; E2E drives it through a fake `codex` in `dashboard/e2e/fake-cli`. A run for a profile whose provider is not `codex-cli` or `claude-code` is refused with 409. |
| Worktree manager (`worktrees.go`, worker) | KEEP, strengthen | Idempotent preparation and ref validation were sound. | Active worktrees are locked with `git worktree lock`; `cleanup-worktrees` removes only clean, unlocked ones. |
| Standalone worktree request queue (`worktrees.go`, control plane) | REMOVE | It was a second durable queue with its own claim, lease, fencing, expiry and cancel, and a worktree prepared through it could be used by nothing: every run creates its own. | The `/api/v1/worktrees` and `/api/v1/workers/{id}/worktrees` routes are gone and `worktrees.json` in a data directory is no longer read. The agent-run store is the only lease and fencing implementation; the worker's run pipeline is the only caller of `prepareWorktree`. Projects lists a checkout's run branches instead. |
| GitHub client and App authentication | KEEP, extend | Token minting, bounded responses, and create-or-reuse pull requests were correct. | Added issue comments, issue creation, check runs, and reviews in `github_delivery.go`. |
| Matching review feedback to a run by parsing the branch name | REPLACE | The checkpoint itself warned against relationships built on guessed branch names. | Runs are found by stored repository and pull-request number. |
| Three copies of the "local client only" guard on GitHub writes | REFACTOR | Copy-pasted guard; it also made GitHub writes impossible from a hosted dashboard. | One check that admits a loopback client or a caller authorized by an enforced access policy. |
| Shared worker token | REPLACE for hosted use | Any holder could act as any worker id. | Per-worker hashed tokens bound to an id in the access file. The shared token works only on a loopback listener. |
| Username allowlist as the only authorization | REFACTOR | Hiding projects in the UI is not authorization. | Server-side repository grants for users and workers, enforced in every project- and run-scoped handler. |
| Operator-edited access file as the only way to change grants | REFACTOR | No audit record and no rotation; every change needed host access. | The file stays the single policy store, re-read per request. `access_admin.go` changes it through an admin-only API, appends an audit record per change, and rotates worker tokens with an overlap. A database table was rejected for now: it would add a second store for one small document. |
| Provider process group as the only process control | REPLACE | A provider outlived a killed worker's guard, Codex tool commands leave the group, and a second attempt could start beside them. | `worktreeOwner`: an inherited lock per worktree, a guard that records every descendant, and a next attempt that kills recorded survivors or fails closed. Verification runs under it too. |
| Provider environment as a denylist of known secret names | REPLACE | Any secret under an unlisted name reached the agent and could end up in a pull-request body. | An allowlist of inherited names plus the operator's per-repository `environment`. |
| Sandbox rules denying only the current home directory | REFACTOR | `/Users/Shared`, other checkouts outside the home directory, and other runs' worktrees were readable. | Both providers get one list of confidential roots; Codex is ready only after a sandbox self-test; Claude Code's shell needs its sandbox backend and fails closed. |
| Worker Git commands with the repository's hooks enabled | REFACTOR | A hook in the working tree would run unsandboxed during the worker's commit. | One `gitCommand` constructor disables hooks for every worker Git call. |
| Review feedback imported only on request (`sync-reviews`) | KEEP, extend | The import and its trust rules were sound; only the trigger was manual. | `github_webhook.go` reuses the same import for signed deliveries and stores check runs; `sync-reviews` stays as the fallback. |
| JSON snapshot persistence | KEEP for now | Atomic writes, strict decoding, and size caps are in place; one control-plane process per data directory. | Run events are stored beside runs. A database is required before multiple control-plane replicas; see open items. |
| Objectives, workflows, products, agent profiles | KEEP, scope | Not on the issue-to-pull-request path, but they were readable and writable by every signed-in user. The workflow canvas still does not execute. | Records carry their creator. Products follow their repositories and objectives their product; profiles and workflows are readable by all and changed by creator or administrator. |
| Skipping the commit when the diff exceeded the 128 KiB display cap | REMOVE | The cap bounds what the dashboard stores, not what an agent may deliver. | Large changes are committed and published; the stored diff is marked truncated. |

## Local versus private-cloud operation

| Concern | Loopback development | Private cloud |
|---|---|---|
| Listener | `127.0.0.1`, no authentication required | Non-loopback requires GitHub sign-in, HTTPS public URL, and `ZENCHRON_ACCESS_FILE` |
| Worker authentication | None, or the shared `ZENCHRON_WORKER_TOKEN` | Per-worker token bound to its enrolled id |
| Project access | Everything visible | Repository grants per user and per worker |
| GitHub writes | Loopback clients | Callers authorized for the repository |
| Grants | None | Admin API with audit log; worker tokens rotated with a 24-hour overlap |
| GitHub feedback | `sync-reviews` on request | Signed webhook, with `sync-reviews` as fallback |
| State | Local JSON files | Same files on one instance; not yet replicated |

## Not implemented

These are required before the control plane is offered to more than one organization or run as more than one
instance. None of them is claimed as working.

- Organizations and teams; one control plane serves one organization with two roles, administrator and developer.
- Database-backed state, multiple control-plane replicas, and retention policy for runs, diffs, events, and the audit
  log. The access policy is one file with one writer.
- A list of active user sessions and single-session revocation; removing a user from the policy ends all of theirs.
- Mutual TLS or automatic rotation for worker tokens; rotation is an administrator's action.
- Per-repository GitHub App installations (one installation per control plane today).
- Sandboxing of verification commands; they run the repository's code with the worker user's permissions.
- Remediation started by a failed check; checks are stored as evidence only.
- Worker auto-update, Windows process isolation, and Gemini or other providers. A provider needs a CLI adapter;
  there is no direct-API execution path.
