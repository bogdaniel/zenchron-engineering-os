# Isolated Git worktrees

Every agent run executes in its own Git worktree on its own branch. The worker's run pipeline is the only thing that
creates a worktree: there is no separate request to prepare one, and the dashboard cannot ask for one. The control
plane never sees a local path; it knows a run's branch name, and the Projects page lists a checkout's runs by that
branch.

Earlier versions had a standalone worktree request queue (`/api/v1/worktrees` and
`/api/v1/workers/{id}/worktrees/...`) with its own claim, lease, and cancel. It was removed because a worktree prepared
that way could be used by nothing. A `worktrees.json` file left in a data directory by such a version is no longer
read and can be deleted; no migration runs. A worker built before the removal still polls the removed claim route and
must be upgraded together with the control plane.

## Feature diagram

```mermaid
sequenceDiagram
    participant D as Dashboard (Projects, Agents, Reviews)
    participant C as Go control plane (agent-run store)
    participant W as Local worker (agentRunner)
    participant R as Local Git checkout
    participant T as Run worktree
    participant K as Worker cleanup command
    D->>C: POST /api/v1/agent-runs (agent, project, prompt or issue)
    C->>C: Persist queued run with branch zenchron/agent-run/<run id>
    W->>C: POST /api/v1/workers/{id}/agent-runs/claim
    C-->>W: Run command: id, project id, branch, base branch, attempt
    W->>T: Lock project lifecycle file for setup and owner claim
    W->>R: Validate branch; create or reattach the run branch at <root>/<project id>/<run id>
    R->>T: Create the branch or checkout retained branch after cleanup
    W->>T: Claim exclusive ownership (<worktree>.owner lock), stop leftovers of an earlier attempt
    W->>T: Verify the locked file is still the owner path; release lifecycle lock
    W->>R: git worktree lock (run in progress)
    W->>T: Run the coding CLI, verification, and commit inside the worktree
    W->>R: git worktree unlock
    W->>C: PUT /api/v1/workers/{id}/agent-runs/{run id} (result, attempt)
    D->>C: GET /api/v1/agent-runs
    C-->>D: Runs with branch, agent name, status; no local path
    K->>T: Lock the same stable project lifecycle file
    K->>T: Try exclusive .owner lock without waiting
    K->>R: git worktree remove, only when owner and Git locks permit
    K->>T: Remove .owner and .owner.processes after removal
    K->>T: Release project lifecycle lock
```

## Behavior

- **Ownership.** One run owns one worktree at `<worktree root>/<project id>/<run id>` on the branch
  `zenchron/agent-run/<run id>`, which is the only branch the worker accepts for that run. The root defaults to
  `<UserCacheDir>/zenchron/worktrees`; `ZENCHRON_WORKTREES_ROOT` selects another local directory. The source checkout
  and its branch stay in place.
- **Creation.** `prepareWorktree` is called only from the run pipeline. It validates the run branch and base branch
  with `git check-ref-format`, then runs `git worktree add`. A worktree that already exists on the run branch is
  reused, so a follow-up attempt (retry, or request-changes) continues in the same checkout. If cleanup removed the
  checkout, the worker reattaches the retained run branch; a destination on another branch is refused.
- **Verified base.** Before creating a new run branch from the product's base branch, the worker reads origin's
  default branch (`git ls-remote --symref origin HEAD`), fetches it into `refs/remotes/origin/<default>`, and
  refuses the run unless the local base commit equals it. Behind, ahead, and diverged all refuse, and so does a
  failed fetch or lookup: an unverified base never proceeds. The refusal names both commits and the manual recovery.
  Local branches are never moved. A run built on another run's branch inherits that run's verified base and is not
  re-checked. A checkout without an `origin` remote has nothing to compare against and is not checked.
- **Leases and fencing.** There is one implementation, the agent-run store: claim, three-minute lease renewed by
  progress reports, attempt number echoed by the result, expiry, attempt limit, and cancellation. See
  [Agent run queue](agent-run-queue.md).
- **Exclusive use.** Before any process starts, the attempt takes an advisory lock beside the worktree and stops
  processes an earlier attempt left behind; if something still holds the lock, the attempt fails instead of running
  next to it.
- **Lifecycle coordination.** Setup and cleanup share `<worktree root>/<project id>/.lifecycle.lock`. The worker holds
  it from before worktree preparation until it has acquired the owner lock and confirmed that the open file still
  matches `<worktree>.owner`. Cleanup holds it through worktree and sidecar removal. This stable file is kept in the
  project directory so deleting `.owner` cannot split ownership across two file inodes.
- **Locking.** While an attempt executes, the worktree is locked with `git worktree lock`. A worker that crashes
  leaves the lock in place.
- **Cleanup.** `zenchron-worker cleanup-worktrees` first takes each worktree's `.owner` lock without waiting, so a
  live attempt keeps its worktree and ownership files. It serializes with setup using the stable project lifecycle
  lock. Git then decides whether the unlocked worktree is clean and removable; locked or modified worktrees and
  their ownership files stay. After successful removal, cleanup removes `.owner` and `.owner.processes` and reports
  sidecar-removal errors. Errors from later projects are joined with earlier cleanup errors. Run branches and their
  commits are never removed.
- **Dashboard.** Projects shows, for the selected checkout, the branches of its agent runs with the agent name and
  run status, read from `GET /api/v1/agent-runs`. It has no control that creates a worktree. With an access policy,
  runs are visible only for repositories the user is granted.

## Verification

- `go test ./cmd/zenchron-worker -run 'TestPrepareWorktree' -count=1` covers real Git worktree creation, reuse on a
  repeated call and after cleanup, invalid-branch rejection, and the source checkout staying on its branch.
- `go test ./cmd/zenchron-worker -run 'TestCleanup|TestPrepareWorktree|TestStaleLease' -count=1` covers lifecycle
  coordination, stale owner descriptors, cleanup refusing live/Git-locked/modified worktrees, sidecar removal and
  error aggregation, and worktree reuse after cleanup.
- `go test ./cmd/zenchron -run 'TestRunLeaseRecoversAfterRestartAndFailsWhenAttemptsAreUsedUp|TestStaleAttemptCannotFinishOrReportAfterRunIsReclaimed|TestPersistentMuxRestoresObjectivesAndWorkflows' -count=1`
  covers the single lease implementation (restart recovery, stale-attempt rejection, attempt limit) and that a
  leftover `worktrees.json` is ignored and the removed route answers 404.
- `cd dashboard && npm run test:e2e -- e2e/home.spec.ts --grep "agent run branches"` checks the Projects list at
  1672×941 and 390×844: empty, populated (four rows shown, other checkouts' runs excluded), and failed-to-load states,
  without horizontal page scroll.
- `cd dashboard && npm run test:e2e -- e2e/z_agents.spec.ts --grep "worker events as evidence"` runs a real worker
  run and finds its branch in the Projects list.
