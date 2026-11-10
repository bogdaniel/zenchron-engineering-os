# Workflow Builder

The Workflows page follows the supplied node-editor mockup with an editable React Flow canvas, ELK auto-layout,
component properties, graph validation, and control-plane save. The seeded PR review workflow is the first editable
graph.

## Feature diagram

```mermaid
flowchart LR
    User[Engineering user] -->|Edit graph| Canvas[React Flow canvas]
    User -->|Create or select workflow| Dashboard[Workflow dashboard]
    Dashboard -->|Desktop layout| Inspector[Workflow and node inspector]
    Dashboard -->|Execution state and graph counts| Preview[Run preview]
    Dashboard -->|Overview and phone summary| Summary[Six key stages derived from saved graph]
    Summary -->|No run history| Tasks[Configured stages marked Not run]
    Summary -->|No approval event| Approvals[Approval step marked Not requested]
    Dashboard -->|Desktop editing| Canvas
    Summary -->|Read current definition| API
    Dashboard -->|Pointer and keyboard resizing| Split[Resizable canvas / preview divider]
    Palette[Component palette] -->|Drag handle| DnD[@dnd-kit/core]
    DnD -->|Drop centered at cursor| Canvas
    Palette -->|Click to add| Canvas
    Search[Palette search] -->|Filter node names and descriptions| Palette
    Canvas -->|Auto layout| ELK[ELK layered layout]
    Canvas -->|Validate and save| Dashboard
    Dashboard -->|GET /api/v1/workflows| API[Go control plane]
    Dashboard -->|POST /api/v1/workflows| API
    Dashboard -->|PUT /api/v1/workflows/{id}| API
    Dashboard -->|Read current graph counts only| Preview
    API --> Validate[Validate node types and edge references]
    Validate --> Store[(Versioned JSON snapshot)]
    Store -->|Workflow JSON + version| Dashboard
    LocalPreview[Local mock route] -->|Desktop canvas and router fixture| Dashboard
    LocalPreview -->|Phone sample run #8821 and approval fixture| MobileRun[Mobile run detail preview]
```

## Behavior

- The control plane returns a starter PR review and release graph with parallel Code Reviewer, Test Generator, and
  Coverage Analyzer branches, then accepts edits through
  `PUT /api/v1/workflows/{id}`. The builder can create workflows with `POST /api/v1/workflows` and switch between
  persisted definitions.
- Node type, node count, edge count, IDs, labels, positions, status, and edge references are validated before saving.
- Node icons and accent colors follow the stable component type, so changing a node label does not change its visual role.
  Palette descriptions wrap to three lines, and canvas descriptions wrap to two lines instead of being cut off horizontally.
- The canvas supports dragging nodes, connecting ports, editing labels and descriptions, adding components, deleting
  components, and ELK auto-layout. Auto-layout preserves model order for sibling nodes, keeping Code Reviewer above
  Test Generator and Coverage Analyzer as shown in the mock. Compact layer spacing and node sizing keep the complete graph
  legible in the canvas;
  React Flow controls sit at the canvas top-right and a compact mini-map stays at bottom-right.
- Palette components show their type icon and purpose, and can be clicked or dragged onto the canvas; dragged nodes
  are centered under the cursor using React Flow viewport coordinates.
- Palette search filters the existing component labels and descriptions, leaving the current groups and node types intact.
- On desktop the component palette spans the canvas and run-preview rows, while the inspector spans the header through the
  preview. The Overview and phone summaries group configured node types into six readable workflow stages with concise
  action captions; component and connection totals still report the full saved graph. On phones, the preview uses compact
  stage coordinates so all six stages fit the read-only graph overview. The local phone run mock uses the Objective,
  Workflow Orchestration, Ship AI code review v2, and Running labels from the reference; it hides the desktop builder
  toolbar and section tabs, keeps the four run-detail tabs, and fits the status, task, and approval panels above the fixed
  phone navigation. Live mode keeps honest empty run states
  when no execution exists; the local mock route uses a static run fixture for the supplied run-detail design. The
  editor stays desktop-only.
- The builder content stays within the supplied desktop frame width while the shared app shell provides the same rail and
  typography as other routes. `PanelHeading` supplies component and node headings; the selected node opens in the
  inspector first, with workflow-level fields available in a collapsed native disclosure below it.
- The node inspector groups the persisted name and description under Basic Configuration, shows type from the saved node
  kind as read-only, and uses the matching component icon. It exposes no fields beyond the saved workflow shape.
- The installed `react-resizable-panels` separator adjusts the canvas and run-preview heights. Its default split keeps
  the canvas aligned with the supplied desktop mock; the keyboard-focusable separator can also be resized with arrow keys.
- The palette groups all node types accepted by the control plane. Builder is the only API-backed workflow section.
  The unauthenticated local design preview also opens static Runs, Versions, Schedules, Permissions, and Settings mockups;
  their sample data is marked illustrative, the shared header shows the version, node, and agent-profile summary, and
  navigation makes no workflow API requests. In the Builder preview, adding a custom block or routing rule, switching the
  Agent Router's Properties, Prompt, Variables, and Advanced tabs, toggling retry and execution conditions, validating the
  graph, and switching the simulated run view update local preview state only. Run displays the simulated timeline; Save
  acknowledges the local draft; Publish marks only the preview; and the version menu opens history. None changes persisted
  workflow data. The mock's Runs, Versions, Schedules, Permissions, and Settings actions acknowledge locally and state
  that no workflow changes were saved; run detail tabs and phone section buttons switch their local view. Export logs
  downloads a clearly named sample log for the selected illustrative run. Prompt and
  variable examples are labeled illustrative and are not saved. In live mode, secondary section tabs stay disabled until
  their services exist.
- The desktop Versions preview follows the reference's 43/57 history/compare split. Schedules uses its 32/68
  trigger/calendar split and ~90 px schedule cards; tablet and phone retain the stacked layout.
- Settings lifecycle states use labeled, accessible ON pills matching the reference.
- The desktop Permissions matrix uses compact rows so both columns fit inside the mock's 941 px frame.
- Opening a saved workflow selects its Agent Router so the inspector starts with real graph data. Workflows without
  an Agent Router leave the inspector unselected.
- Run and Publish remain disabled because there is no workflow execution runner or publish service yet.
- `/#workflows` in an unauthenticated local session opens the builder without a session, uses the local design fixture, and disables create/save;
  it makes no workflow API requests.
- The local mock route shows the Retry loop above the Agent Router with dashed failure paths, a Condition node joining
  test and coverage results before approval, a readable dotted canvas grid, and the Agent Router's rule, budget, retry,
  and execution-condition panels, plus the
  mock's canvas toolbar and simulated PR #4827 timeline. These sample values are read-only preview content and never
  enter saved workflows.
- On phones, `/#workflows` in an unauthenticated local session shows run #8821 at 78%, its five task states, and two approval states. These
  sample values are static and do not imply a live run or approval.
- Run Preview shows the saved graph's actual node and edge counts and states explicitly that no execution is available;
  it does not show simulated statuses, duration, or cost in the authenticated editor.
- Validate checks that the graph contains a trigger and that edges refer to existing nodes. Saving increments the
  workflow version.
- Workflow definitions survive API restarts through an atomic versioned JSON snapshot. The current control plane does
  not execute workflows; the UI states this explicitly.

## Verification

```sh
go test ./cmd/zenchron -run 'TestWorkflow|TestPersistentMuxRestoresObjectivesAndWorkflows' -count=1
cd dashboard && npm run test:e2e -- e2e/workflows.spec.ts -g 'workflow graph can be edited'
cd dashboard && npm run test:e2e -- e2e/workflows.spec.ts -g 'local Workflow Builder mock preview'
cd dashboard && npm run test:e2e -- e2e/workflow-mobile-preview.spec.ts
```

The focused browser check verifies workflow creation, selection, graph switching, editing, saving, palette search and drag
placement, canvas/preview resizing, and mobile toolbar fit.
