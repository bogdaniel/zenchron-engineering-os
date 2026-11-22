# Workflow Builder

The Workflows page has one layout, taken from the supplied node-editor mockups, and two data sources. **Live** shows
the workflows saved in the control plane and keeps them fully editable: an xyflow canvas with ELK auto-layout,
component properties, graph validation, and save. **Mock** (local addresses only) shows the approved fixture workflow
with its illustrative run, schedules, permissions, and settings. See `docs/architecture/dashboard-modes.md` for the
mode rules.

The control plane stores versioned workflow definitions and validates which nodes can compile into the existing
objective plan and WorkGraph. The canvas does not run a separate workflow engine: Objective Workspace compiles a saved
workflow into the same plan that is inspected, approved, and executed by WorkGraph.

## Feature diagram

```mermaid
flowchart LR
    Link["Workflow deep link"] -->|Select workflow; clear workflow parameter on navigation away| Page
    User[Engineering user] --> Page["WorkflowsPage · dashboard/src/workflows.tsx<br/>one layout"]
    Page -->|reads| Source{"WorkflowsSource · workflowsView.ts<br/>workflows, save, create, describe"}
    Source -->|Mock| Fixtures["useMockWorkflows · workflow-preview-data.ts<br/>useState only, no requests"]
    Source -->|Live| Hook["useLiveWorkflows · TanStack Query"]
    Hook -->|GET /api/v1/workflows| API[Go control plane]
    Hook -->|POST /api/v1/workflows| API
    Hook -->|"PUT /api/v1/workflows/{id}"| API
    Hook -->|"POST /api/v1/workflows/{id}/validate"| API
    API --> Validate[Validate node types and edge references]
    Validate --> Store[(Versioned JSON snapshot)]
    Page --> Menu["Workflow menu (version badge)<br/>switch · New workflow · version history · Auto layout"]
    Page --> Palette["WorkflowPalette<br/>search · categories · click or drag to add"]
    Palette -->|"@dnd-kit drop centred at cursor"| Canvas[React Flow canvas]
    Menu -->|Auto layout| ELK["ELK layered layout<br/>compact card sizes"]
    ELK --> Canvas
    Canvas -->|select| Inspector["Inspector<br/>name · description · delete · WorkflowNodeSettings"]
    Page --> RunPreview["Run Preview · WorkflowRun.tsx<br/>Mock: fixture timeline · Live: select workflow in Objective Plan"]
    Page --> Phone["Phone run detail · WorkflowPhoneRunCards<br/>six stages from the saved graph"]
    Page --> Sections["WorkflowSections.tsx<br/>Runs · Versions · Schedules · Permissions · Settings"]
    Sections -->|"Live: Save Settings (name, description, status)"| Hook
    Page -->|"Select workflow for objective"| Objective[ObjectivePlanPanel]
    Objective -->|"POST /api/v1/objectives/{id}/plans"| Compiler[workflow_compile.go]
    Compiler -->|typed produce, review, integrate plan| WorkGraph[Existing WorkGraph]
```

## Behavior

### Both modes

- One frame: page heading with the status badge, the workflow menu, Validate / Run / Save / Publish, the six section
  tabs, the component palette, the canvas with its tool and zoom groups, the Execution Flow card, the resizable Run
  Preview, and the inspector. Desktop reference size is 1672×941; the editor is desktop and tablet only.
- The workflow menu opens from the version badge. It lists every workflow (the open one is marked), then "New
  workflow…", "Open version history", and "Auto layout".
- The palette groups all node types the control plane accepts. Search filters names and descriptions; the All, Agents,
  Actions, Control, and Integrations chips narrow the list; group headings collapse, and Integrations starts
  collapsed. A component is added by clicking it or by dragging its handle onto the canvas, where it is centred under
  the cursor. "Custom Block" adds an Agent Task named Custom Block.
- The canvas supports dragging nodes, connecting ports, select and pan modes, fit, fullscreen, zoom, and a mini-map
  toggle. Node icons and accent colours follow the component type; connectors take the colour of the component they
  lead to and are dashed around a Loop.
- The inspector shows the selected component's name, read-only type, and description. Its overflow menu resets the
  selection to the Agent Router or deletes the component with its connectors; closing the inspector gives the canvas
  its width, and selecting a node opens it again. Opening a workflow selects its Agent Router; a graph without one
  opens unselected.
- Validate calls the control plane and shows typed compiler problems. A failed validation, save, layout, or fullscreen
  request is shown in the alert colour and wraps instead of being clipped.
- The `react-resizable-panels` separator adjusts the canvas and Run Preview heights with the pointer or arrow keys.
- On phones the page is the run-detail view: back / brand / overflow header, the four in-page tabs, the six-stage
  overview graph, and the Run Status, Task Progress, and Approvals cards. The builder toolbar, section tabs, editor,
  and the shell header are hidden there, as in the mockup.

### Live

- `GET /api/v1/workflows` fills the menu and the canvas. While it loads the page says so; a failed request shows the
  error and an empty list says "No workflows available". Fixtures are never used as a fallback.
- Save sends `PUT /api/v1/workflows/{id}` with the name, description, status, nodes, and edges, and confirms with the
  new version. "New workflow…" sends `POST /api/v1/workflows` and opens the result; a rejected create is reported in
  the dialog, a rejected save in the Execution Flow card or the section note.
- A new Live workflow starts with Trigger, Agent Task, and Integrate and publish nodes. Agent Task, Test Generator,
  and Code Reviewer nodes compile to produce/review WorkUnits; Integrate is the existing deterministic WorkGraph
  integration unit. Agent and persona assignments, dependencies, acceptance criteria, workflow ID, and version flow
  into the proposed plan. The plan is inspected and approved in Objectives.
- Planner, Agent Router, Coverage Analyzer, Human Approval, Merge Gate, Publish Report, Condition, and Loop are
  design-only. Saved legacy definitions remain readable and editable; validation explains that unsupported nodes
  cannot execute. They are not silently removed or mapped to other behavior.
- A saved graph is arranged by ELK when it opens, using the compact card sizes from 1051px up and the full cards
  below. Auto-layout preserves model order, so Code Reviewer stays above Test Generator and Coverage Analyzer.
- The Settings tab edits the saved name, description, and status in the General card; "Save Settings" is the same
  save. Repository, target branch, execution limits, connected services, and notifications are Unavailable.
- The version badge reads `v<version> (<Status>)`. Versions lists the one saved version with its save time; there is
  nothing to compare, restore, or publish.
- The canvas Run action remains unavailable because plans are approved from Objectives. The Run Preview makes no
  claim that a workflow ran; it directs the user to compile the workflow in an Objective plan. WorkGraph run history
  remains visible from Objectives and Product Workspace.
- The inspector's Prompt, Variables, and Advanced tabs are disabled; Routing Parameters, Budgets & Limits, Retry
  Rules, and Execution Conditions read Unavailable because only a component's name and description are stored.
- Runs, Schedules, and Permissions show their headings with "Unavailable" values, an empty state that gives the reason,
  and disabled controls.
- On phones, Run Status shows the component and connection counts and "Not run", Task Progress lists the stages
  derived from the saved graph as "Not run", and Approvals lists each Human Approval component as "Not requested".

### Mock

- Uses the fixture workflow (`designPreviewWorkflow`) at hand-arranged positions and sends no workflow request.
- Save acknowledges the draft locally, Publish marks only the preview, "New workflow…" adds a workflow "in this
  preview only", and added blocks are local. Run shows the illustrative PR #4827 timeline; the Simulate Run switch
  hides and restores it. Green check markers on the cards belong to that illustrative run.
- The inspector is read-only and shows the fixture's routing rules, budgets, retry rules, execution conditions, and
  labelled illustrative prompt and variables; added rules and switches change local state only.
- Runs, Versions, Schedules, Permissions, and Settings show fixture data marked "CONCEPT · ILLUSTRATIVE DATA". Their
  actions answer "previewed · no workflow changes were saved"; Export logs downloads a sample log. The phone shows
  sample run #8821 at 78% with its tasks and approvals.
- Layout proportions asserted for the mockups: Runs keeps 397px history / detail panels at 0.88:1 with 32px metric
  values and 159px primary actions; Versions splits 43 / 57 with 160px compare frames; Schedules splits 32 / 68 with
  90px trigger cards and 144px calendar days; Permissions splits 1.6:1 and fits the 941px frame.

### Control plane

- Existing seeded design graphs remain stored; unsupported nodes are identified as design-only during validation.
- Workflow definitions survive API restarts through an atomic versioned JSON snapshot. The compiler creates ordinary
  plan units and records the selected workflow ID and version in the approved plan and WorkGraph.

## Outstanding

- Workflow execution is through Objective plans and WorkGraph; direct canvas execution, schedules, per-workflow
  permissions, historical workflow versions, publishing, and component settings beyond supported assignments and
  acceptance criteria are not implemented.
- The workflow menu is a plain list without a filter field.
- On phones a workflow cannot be switched or edited; the page shows the first saved workflow's run detail.

## Verification

```sh
go test ./cmd/zenchron -run 'TestWorkflow|TestPersistentMuxRestoresObjectivesAndWorkflows' -count=1
cd dashboard && npm run test:e2e -- e2e/workflows-live.spec.ts
cd dashboard && npm run test:e2e -- e2e/workflow-builder-plan.spec.ts
cd dashboard && npm run test:e2e -- e2e/workflows.spec.ts
cd dashboard && npm run test:e2e -- e2e/workflow-mobile-preview.spec.ts
```

`workflows-live.spec.ts` covers the frame in Live against the test control plane: the workflow menu, the automatic
layout, honest unavailable parts on every tab, add, rename, delete, drag placement, save and its request body,
create, the Settings rename, resizing, and the phone view; and, with stubbed responses, failed loads, an empty list,
and rejected saves and creates. A separate empty-state case simulates only the initial empty list response, then
creates, edits, saves, and reloads through the real local control-plane API. `workflow-builder-plan.spec.ts` configures an assignment and acceptance criterion in
the visual builder, saves and validates it against the control plane, then confirms the selected objective plan retains
the workflow version, profile, persona, and acceptance criterion. `workflows.spec.ts` and
`workflow-mobile-preview.spec.ts` cover the same frame in Mock with local-only actions and no workflow requests.
