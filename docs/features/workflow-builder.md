# Workflow Builder

The Workflows page follows the supplied node-editor mockup with an editable React Flow canvas, ELK auto-layout,
component properties, graph validation, and control-plane save. The seeded PR review workflow is the first editable
graph.

In the local design preview, the component inspector's overflow menu resets selection to Agent Router. Closing the
inspector hides it and gives the canvas the freed width; selecting a canvas node opens it again.
The default Agent Router description also matches the routing summary in the supplied mock.

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
- The local design preview also has All, Agents, Actions, Control, and Integrations category filters; each narrows the palette without changing the available workflow node types.
- Compact desktop preview-only node dimensions and positions let Fit View show the complete graph at 100%, matching the supplied canvas mock.
- The local design preview colors graph connectors by their destination node type; the live editor keeps its existing connector styling.
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
- The palette groups all node types accepted by the control plane. In the local design preview, Publish Report appears
  under the collapsed Integrations group, matching the mock; group headings toggle open and closed, and search reveals
  matching blocks even when their group is collapsed. Builder is the only API-backed workflow section.
  The unauthenticated local design preview also opens static Runs, Versions, Schedules, Permissions, and Settings mockups;
  their sample data is marked illustrative, the shared header shows the version, node, and agent-profile summary, and
  navigation makes no workflow API requests. In the Builder preview, adding a custom block or routing rule, switching the
  Agent Router's Properties, Prompt, Variables, and Advanced tabs, toggling retry and execution conditions, validating the
  graph, and switching the simulated run view update local preview state only. Its inspector tabs use the mock's segmented
  control styling with a filled active tab. Run displays the simulated timeline; Save
  acknowledges the local draft; Publish marks only the preview; and the version menu opens history. None changes persisted
  workflow data. The mock's Runs, Versions, Schedules, Permissions, and Settings actions acknowledge locally and state
  that no workflow changes were saved; run detail tabs and phone section buttons switch their local view. Export logs
  downloads a clearly named sample log for the selected illustrative run. Prompt and
  variable examples are labeled illustrative and are not saved. The default Properties view includes routing, budget, retry, and execution-condition groups to match the desktop mock; Advanced remains a working tab for those controls. In live mode, secondary section tabs stay disabled until
  their services exist.
- The desktop Versions preview follows the reference's 43/57 history/compare split. Schedules uses its 32/68
  trigger/calendar split and ~90 px schedule cards; tablet and phone retain the stacked layout.
- Schedule preview trigger rows and the calendar grid use the reference insets and 90 px/144 px card heights. Trigger
  switches update local state only; Save Schedule confirms the preview action without persisting workflow data.
- Runs keeps the 397 px desktop history/detail panels below the four metric cards, with the mock's 0.88:1 history/detail
  split and 32 px metric values. Secondary workflow section CTAs share the mock's 159 px width.
- Version comparison cards retain the mock's 160 px graph frames and 114×44 node cards; Added, Updated, and Routed
  summary badges use their separate status colors, and Restore Draft uses the outlined secondary style.
- Settings lifecycle states use labeled, accessible ON pills matching the reference.
- Section preview primary actions use the mock's per-action icon (Run, Publish, create/invite) or no icon for Save Settings;
  the Settings service rows use the repeated diamond glyph and its lifecycle buttons retain the outlined treatment.
- The desktop Permissions panels use the mock's 1.6:1 left/right split and compact matrix rows to fit the 941 px frame.
  Protection switches are keyboard-accessible and update local preview state; Save Permissions only acknowledges the
  illustrative change and does not persist workflow data.
- Opening a saved workflow selects its Agent Router so the inspector starts with real graph data. Workflows without
  an Agent Router leave the inspector unselected.
- In live mode, Run and Publish remain disabled until execution and publishing services exist. In the local design preview,
  Run shows the illustrative timeline, Save acknowledges the draft, and Publish marks only the preview.
- `/#workflows` in an unauthenticated local session opens the builder without a session, uses the local design fixture, disables creation, and allows local Save;
  it makes no workflow API requests.
- The desktop local mock uses tall primary cards, separated branch cards, and green check markers for illustrative passed steps; the markers are status indicators, not controls.
  The Retry title stays on one line beside its status marker to match the mock.
  Code Reviewer, Test Generator, and Coverage Analyzer cards use the reference's wider branch width; Coverage Analyzer is shorter than the primary nodes and has clear space above it.
  Tablet and phone graph sizing remain on the responsive canvas rules.
- The local mock route shows the Retry loop above the Agent Router with dashed failure paths, a Condition node joining
  test and coverage results before approval, a readable dotted canvas grid, and the Agent Router's rule, budget, retry,
  and execution-condition panels. Its canvas toolbar switches between select and pan modes, adds a local block, fits and
  zooms the graph, toggles fullscreen, and shows or hides the mini-map. These preview controls and the simulated PR #4827
  timeline use local state only and never save or execute a workflow. The canvas includes the mock's compact Execution
  Flow summary as an overlay; builder status notices appear in the same card, and live mode keeps its runner status row.
- The Run Preview's “Simulate Run” switch hides and restores the illustrative data; the Run action restores it as well.
- The desktop simulated run timeline includes the mock's Step and Status columns, node icons, parallel-step labels, and Ready / Awaiting (manual) / Pending fixture states. These are illustrative and do not imply a live run.
- On phones, `/#workflows` in an unauthenticated local session shows the mock's back/brand/overflow header, run #8821 at 78%, its five task states, and two approval states. The header actions return to Overview or scroll to run/approval details. These
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
cd dashboard && npm run test:e2e -- e2e/workflows.spec.ts -g 'Workflow Builder preview canvas tools'
cd dashboard && npm run test:e2e -- e2e/workflow-mobile-preview.spec.ts
```

The focused browser check verifies workflow creation, selection, graph switching, editing, saving, palette search and drag
placement, canvas/preview resizing, and mobile toolbar fit.
