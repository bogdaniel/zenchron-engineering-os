# Canonical managed installation and self-update

`go run ./cmd/zenchron install` bootstraps one user-local macOS LaunchAgent and the stable
`~/.local/bin/zenchron-engineering` command. The service owns one control plane, one worker, one dashboard URL
(`http://127.0.0.1:8080`) and one authoritative data directory. `./dev.sh` delegates to this installed command; it does
not start another application stack. Development and browser tests use isolated, short-lived fixtures on port 4174 and
API/worker port 8083.

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
returns to the old release. Incompatible state or protocol versions stay blocked before service shutdown.

The local `status` command and Settings / System Update page read the same persisted status record. The dashboard
reconnects to update progress, keeps Mock isolated from the API, and automatically reloads only after it observes a new
running revision.

```mermaid
sequenceDiagram
    participant GH as Trusted GitHub main
    participant S as Managed supervisor
    participant R as Versioned release store
    participant CP as Control plane
    participant W as Local worker
    participant D as Existing dashboard tab
    GH->>S: New merged main revision
    S->>GH: Verify signature, required checks and merged PR
    S->>R: Fetch exact commit/tree and build isolated artifacts
    S->>S: Verify digests and protocol/state compatibility
    S->>CP: Pause new run admission and wait for active CLI attempts
    S->>W: Stop old worker after attempts drain
    S->>CP: Stop old control plane
    S->>R: Keep old active pointer; exec candidate supervisor
    S->>CP: Start candidate admission-paused
    W->>CP: Report candidate revision and worker protocol
    D->>CP: Reconnect and observe the new running revision
    CP-->>D: Serve the verified versioned dashboard
    S->>R: Atomically advance active pointer after health proof
    S->>CP: Reopen run admission and persist active status
    D->>D: Reload current URL to use the new dashboard bundle
```

## Configuration and boundaries

GitHub authentication is required to inspect protected-branch/ruleset metadata and fetch private source. Prefer the
existing GitHub App configuration; credentials are stored in the per-user LaunchAgent environment and are not passed
to the worker or dashboard. The GitHub App needs repository metadata/contents read access and permission to read commit
checks. Keep the private key at an owner-only path outside the repository.

The installation requires no root privileges, containers or external server. This implementation currently uses
macOS LaunchAgents. By default it reuses the existing `<UserConfigDir>/zenchron` durable state directory and keeps
immutable release artifacts in the separate `<UserConfigDir>/zenchron-installation` directory. An explicit
`ZENCHRON_DATA_DIR` is preserved in the managed service environment. The installed URL and data directory remain
stable across releases. The active-release pointer is atomic; the active and previous release are retained for safe
pre-activation recovery. Mock and Live are UI data modes, not separate processes.

No auto-approval or auto-merge is performed. Manual Check for updates uses the same trust and activation path as the
periodic poll. An unavailable or unverifiable GitHub state leaves the currently running release in place and reports a
blocked reason.
