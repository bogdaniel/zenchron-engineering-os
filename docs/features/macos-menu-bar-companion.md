# macOS menu-bar companion

The native macOS companion attaches to the managed local installation. The macOS release builder includes the
ad-hoc-signed bundle in the verified release; the installer and updater place it at `~/Applications/Zenchron Menu
Bar.app` and open that stable path. It does not launch a second control plane, worker, dashboard, updater, or store.
One per-user lock limits the process to one visible status item.

## Feature diagram

```mermaid
flowchart LR
  Companion[Zenchron menu-bar app] -->|GET /api/v1/system/status · 15 s open/connected, otherwise 30 s| API[Managed control plane]
  LaunchAgent[Mode 0600 managed LaunchAgent plist] -->|Local status credential| Companion
  LaunchAgent -->|Credential fallback for older supervisor environments| API
  Companion -->|Local credential without OAuth or Keychain grant with OAuth · loopback only| API
  API -->|Typed health, dashboard, work, recorded usage and update projection| Companion
  API -->|Validate scoped grant, expiry, loopback and current admin policy| Auth[Existing session and access policy]
  Dashboard[Dashboard Settings] -->|POST /api/v1/system/status/credentials| Grants[(Hashed, expiring grant store)]
  Dashboard -->|GET /api/v1/system/status/credentials · DELETE /api/v1/system/status/credentials/{id}| Grants
  Dashboard -->|Display one-time credential after authenticated approval| Companion
  Grants -->|Append create/revoke audit record| Audit[(Status grant audit log)]
  API --> Workers[(Worker registry)]
  API --> Graphs[(WorkGraph store)]
  API --> Runs[(Retained agent-run records)]
  API --> Update[(Updater status file)]
  Companion -->|Open Dashboard| Browser[Canonical Live dashboard URL]
  Companion -->|Open Dashboard for access after 401 or 403| Browser
  Companion -->|Open selected objective and WorkGraph| Browser
  Companion -->|Open selected human decision| Browser
  Browser -->|GitHub sign in| OAuth[OAuth state bound to dashboard destination]
  OAuth -->|Validated same-origin return| Browser
  Companion -->|Start Zenchron| CLI[Canonical CLI start command]
  CLI -->|Kickstart and verify active release on /healthz and dashboard HTML| API
  CLI -->|Open only after both checks pass| Browser
  Source[Verified Darwin release] -->|Build and hash app bundle| Bundle[package-app.sh · ad-hoc signed bundle]
  Bundle -->|Install/replace at stable path and open| Companion
  Updater[Existing managed updater] -->|Reinstall candidate bundle before release pointer advances| Bundle
  Companion -->|Launch at Login · SMAppService| Settings[macOS Login Items]
```

## Behavior

- The menu reports control-plane connectivity and release revision, online worker count, provider readiness reported
  by online workers, active and blocked graphs,
  queued/running/waiting/failed units, pending decisions, and the recorded updater state. When available, it also
  shows the candidate revision and current progress; blocked or failed updates include the recorded reason.
- Usage totals come only from the retained agent-run records. The menu shows how many retained runs reported token
  usage and cost; missing provider data and totals that cannot be represented safely remain unknown. These are not
  all-time totals and do not estimate provider billing.
- Dashboard availability is reported from the installed release's regular `index.html` file. Missing or older-server
  availability evidence is shown as unavailable/unknown and degrades the icon rather than implying the dashboard is
  healthy.
- The menu-bar icon distinguishes connected/idle, active work, action required, updating, degraded, and disconnected
  states from those same API fields. Update failure or worker loss cannot display as a healthy idle icon.
- When work is active, the menu offers the five most recently updated active WorkGraphs. Each opens its exact
  objective plan in the existing Live dashboard. It also offers up to five most recently recorded unresolved human
  decisions, linked to their exact objective, graph, and decision in the existing plan view. Aggregate counts still
  cover all graphs; cancelled graph decisions remain in history but are excluded from pending-action counts.
- `GET /api/v1/system/status` is read-only and `no-store`. Without OAuth it uses the mode-0600 LaunchAgent credential.
  With OAuth, Dashboard Settings issues a random status-only grant to the signed-in user; only its hash is stored,
  the raw value is shown once, and create/revoke events are appended to an audit log. The companion stores the value
  in the macOS Keychain and sends it only in `X-Zenchron-Status-Grant`. The grant expires after one year and can be
  revoked in Settings. A grant works only over loopback and only for this status route. An enforced access policy
  requires the grant owner to remain an administrator; policy read errors deny status. Existing session/admin checks
  still govern dashboard APIs, and the local LaunchAgent credential never bypasses them.
- The menu distinguishes a missing session, expired/revoked pairing, missing administrator access, policy outage and
  local installation failure. It provides **Open Dashboard for access** and **Pair with Dashboard…** with errors that
  explain whether sign-in, pairing or policy repair is needed. When a selected dashboard deep link prompts for GitHub
  sign-in, OAuth returns to the same-origin page and mode after sign-in.
  Invalid or oversized selections are omitted so one bad value does not discard valid navigation; the server still
  validates the final return path and binds it to the OAuth flow.
- Cancelled WorkGraphs remain in history but their unresolved decisions are excluded from actionable status counts and
  menu links. Blocked WorkGraphs still expose unanswered decisions.
- **Open Dashboard** uses the canonical URL returned by the control plane, after validating its host and port.
- When disconnected, the menu shows the disconnected condition and offers **Start Zenchron**, which invokes the
  existing `~/.local/bin/zenchron-engineering start` command. The CLI opens the dashboard only after `/healthz`
  reports the current active release revision and the root page returns HTML without redirecting. The CLI refreshes
  the active revision during readiness polling, so an update that activates while it is waiting is accepted. A stopped,
  unhealthy, or unrelated service on port 8080 is not opened. Quit exits only the menu-bar process.
- A process lock prevents another companion instance for the same user from adding a second icon.
- **Launch at Login** is opt-in and uses `SMAppService.mainApp` from the stable app path. The menu reflects macOS
  registration state, directs approval-required cases to System Settings, and reports registration errors. It never
  starts or stops the engineering services. Repeated install/update opens resolve to the same app bundle ID; the
  process lock keeps one visible icon.
- macOS release builds run `package-app.sh`, include every bundle file in the release digest manifest, verify those
  files, and install the new bundle before the active release pointer advances. The existing managed supervisor
  remains the only updater; a running companion reconnects to its stable loopback API, and the supervisor opens the
  installed bundle after activation or recovery if no companion instance is already running.
- The app refreshes immediately on the macOS wake notification as well as after ordinary API interruption. CPU and
  memory are deferred because the current status projection does not reliably attribute those measurements to the
  managed Zenchron process group.
- The app polls every 15 seconds while its menu is open and connected, and every 30 seconds while closed or disconnected,
  so the visible icon can reflect loss of the local service without busy polling. Older network responses cannot
  overwrite a newer refresh.
  Decision rows include requester and decision ID so same-title decisions remain distinguishable.

## Build and run

Requires macOS 13 or newer and the Swift command-line tools:

```sh
swift test --package-path macos/ZenchronMenuBar
swift build -c release --package-path macos/ZenchronMenuBar
macos/ZenchronMenuBar/.build/release/zenchron-menubar
macos/ZenchronMenuBar/Scripts/package-app.sh "$HOME/Applications/builds"
open "$HOME/Applications/builds/Zenchron Menu Bar.app"
swiftc macos/ZenchronMenuBar/Sources/ZenchronStatusCore/SystemStatus.swift \
  macos/ZenchronMenuBar/Scripts/status-self-check.swift -o /tmp/zenchron-status-self-check
/tmp/zenchron-status-self-check
```

The package script refuses to overwrite an existing app bundle and ad-hoc signs the generated `.app`. Concurrent
packaging attempts can publish only one top-level bundle; a losing attempt reports the existing destination without
nested bundles. The managed installer installs it at the stable user-local path before registering Launch at Login.
Quit exits only the menu-bar process.

## Verification

- `go test ./cmd/zenchron -run 'TestMenuStatusGrant|TestStableMenuBarInstall' -count=1` checks admin denial, route
  scope, expiry, revocation, audit rollback, idempotent app install and replacement.
- `go test ./internal/updater -run 'TestVerifyReleaseBinds|TestBuildReleaseStages' -count=1` checks app bundle
  manifest digests and existing release staging.
- `cd dashboard && npm run test:e2e -- e2e/auth.spec.ts --grep 'one-time menu companion grant'` checks issuance,
  one-time display and revocation in the authenticated dashboard.
- The Mac package command above verifies bundle structure and the local ad-hoc signature. These checks do not prove
  menu interaction or managed service continuity; those need an installed Mac acceptance run.
- Local Mac acceptance on 2026-11-20 (macOS 27.2, arm64): the packaged app launched from its temporary package
  directory; process inspection found exactly one companion process, and its executable matched the packaged binary.
  Terminating that test process left the unavailable local backend unchanged. Port 8080 had no service. Screen capture
  and computer-use inspection were unavailable, so the visible icon and menu contents were not observed. This does not
  satisfy canonical-install acceptance.

## Release signing

The ad-hoc signature is for local packaging checks only. For distribution outside the Mac App Store, sign the app and
each executable with a **Developer ID Application** certificate, enable Hardened Runtime, include a secure timestamp,
and omit the `get-task-allow` entitlement. Submit the finished app or distribution archive with Apple's current
`notarytool`, review the notary log, wait for an accepted result, then staple and verify the ticket before release.
The current package script does not do those steps, and this repository has no verified notarized release. See Apple's
[Developer ID signing guidance](https://developer.apple.com/developer-id/),
[notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution),
and [Hardened Runtime guidance](https://developer.apple.com/documentation/security/hardened-runtime).

GitHub CI's macOS job runs Swift tests and packages the app. It does not exercise the menu UI, Login Items,
Developer ID signing, notarization, sleep/wake, or managed update/restart behavior.

## Limits

Functional pairing and managed bundle installation are implemented, but real acceptance must still run the installed
bundle against a canonical managed control plane and record dashboard/login-item/restart/sleep/wake/update behavior.
No Developer ID signature or notarization is present; those remain external distribution requirements. CPU and memory
remain deferred until accurately attributable. Token/cost telemetry is limited to available retained run records.
CI on non-macOS hosts does not exercise the menu UI.
