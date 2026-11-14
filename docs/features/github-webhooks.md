# GitHub webhooks: reviews and CI results

GitHub tells the control plane when a review is submitted on a run's pull request and when a check run finishes on
its commit. A change request from someone who can push to the repository queues a follow-up attempt of the same run,
on the same branch and pull request, without anyone copying the review into Zenchron. Check results are stored with
the run as evidence. Nothing is merged, and a failed check never starts work by itself.

## Feature diagram

```mermaid
sequenceDiagram
  actor Reviewer
  participant GH as GitHub
  participant API as Control plane: POST /api/v1/github/webhook
  participant Deliveries as agent-runs.json.deliveries
  participant Runs as agent-runs.json + events
  participant Policy as Access policy
  participant Worker as zenchron-worker
  Reviewer->>GH: Submit review "Request changes" on the run's pull request
  GH->>API: pull_request_review (X-Hub-Signature-256, X-GitHub-Delivery)
  API->>API: HMAC-SHA256 of the raw body with ZENCHRON_GITHUB_WEBHOOK_SECRET
  API->>Deliveries: Delivery id seen before? then answer "duplicate"
  API->>Runs: Find the run by repository + pull request number
  API->>API: Branch and review commit must equal the run's branch and published commit
  API->>API: Reviewer must be OWNER, MEMBER, or COLLABORATOR
  API->>Policy: May the user who started the run still touch the repository and the worker?
  API->>Runs: Append feedback, store the review, queue attempt N+1 (at most 3 attempts)
  API->>Deliveries: Remember the delivery id
  Worker->>API: POST /api/v1/workers/{id}/agent-runs/claim
  API-->>Worker: Prompt including "Requested changes: <reviewer> on GitHub: ..."
  Worker->>GH: git push to the same run branch (updates the pull request)
  GH->>API: check_run completed for the new head commit
  API->>Runs: Store the check on the run; a failure is written to the event log
```

## Setup

1. Choose a secret of at least 16 bytes and set `ZENCHRON_GITHUB_WEBHOOK_SECRET` on the control plane. Without it the
   endpoint answers 404.
2. In the repository or the GitHub App, add a webhook to `<control plane origin>/api/v1/github/webhook` with content
   type `application/json`, the same secret, and the events **Pull request reviews** and **Check runs**.
3. GitHub must be able to reach the control plane. A loopback control plane can be reached through a tunnel, or
   deliveries can be replayed by hand with a signed request; `POST /api/v1/agent-runs/{id}/sync-reviews` remains the
   fallback that imports change requests on demand.

## Behavior

- A delivery without a valid `X-Hub-Signature-256` over the exact body is refused with 401 and changes nothing.
- Each `X-GitHub-Delivery` id is handled once. The newest 5,000 ids are kept in `agent-runs.json.deliveries` and
  survive a restart. The same review or check arriving under a new delivery id is also applied only once.
- A delivery that does not match a run is acknowledged with 200 and ignored, so GitHub does not retry it: another
  repository, another pull request, another branch, a commit that is not the run's current published commit, or a
  check run GitHub lists for a different pull request.
- **Reviews.** Only reviews from repository owners, members, and collaborators are used. A change request with text
  is appended to the run's feedback once and queues a follow-up attempt when the run is finished, has attempts left
  (three per run), its worker reports the provider ready, and the user who started the run may still touch the
  repository and dispatch to that worker under the current access policy. Otherwise the text is kept as feedback and
  nothing is queued. A run started without an access policy has no recorded creator; under a policy its reviews are
  kept as feedback only. Approvals and comment reviews are stored as observations.
- A review that arrives while an attempt is still running is stored but not imported; `sync-reviews` imports it later.
- **Check runs.** A completed check run for the run's published commit is stored on the run by name; a later result
  for the same check replaces an earlier one, an earlier one arriving late is ignored, and results for a commit the
  run has replaced are dropped. A conclusion other than success, neutral, or skipped is also written to the run's
  event log. Checks never change the run's status or queue an attempt.
- The webhook is not a session: it can only be posted to, and it grants no API access.
- A queued follow-up is still subject to the checks every claim makes: it is handed only to the run's worker, and
  only while that worker is granted the repository.
- The run exposes `github_reviews` (`id`, `state`, `author`, `commit_sha`, `submitted_at`, `imported`, `queued`) and
  `checks` (`name`, `status`, `conclusion`, `url`, `commit_sha`, `completed_at`) in `GET /api/v1/agent-runs`.

## Verification

- `go test ./cmd/zenchron -run TestWebhook -count=1` uses signed fixtures against the real control-plane handlers and
  a fake GitHub API: unsigned, wrongly signed, and tampered deliveries; a disabled endpoint; a change request that
  queues exactly one follow-up and whose replay changes nothing; the follow-up prompt and the new commit on the same
  pull request; a stale review of the previous commit; the three-attempt limit; reviews for another repository, pull
  request, branch, or commit and from outsiders; approvals and comments; failed, out-of-order, foreign, and rerun
  check runs; delivery ids surviving a restart; and a run whose creator lost and regained repository access.
