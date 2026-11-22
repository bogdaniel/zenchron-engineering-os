# Agent profiles

The Agents workspace stores reusable execution profiles: display name, description, provider and model identifiers,
system and goal prompts, enabled state, version, and a small allowlist of repository tools. The profile detail is
split into Overview, Prompts, Tools & Permissions, and Run History tabs. Version, run count, and success rate come from
stored profile and run data; model cost stays unavailable until provider usage is recorded. The profile list shows each
profile's latest run time and completed-run success rate from recorded run history. The profile overview also charts
successful, failed, and other run outcomes in rolling 24-hour buckets for the last 30 days; it shows an empty state
when that profile has no runs. Profiles persist in the
control-plane state directory and survive restart. The profile list searches saved names, descriptions, providers, and
model identifiers, and shows up to three allowed tool IDs with a count for any additional tools. The run dialog shows each online project's worker and its reported model-runtime readiness; missing
status stays unknown, and runs queued on a worker without a configured runtime remain queued. Provider identifiers
are labels only; credentials are not stored. Reusable personas define role, responsibilities, instructions, behavior
expectations, and review specialization. Profiles bind to personas by ID. The Agents page can create, edit, duplicate,
disable, and enable personas and shows the linked persona version on its profile. Persona responsibility line breaks
remain editable while typing; blank lines are omitted when the persona is saved. A persona does not grant tools:
profile tools and worker sandbox controls remain authoritative.

Filtering the profile list does not change the selected profile; its detail, unsaved edits, and Run Agent target stay
bound to that profile until the user selects another one.

The page has one layout in both data modes (see [One dashboard, two data modes](../architecture/dashboard-modes.md)).
The Overview tab shows the profile fields, 30-day performance, numbered prompt previews, Variables & Templates, Tool
Permissions, Safety & Governance, the three most recent runs, and a success, cost, and latency trend. In Live the
figures come from recorded runs: run count, completed-run success rate, average attempt duration, and the cost the
provider reported; a figure with no data reads Unavailable. Owner, creation date, profile variables, templates, and
earlier versions are not stored by the control plane and say so. Safety & Governance lists the safeguards the worker
enforces on every run (isolated worktree, profile-gated file writes and test execution, withheld provider credentials).
`Edit profile` in the "More agent actions" menu, the Edit buttons on the prompt cards, and Tool Permissions > Edit
enable the profile fields, the prompt editors, and tool selection; Cancel restores the saved values and Save persists
through the versioned update API. Duplicate Profile creates a saved copy, Disable/Enable and the Status field update
the saved profile, and Run Agent opens the queue dialog. Export downloads the profiles as JSON; import is not available
in Live.

In Mock the same page shows the approved fixtures under a visible `ILLUSTRATIVE DATA` label and makes no agent or run
API requests. Its figures, deltas, sparklines, durations, and costs are illustrative. Create, edit, duplicate, import,
the profile field selects, and Run Agent change fixture state in the browser tab only; confirmations end with "in this
preview only" and Run Agent records a run labelled SIMULATED.

Setting `provider` to `codex-cli` or `claude-code` runs the profile through the installed CLI on the worker; the
queue dialog then reports that CLI's readiness and can start the run from a GitHub issue. See
[Issue to pull request](issue-to-pull-request.md).

When a WorkGraph plan is proposed, its assigned profile and persona IDs and versions are pinned with an effective
configuration snapshot. Approval rejects a stale proposal. After approval, queued runs and retries use that snapshot
even if a profile or persona is edited; stored run evidence preserves provider, model, prompts, tools, and persona
version. CLI prompt order is persona instructions, profile system prompt, profile goal prompt, task, then Zenchron's
operating contract. Tool permissions are passed separately and cannot be expanded by prompt text.

## Feature diagram

```mermaid
flowchart LR
    Link["Profile deep link"] -->|Select profile; clear profile parameter on navigation away| Dashboard
    Dashboard -->|Monaco prompt editor is labelled by visible text| PromptEditor[Prompt editor]
    User[Engineering user] --> Dashboard[Agents workspace]
    Dashboard[Agents workspace<br/>Overview, Prompts, Tools, Run History] -->|GET, POST, PUT /api/v1/agents| API[Go control plane]
    Dashboard -->|GET /api/v1/workers · runtime readiness| API
    Dashboard -->|Queue agent run| Runs[Agent run API]
    Dashboard -->|GET /api/v1/personas · POST · PUT| API
    Dashboard -->|Persona editor preserves line breaks; save omits blank lines| API
    API --> Store[(agents.json<br/>profiles and personas)]
    Runs --> RunStore[(Versioned agent-runs.json snapshot)]
    Dashboard -->|Run history, metrics, and 30-day trend| Runs
    Dashboard -->|Filter list without changing selection| Detail[Selected profile detail and run target]
    Tools[Profile tool allowlist] --> Store
    Runs -->|claim with profile snapshot| Worker[Configured local worker]
    Worker -->|start process, provider codex-cli or claude-code| Harness[Codex or Claude Code CLI]
    Worker -->|create isolated branch| Worktree[Per-run Git worktree]
    Harness -->|profile-allowed reads, edits, sandboxed commands| Worktree
    Worker -->|fenced result| RunStore
```

## API

- `GET /api/v1/agents` lists profiles.
- `POST /api/v1/agents` creates an active profile.
- `PUT /api/v1/agents/{id}` replaces editable profile fields, increments its version, and updates its timestamp.
- `GET /api/v1/personas`, `POST /api/v1/personas`, and `PUT /api/v1/personas/{id}` list and version persona
  definitions. A duplicate is independent. Disabled personas cannot be newly bound or pass plan validation.
- Supported tool identifiers: `code.search`, `code.write`, `docs.search`, `git.diff`, `git.read`, and `tests.run`.

The API validates field lengths and rejects unknown JSON fields, duplicate tools, and unsupported tool identifiers.
Prompt editor labels are programmatically associated with Monaco's editor surface.

## Verification

- `go test ./cmd/zenchron` covers profile validation, create/update behavior, and persistence through control-plane restart.
- `TestPersonasPersistVersionsAndBindToProfiles`, `TestAgentProfileRejectsMissingOrDisabledPersona`, and
  `TestPlanPinsProfileConfigurationAndRejectsStaleApproval` cover persona persistence, validation, and pinning.
- `cd dashboard && npm run test:e2e -- e2e/z_agents.spec.ts --grep 'Live personas persist'` exercises persona CRUD and
  profile binding against the isolated real control plane.
- `cd dashboard && npm run test:e2e -- e2e/agents-selection.spec.ts` checks that filtering keeps the selected profile
  and its unsaved edits.
- `cd dashboard && npm run test:e2e -- e2e/z_agents.spec.ts` checks runtime readiness, profile search and edits, and a
  completed worker run against a loopback model stub; local preview checks cover filters, sorting, and actions
  without API calls.
- The profile edit flow also checks that Monaco's editor is labelled by the visible prompt label.
- The populated desktop layout fixture uses six profiles (five active) plus a completed run; focused tablet and phone
  checks verify that the profile, detail, and run panels do not overlap.
- `cd dashboard && npm run test:e2e -- e2e/agents-mobile-preview.spec.ts` verifies the 390×844 summary, local tabs and
  actions, return to profile management, and absence of agent API reads.
- `cd dashboard && npm run test:e2e -- e2e/agents-desktop-preview.spec.ts` verifies prompt-card editing saves only to
  the local fixture and makes no agent API requests; it also checks Overview panel links, local tool/governance edits,
  Performance Trends range selection, and the detail toolbar's mock-sized buttons and icons.
- On desktop viewports from 700px high, the profile list spans both rows while run history and performance stack under
  the selected profile; the content height contracts to the available viewport and retains the 670px mock height cap.
- Compact preview card headings keep all three overview rows and the lower run/trend panels inside that 670px detail grid at 1672×941.
