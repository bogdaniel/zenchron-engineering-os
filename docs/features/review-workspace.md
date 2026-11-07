# Review workspace

The Reviews page follows the supplied review-workspace structure: metric strip, section navigation, review queue,
branch diff detail, evidence and policy summary, and merge governance. It lists live open GitHub issues and pull requests
for a selected GitHub.com checkout, loads the selected PR's text diff, and shows agent runs with bounded diffs from
isolated worktrees in a read-only Monaco patch editor. Provider diffs are limited to 1 MiB. Reviewers can comment on,
close, or reopen GitHub issues, leave bounded local comments, and request a follow-up agent pass on the same branch. For
GitHub pull requests, reviewers can
submit a top-level comment or request changes using the control-plane token. Inbound provider feedback, checks,
approval, and merge remain unavailable. Dashboard-submitted feedback on a Zenchron pull request is attached to its
originating run; an eligible request for changes queues a follow-up on the same branch.

## Feature diagram

```mermaid
flowchart LR
    User[Developer or reviewer] --> Browser[Reviews page]
    Browser --> Split[Keyboard-accessible resizable panel group]
    Split --> Queue[Selectable GitHub request cards or local AG Grid queue]
    Split --> Detail[GitHub item or isolated branch detail]
    Split --> Governance[Evidence, checks, and merge governance]
    Detail -->|Code changes| Context[Suggestions, artifacts, and checklist panels]
    ProviderDetails[Provider suggestions, artifacts, checks] -. not synchronized .-> Context
    Runs[Agent run history API] --> Queue
    GitHub[GitHub REST API] -->|Open issues and pull requests| ProviderQueue[Provider queue]
    Browser --> ProviderQueue
    Browser -->|Select code, conversations, evidence, or checklist| Detail
    GitHub -->|Provider Markdown/HTML body| Render[Marked then DOMPurify; remote images removed]
    Render --> Detail
    Browser -->|GET selected PR diff| API
    API -->|Bounded diff request| GitHub
    GitHub -->|Unified patch with hunk| Monaco
    GitHub -->|Empty or header-only patch| NoPatch[Explicit no-readable-patch state]
    NoPatch --> Detail
    Queue -->|Select run with diff| Diff[GET /api/v1/agent-runs/{id}/diff]
    Diff -->|Unified patch| Monaco[Read-only Monaco editor]
    Monaco --> Detail
    Diff -->|Count file headers and changed lines| DiffStats[Local diff summary]
    DiffStats --> Governance
    Reviewer[Developer] -->|Comment or request changes on local run| API[Agent run review API]
    API -->|Persist comment| Runs
    API -->|Request changes: requeue same run and branch| Worker[Assigned local worker]
    Worker -->|Continue same worktree with feedback prompt| Runs
    Reviewer -->|Comment or request changes on PR| ProviderReview[GitHub review API]
    Browser --> ProviderReview
    ProviderReview -->|Submit as configured token owner| GitHub
    ProviderReview -->|Match run branch and persist feedback| API
    API -->|Eligible request changes| Worker
    Reviewer -->|Comment, close, or reopen issue| IssueWrite[GitHub issue API]
    Browser --> IssueWrite
    IssueWrite -->|Submit as configured token owner| GitHub
    GitHub -. inbound reviews, checks, and merge unavailable .-> Governance
    Preview[Local ?preview=mock#reviews] -->|Fixed PR, diff, and review summary fixture| Browser
    Preview -. does not call GitHub or write review actions .-> ProviderQueue
```

Provider descriptions render as sanitized Markdown/HTML; external images are stripped. A provider diff without a unified hunk shows a clear no-readable-patch state and leaves the GitHub file-changes link available. The summary panel identifies whether its content belongs to a local branch, GitHub pull request, or GitHub issue. The Code changes, Conversations, Evidence, and Checklist controls switch the detail panel. The Code changes panel reserves a lower row for suggestions, evidence artifacts, and checklist information, with explicit unavailable states while those provider details are not synced. The Conversations view submits issue/PR feedback and shows local run comments; its composer fills the available detail width. Existing provider conversation, check, and artifact data show explicit unavailable states until synced.
The summary rail keeps evidence export and approval actions beside the checks; unavailable actions remain disabled. Its request-changes and issue-comment shortcuts open the existing Conversations composer.

At desktop widths the provider queue, diff detail, and summary panes start at 24/52/24 percent to match the supplied
layout, then resize independently with drag handles or arrow keys; the panel group fills the remaining viewport below the
review toolbar so its bottom actions stay visible. At narrower
widths they stack vertically and retain the same keyboard-accessible separators. On phone widths the detail tabs scroll
horizontally to preserve a single row. Each run stores up
to ten comments of 1,000 bytes. Local comments and request-changes are available on terminal runs with diffs; the latter
requires an online worker with model runtime and `code.write` permission. Provider-backed PR metrics remain unavailable while
local branch rows show the actual run status and project. File, added-line, and removed-line counts are derived from the
loaded local diff; truncated diffs show lower-bound counts. Risk, evidence, CI, and policy results remain unavailable.
GitHub requests use compact selectable cards so the number, status, title, author, branch, and update date stay legible in
the narrow queue. Its status chips filter the loaded provider items by open/draft pull requests or open/closed issues;
search uses the same loaded list. Local branch runs continue to use AG Grid.

On localhost, `?preview=mock#reviews` renders this same Reviews page with a fixed sample PR, diff, and summary so the
supplied visual can be reviewed without a GitHub session. The fixture is read-only, makes no provider or protected-data
requests, and is never used in the authenticated Reviews route.

## Verification

`cd dashboard && npm run test:e2e -- e2e/github-reviews.spec.ts` checks safe provider Markdown rendering, detail section controls, PR diff rendering, and review submission.
`cd dashboard && npm run test:e2e -- e2e/reviews-preview.spec.ts` checks the local visual fixture and verifies that it makes no provider reads or review writes.
`cd dashboard && npm run test:e2e -- e2e/home.spec.ts --grep 'Reviews page'` checks empty provider state and local branch diffs, comments, request-changes, disabled merge actions, and resizing.
`go test ./cmd/zenchron -run 'TestGitHub|TestAgentRunQueuePersistsAndFencesClaims'` checks review
validation/submission, persistence, runtime gating, same-run requeue, feedback prompts, and diff retrieval. The focused worker test
checks follow-up execution on the existing worktree. `npm run typecheck` validates the dashboard types.
