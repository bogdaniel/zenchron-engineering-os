# Objective management

The Objectives screen follows the supplied planning mockup and adds a working control-plane flow for creating, listing,
filtering, and updating objectives. It uses Mantine forms and controls, Zod validation, TanStack Query, Tabler icons,
and the installed AG Grid Community table.

## Feature diagram

```mermaid
flowchart LR
    User[Engineering user] -->|Create / update| Dashboard[Objectives dashboard]
    Dashboard -->|Validate form| Zod[Zod schema]
    Dashboard -->|GET /api/v1/objectives + /api/v1/products| API[Go control plane]
    Dashboard -->|POST /api/v1/objectives with product_id| API
    Dashboard -->|PATCH /api/v1/objectives/{id} with product_id| API
    API --> Store[(Versioned JSON snapshot)]
    API --> Products[(products.json)]
    Products -->|Validate product id and resolve current name| API
    Store -->|Validated objective records| API
    API -->|JSON response| Dashboard
    Dashboard -->|Text, product, owner, status, due-quarter filters| Records[Filtered objective records]
    Records -->|Table view| Grid[AG Grid objective list]
    Records -->|Cards and Kanban views| Views[Cards grouped by status]
    Views -->|Select objective| Detail[Shared objective detail editor]
    Grid --> Detail
```

## Behavior

- `GET /api/v1/objectives` returns workspace objectives, newest first.
- `POST /api/v1/objectives` validates title, description, owner, an optional saved `product_id`, and optional
  `YYYY-MM-DD` due date; new objectives start `in_progress` at 0%.
- `PATCH /api/v1/objectives/{id}` accepts status, progress, and/or product assignment. Progress is limited to 0–100;
  marking an objective `completed` sets progress to 100.
- The dashboard filters by text, product, owner, status, and due-date quarter. The default is This Quarter; All due dates includes unscheduled objectives.
- Table, Cards, and Kanban views render the same filtered records; selecting any record opens the same detail editor. Kanban groups by the saved objective status.
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

`go test ./cmd/zenchron -run 'TestObjective|TestPersistentMuxRestoresObjectivesAndWorkflows'` covers the objective API,
product linking, and restart persistence. Focused dashboard E2E flows cover creating/updating objectives, product names
while the catalog loads, and the six-record planning view with a selected objective at the reference viewport. They
also cover assigning an objective to a Product Workspace record:
`cd dashboard && npm run test:e2e -- e2e/home.spec.ts --grep 'Objectives dashboard|Objectives grid|objectives can be created'`.
