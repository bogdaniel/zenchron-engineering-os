# Objective management

The Objectives screen follows the supplied planning mockup and adds a working control-plane flow for creating, listing,
filtering, and updating objectives. It uses Mantine forms and controls, Zod validation, TanStack Query, Tabler icons,
and the installed AG Grid Community table.

## Feature diagram

```mermaid
flowchart LR
    User[Engineering user] -->|Create / update| Dashboard[Objectives dashboard]
    LocalPreview[Local unauthenticated Objectives state] -->|Read only| Fixture[Supplied objective mock data]
    Fixture --> Dashboard
    Dashboard -->|Validate form| Zod[Zod schema]
    Dashboard -->|GET /api/v1/objectives + /api/v1/products| API[Go control plane]
    Dashboard -->|POST /api/v1/objectives with product_id| API
    Dashboard -->|PATCH /api/v1/objectives/{id} with editable fields| API
    API --> Store[(Versioned JSON snapshot)]
    API --> Products[(products.json)]
    Products -->|Validate product id and resolve current name| API
    Store -->|Validated objective records| API
    API -->|JSON response| Dashboard
    Dashboard -->|Text, product, owner, status, due-quarter filters| Records[Filtered objective records]
    Records -->|Table view| Grid[AG Grid objective list]
    Records -->|Cards and Kanban views| Views[Cards grouped by status]
    Records -->|Planning| Plan[Due-date ordered objective cards]
    Records -->|Roadmap| Roadmap[Cards grouped by due quarter]
    Views -->|Select objective| Detail[Objective overview panel]
    Plan --> Detail
    Roadmap --> Detail
    Grid --> Detail
    Detail --> Tabs[Overview milestones pull requests activity tabs]
    Detail -->|Edit objective| Editor[Objective fields editor]
```

## Behavior

- `GET /api/v1/objectives` returns workspace objectives, newest first.
- `POST /api/v1/objectives` validates title, description, owner, an optional saved `product_id`, and optional
  `YYYY-MM-DD` due date; new objectives start `in_progress` at 0%.
- `PATCH /api/v1/objectives/{id}` accepts title, description, owner, due date, status, progress, and/or product assignment.
  It validates field lengths and date format; progress is limited to 0–100, and marking an objective `completed` sets
  progress to 100.
- The dashboard searches title, description, owner, and product, and filters by product, owner, status, and due-date
  quarter. The default is This Quarter; All due dates includes unscheduled objectives.
- The local read-only table preview uses a numbered footer pager that stays in sync with AG Grid; authenticated data
  keeps the standard AG Grid pagination panel.
- An unauthenticated localhost session at `/#objectives` uses the same Objectives page with sample KPI, approval, workflow, and milestone data. The fixture is read only and does not call protected objective or product APIs.
- The mock KPI row keeps the success-rate change beside its value and omits extra captions from the four compact count cards, matching the supplied layout. Live objective cards retain their explanatory details.
- The mock preview uses larger table and detail text than the dense live table. Its title, status, product, and due-date columns fit the sample rows at the reference viewport without horizontal clipping.
- Objective IDs appear below titles in the mock table, and the planned/completed capacity series retain a visible area fill.
- The local preview keeps the capacity chart below the objective list and places Milestone Progress inside the selected objective's detail panel. Its four milestone rows fit the fixed desktop mock card and the card grows to fit on tablet and phone layouts.
- In the read-only preview, favorite toggles locally, Copy objective link copies a deep link that selects that objective, and the more-actions menu opens the related PR or activity tab. These actions do not write objective data.
- Approval and linked-workflow counts in the mock preview are illustrative fields; they remain unavailable in live mode until their sources are part of the objective API.
- Empty workspaces prompt the user to create the first objective. When filters hide all records, the table and toolbar say no objectives match instead of implying the workspace is empty.
- Table, Cards, and Kanban views render the same filtered records; selecting any record opens the read-only objective overview. The title, description, owner, due date, status, progress, and product editor appears only after choosing **Edit objective**. Kanban groups by the saved objective status.
- The overview, milestones, related pull requests, and activity tabs switch the detail panel. Tabs without supported data show an unavailable state.
- The overview lays out description, blockers, acceptance criteria, related pull requests, plan summary, activity feed, and progress; fields absent from the current objective data are labeled unavailable rather than populated with sample records.
- Planning sorts the filtered objectives by due date, with undated records last. Roadmap groups those same records by calendar quarter and places missing or invalid dates under Unscheduled. Both views use saved objective data and open the overview panel when a card is selected.
- The progress panel shows each objective's current completion percentage; it does not infer a schedule or time range.
- Product assignment uses the durable product ID; the control plane resolves the current product name in the objective
  response, so a product rename does not break the relationship or wait on a second dashboard query. Older free-text
  product values remain visible as unlinked legacy labels.
- Objective records survive API restarts. The control plane writes an atomic versioned JSON snapshot in its data
  directory.
- Invalid or unsupported state files stop startup; the API does not silently replace existing data with an empty store.
- Existing objective snapshots without `product_id` load as unlinked. Once a linked record is written, pre-feature
  binaries reject that new field; roll back only after unlinking those records or restoring a compatible snapshot.

## Verification

`go test ./cmd/zenchron` covers objective API updates, product linking, validation, and persistence. The focused E2E
suite covers the read-only mock preview, empty/error states, search and filters, table/cards/Kanban/planning/roadmap
views, full objective create/edit payloads, and responsive layouts. The mobile layout check asserts that every
milestone row remains inside the preview card:
`cd dashboard && npm run test:e2e -- e2e/objectives-views.spec.ts`.

Playwright review captures at the mock viewport are in `docs/screenshots/`.
