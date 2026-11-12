# Agent profiles

Prototype status: the profile fields, tool allowlist, and versioning describe current implementation only. The agent definition and execution model remain undecided; see [the architecture checkpoint](../architecture/architecture-checkpoint.md).

The Agents workspace stores reusable profile configuration: display name, description, provider and model identifiers,
system and goal prompts, enabled state, version, and a small allowlist of repository tools. The profile detail is
split into Overview, Prompts, Tools & Permissions, and Run History tabs. Version, run count, and success rate come from
stored profile and run data; model cost stays unavailable until provider usage is recorded. The profile list shows each
profile's latest run time and completed-run success rate from recorded run history. The profile overview also charts
successful, failed, and other run outcomes in rolling 24-hour buckets for the last 30 days; it shows an empty state
when that profile has no runs. Profiles persist in the
control-plane state directory and survive restart. The profile list searches saved names, descriptions, providers, and
model identifiers, and shows up to three allowed tool IDs with a count for any additional tools. The run dialog shows each online project's worker and its reported model-runtime readiness; missing
status stays unknown, and runs queued on a worker without a configured runtime remain queued. Provider identifiers
are labels only; credentials are not stored.

The Overview tab is read-only by default and shows saved provider/model metadata, version, run count, completed-run
success rate, prompt previews, executable tool permissions, and enforced execution safeguards. It reports per-run
worktree isolation, profile-gated file writes, and unavailable test execution from the current worker contract. Average latency and model cost stay unavailable because
the worker does not record them yet. `Edit profile` enables the profile fields, prompt textareas, and tool selection;
Cancel restores the saved values, and Save persists the profile through the versioned update API. Disable/Enable acts
directly on the selected saved profile. Prompt previews are truncated for display, with the full prompt available on
hover. In the local design preview, the System Prompt and Goal Prompt cards preserve the mock's numbered, read-only
code lines; Edit opens the full prompt editor. Metrics use recorded data only.

The unauthenticated local design preview is fixture-only and makes no agent or run API requests. Its metrics and
profile history, including performance deltas, sparklines, durations, and costs, are illustrative and carry a visible
`ILLUSTRATIVE DATA` label; fields absent from the live profile contract, including owner and creation time, stay
exclusive to that preview. The desktop performance chart keeps its illustrative success percentages, USD costs, and seconds latency on separate scales to match the reference. The preview's Model / Provider, Version, Status, and Owner controls update local fixture
state only. Search, status filtering, and name sorting operate on the local fixture. Create, edit,
duplicate, disable, simulated run, library selection, import/export, and version/history controls update or inspect
preview data only; they never call the agent APIs. Overview card links open the matching Variables & Templates,
Tools & Permissions, Safety & Governance, or Run History tab. Prompt cards also match the mock's pencil Edit and
overflow controls; Copy prompt writes the illustrative prompt text to the local clipboard. Tool permission and governance edits stay local. The
Performance Trends range selector switches the illustrative chart between the 7-day and 30-day sample windows.
The desktop mock preview uses the full subtitle, including “Define specialized agents for your engineering workflows.” The System Prompt uses numbered 10 px monospace text with 12 px line spacing; the Goal Prompt remains plain 10 px text as shown in the mock.
Its profile detail tabs use the mock's bordered segmented rail and filled active tab. The local detail actions use the mock's 30 px button height, 10 px labels, and Run, Duplicate, Disable, and Compare icons.
The mock's Research Analyst row is labeled Idle while its local disabled state remains available to the preview's
status filter and Enable action.
Each desktop preview profile also has an options menu to select or duplicate that profile locally; live profile rows do
not show this preview-only menu. Each preview card shows model/provider first, then icon-labeled last-run, cost, and
success values on the next compact row, with the status badge aligned at the card's upper right; descriptions remain readable and the initial list shows five
complete rows before scrolling to the sixth. Its compact detail header and tab inset keep the lower overview panels
inside the reference frame.

At phone width, the local preview switches to the supplied Agents & Reviews summary: the Agents tab shows recent runs,
pull request reviews, evidence health, and quick actions; Reviews and Evidence tabs focus their matching panels. Run
Agent opens the existing queue dialog, New Review navigates to the Reviews page, and All Runs opens the existing
profile workspace with Run History selected. Its back action returns to the summary. The
phone-only sample counts and review/evidence summaries are illustrative; the desktop profile manager and all live
Agents behavior remain unchanged.

The worker enforces `code.search`, `code.write`, `docs.search`, `git.diff`, and `git.read` when an OpenAI-compatible
runtime endpoint is configured on that worker. `code.write` is opt-in and applies only to the run's isolated Git
worktree. `tests.run` remains saved profile metadata but is not exposed to the model. Provider identifiers are labels;
the worker endpoint selects the protocol and credentials. Model spend remains unavailable.

Setting `provider` to `codex-cli` or `claude-code` runs the profile through the installed CLI on the worker; the
queue dialog then reports that CLI's readiness and can start the run from a GitHub issue. See
[Issue to pull request](issue-to-pull-request.md).

## Feature diagram

```mermaid
flowchart LR
    User[Engineering user] --> Dashboard[Agents workspace]
    Dashboard[Agents workspace<br/>Overview, Prompts, Tools, Run History] -->|GET, POST, PUT /api/v1/agents| API[Go control plane]
    Dashboard -->|GET /api/v1/workers · runtime readiness| API
    Dashboard -->|Queue agent run| Runs[Agent run API]
    API --> Store[(Versioned agents.json snapshot)]
    Runs --> RunStore[(Versioned agent-runs.json snapshot)]
    Dashboard -->|Run history, metrics, and 30-day trend| Runs
    Tools[Profile tool allowlist] --> Store
    Runs -->|claim with profile snapshot| Worker[Configured local worker]
    Worker -->|OpenAI-compatible Chat Completions| Harness[Bounded agent tool loop]
    Worker -->|create isolated branch| Worktree[Per-run Git worktree]
    Harness -->|profile-allowed read and write tools| Worktree
    Worker -->|fenced result| RunStore
```

## API

- `GET /api/v1/agents` lists profiles.
- `POST /api/v1/agents` creates an active profile.
- `PUT /api/v1/agents/{id}` replaces editable profile fields, increments its version, and updates its timestamp.
- Supported tool identifiers: `code.search`, `code.write`, `docs.search`, `git.diff`, `git.read`, and `tests.run`.

The API validates field lengths and rejects unknown JSON fields, duplicate tools, and unsupported tool identifiers.

## Verification

- `go test ./cmd/zenchron` covers profile validation, create/update behavior, and persistence through control-plane restart.
- `cd dashboard && npm run test:e2e -- e2e/z_agents.spec.ts` checks runtime readiness, profile search and edits, and a
  completed worker run against a loopback model stub; local preview checks cover filters, sorting, and actions
  without API calls.
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
