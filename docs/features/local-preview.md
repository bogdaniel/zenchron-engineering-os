# Canonical managed installation and self-update

`go run ./cmd/zenchron install` bootstraps one user-local macOS LaunchAgent and the stable
`~/.local/bin/zenchron-engineering` command. The service owns one control plane, one worker, one dashboard URL
(`http://127.0.0.1:8080`) and one authoritative data directory. `./dev.sh` delegates to this installed command; it does
not start another application stack. Development and browser tests use isolated, short-lived fixtures on port 4174 and
API/worker port 8083.

Installation checks PATH before replacing an earlier command. It retires only executable binaries whose Go build
identity belongs to Zenchron Engineering or this repository, preserving a `.legacy` recovery copy before installing
the stable launcher. An unrelated command that would win PATH is left untouched and blocks installation with its path;
`zenchron-engineering doctor` reports the canonical entrypoint, resolved command, active revision and shadowing paths,
and verifies that the public launcher still targets the managed installation.
The installer never overwrites an arbitrary executable or changes adopted-controller authority records.

The dashboard has one React application. `?mode=mock` selects sample data; `?mode=live` selects the managed API.
After a trusted-main release activates, the open Live dashboard reloads the versioned dashboard bundle at its current
URL so its hash route, query mode, cookie session and persisted engineering state remain available.

## Update and activation

The managed supervisor polls the configured repository's `main` every five minutes and accepts only a full commit/tree
whose GitHub signature is verified, effective ruleset or branch-protection required checks succeed, and a merged PR
targets `main`. It fetches that exact revision into a temporary checkout under the installation directory, builds both
Go binaries and dashboard assets, records SHA-256 digests, and verifies the complete release manifest. It never reads or
changes the operator's source checkout or agent worktrees.

Before activation the supervisor checks state-schema and worker-protocol compatibility, pauses new run admission, and
waits for existing CLI attempts to finish. It stops the old worker before its control plane, then execs the candidate
supervisor with the old release pointer still authoritative. The candidate starts the control plane in admission-paused
mode, proves its HTTP identity, observes a matching worker heartbeat and serves the dashboard. Only after these checks
does it atomically advance `active-release`, reopen admission and persist success. An interrupted pre-proof activation
returns to the old release. If recovery fails after the active pointer advances, the supervisor persists a blocked
status. LaunchAgent may restart the supervisor, but it reads that marker and exits before starting either child; the
blocked state and pointer remain unchanged until operator recovery. Incompatible state or protocol versions stay
blocked before service shutdown.

The local `status` command and Settings / System Update page read the same persisted status record. The dashboard
reconnects to update progress, keeps Mock isolated from the API, and automatically reloads only after it observes a new
running revision.

## Feature diagram

```mermaid
sequenceDiagram
    participant I as Local installer
    participant C as Doctor command
    participant GH as Trusted GitHub main
    participant S as Managed supervisor
    participant R as Versioned release store
    participant CP as Control plane
    participant W as Local worker
    participant D as Settings System Update page
    participant DP as Dashboard dev/test proxy
    participant U as system-update.json
    participant A as agent-runs.json and in-memory admission
    I->>I: Validate canonical entrypoint and PATH without changing them
    C->>C: Resolve PATH and inspect shadowing commands
    C->>R: Verify the active release
    C->>C: Compare canonical launcher bytes with the managed template
    I->>R: Build and verify the initial trusted release
    I->>I: Retire recognized legacy shadows and install stable launcher
    I->>S: Install one stable command and one managed LaunchAgent
    GH->>S: New merged main revision
    S->>GH: Verify signature, required checks and merged PR
    S->>R: Fetch exact commit/tree and build isolated artifacts
    S->>S: Verify digests and protocol/state compatibility
    S->>CP: POST /api/v1/system/update/quiesce
    CP->>A: Close in-memory run admission
    loop Until safe boundary
        S->>CP: GET /api/v1/system/update/active-runs
        CP->>A: Recover expired leases and count running or publishing runs
        CP-->>S: Return active run count
    end
    S->>W: Stop old worker after attempts drain
    S->>CP: Stop old control plane
    S->>R: Keep old active pointer; exec candidate supervisor
    S->>CP: Start candidate admission-paused
    W->>CP: Report candidate revision and worker protocol
    S->>CP: GET /api/v1/system/update/worker-compatible
    CP-->>D: Serve the verified versioned dashboard
    S->>R: Atomically advance active pointer after health proof
    S->>CP: Reopen run admission and persist active status
    CP->>U: Write verified running revision
    D->>CP: GET /api/v1/system/update
    CP->>U: Read persisted update status
    U-->>CP: Return running revision and update state
    CP-->>D: Return verified running revision
    D->>D: Reload current URL to use the new dashboard bundle
    alt Dashboard uses the dev/test proxy
        D->>DP: POST /api/v1/system/update/check with loopback Origin
        DP->>DP: Rewrite same-origin loopback Origin only
        DP->>CP: Forward request with upstream Host and Origin
    else Installed dashboard
        D->>CP: POST /api/v1/system/update/check on operator request
    end
    CP->>S: Signal the existing managed supervisor
    opt Candidate recovery fails after pointer advancement
        S->>S: Persist blocked status and exit
        S->>S: LaunchAgent restarts supervisor
        S->>R: Read blocked marker without starting child processes
    end
```

The dashboard dev/test proxy rewrites `Origin` only when it matches the local `127.0.0.1` or `localhost` dashboard
origin; it forwards foreign and malformed origins unchanged so the control plane can reject them.

## Configuration and boundaries

GitHub authentication is required to inspect protected-branch/ruleset metadata and fetch private source. Prefer the
existing GitHub App configuration; credentials are stored in the per-user LaunchAgent environment and are not passed
to the worker or dashboard. The GitHub App needs repository metadata, contents, administration, commit statuses, and
check runs read access to verify branch protection and required checks. Keep the private key at an owner-only path
outside the repository.

The installation requires no root privileges, containers or external server. This implementation currently uses
macOS LaunchAgents. By default it reuses the existing `<UserConfigDir>/zenchron` durable state directory and keeps
immutable release artifacts in the separate `<UserConfigDir>/zenchron-installation` directory. An explicit
`ZENCHRON_DATA_DIR` is preserved in the managed service environment. The installed URL and data directory remain
stable across releases; a relative state path is resolved while installing so LaunchAgent's working directory cannot
redirect it. The active-release pointer is atomic; the active and previous release are retained for safe pre-activation
recovery. Mock and Live are UI data modes, not separate processes.

No auto-approval or auto-merge is performed. Manual Check for updates uses the same trust and activation path as the
periodic poll. An unavailable or unverifiable GitHub state leaves the currently running release in place and reports a
blocked reason.
The same failed candidate is not rebuilt on each poll: automatic retries resume when trusted `main` advances, while
the operator can use Check for updates to retry that exact revision.

## Acceptance status

Automated tests cover source verification, release staging, activation recovery, dashboard reconnection and restart
blocking. A managed LaunchAgent has not yet been observed updating itself after a trusted-main merge with durable
engineering work preserved. Keep #177 and #203 open until that installed-instance acceptance is demonstrated.
