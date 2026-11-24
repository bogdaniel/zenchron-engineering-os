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
The managed LaunchAgent sets `ExitTimeOut` to zero so launchd does not force-kill the supervisor while its graceful
shutdown is draining work.

`zenchron-engineering auth github-app configure --app-id ID --installation-id ID --private-key FILE` saves GitHub App
IDs and the copied PEM path in the existing owner-only LaunchAgent plist, copies the PEM into an owner-only file, and
requests a graceful restart of the existing LaunchAgent. It defers when active runs are present. Reinstall preserves
saved App settings over transient shell values; use `auth github-app configure` to change them. Self-update keeps the
LaunchAgent environment.
`auth github-app status` reports configuration, key readability, the active runtime's authentication method, and the
managed updater's latest verification as value-free categories. Verification requires a recent updater attempt from
the running supervisor with the same App ID, installation ID, and public-key identity saved in the LaunchAgent. A
personal access token taking precedence is reported separately and never counts as GitHub App verification. Repeating
`configure` retries a stale runtime using the active-run check and graceful restart; a concurrent service start is
never booted out.
`invalid_installation` covers failure to validate the local active release and GitHub rejecting the App
installation-token request. A `404` while reading the configured repository remains an updater-verification failure
because that response does not prove the installation ID is invalid. A `403` is reported as insufficient permissions.
Workers never receive GitHub App credentials.


### GitHub App permissions and safe configuration

For the current objective-to-PR workflow, grant these repository permissions to the GitHub App:

- **Contents: read** for the managed updater and private repository reads.
- **Pull requests: read and write** to inspect candidates and create pull requests.
- **Issues: read and write** for issue details and comments.
- **Actions: read**, **Checks: read**, and **Commit statuses: read** for delivery and updater verification.
- **Administration: read** when the updater must inspect classic branch protection rules; it does not need Administration write.
- **Metadata: read** is granted automatically and covers repository/ruleset metadata.

Install the App only on the updater repository and the repositories the operator intends to use. The worker pushes its candidate branch with the workstation's configured Git credentials; the App token does not go to workers. **Contents: write** is only needed for the separate App-mediated GitHub merge action. Do not grant it when the intended workflow stops at reviewed PR creation.

After this managed-installation change is integrated, configure the existing installation with the App ID, installation ID, and local PEM file path:

```sh
zenchron-engineering auth github-app configure --app-id ID --installation-id ID --private-key FILE
zenchron-engineering auth github-app status
```

Keep the PEM file local; never paste its contents into a command, issue, commit, log, or chat. When the supervisor is loaded, the configure command verifies that active runs are zero before changing settings; it refuses if that count cannot be verified or is nonzero, then requests the existing supervisor's graceful restart. Check the value-free status until the managed updater reports verified.


## Feature diagram

```mermaid
sequenceDiagram
    participant I as Local installer
    participant C as Doctor command
    participant O as Local operator
    participant G as Managed GitHub App command
    participant GH as Trusted GitHub main
    participant S as Managed supervisor
    participant R as Versioned release store
    participant CP as Control plane
    participant W as Local worker
    participant D as Settings System Update page
    participant DP as Dashboard dev/test proxy
    participant U as system-update.json
    participant A as agent-runs.json and in-memory admission
    O->>G: Configure App ID, installation ID and local PEM file
    G->>CP: GET /healthz and GET /api/v1/system/update/active-runs
    CP->>A: Read durable active runs
    CP-->>G: Return the active-run count
    G->>G: Validate, save IDs in the plist and copy the PEM outside releases
    alt LaunchAgent is loaded
        G->>S: launchctl bootout the existing definition (graceful SIGTERM drain)
        G->>S: launchctl bootstrap the saved plist
    else LaunchAgent is stopped
        G->>S: launchctl bootstrap the saved plist
    end
    S->>CP: Quiesce run admission and drain any work that raced setup
    S->>S: Gracefully drain and restart with the reloaded definition
    S->>S: Reload App settings after restart and self-update
    S->>GH: Verify trusted main using the managed App credentials
    G->>CP: GET /api/v1/system/update for updater result and runtime auth provenance
    CP->>U: Read persisted supervisor verification
    CP-->>G: Return value-free status categories
    G-->>O: Report configuration, key, installation, permission or updater state
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

GitHub authentication is required to inspect protected-branch/ruleset metadata and fetch private source. Configure the
existing GitHub App through `zenchron-engineering auth github-app configure`; App IDs and the managed key path are kept
in the existing owner-only LaunchAgent plist, and a copied private key is kept in an owner-only file under the managed
installation, outside the repository and versioned releases. The App settings are loaded by the existing supervisor
and control plane, and are not passed to the worker or dashboard. The local status credential grants only read access
to updater status and active-run count for local setup diagnostics; it does not bypass OAuth on the system-status
route or grant other API access. The GitHub App needs repository metadata, contents, commit statuses, check runs, and (when classic branch protection
is used) administration read access to verify branch protection and required checks. Administration write is not
needed. Pull requests read is needed to inspect candidates; write is additionally required only when the control plane
is authorized to create PRs.

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
