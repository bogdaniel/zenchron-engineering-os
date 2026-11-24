# GitHub issue sync and pull-request reviews

The control plane reads open GitHub issues and pull requests for a selected `github.com/owner/repository` discovered by
the local worker. The Reviews dashboard can comment on an issue, close or reopen it, and submit a top-level comment or
request changes on a selected pull request.
GitHub remains authoritative for provider comments and review state. Submissions are authored as the installed GitHub
App, or as the account that owns `ZENCHRON_GITHUB_TOKEN` when the personal-token fallback is configured.

When a successful agent run changes files in a supported GitHub checkout, the worker pushes only its isolated run
branch with the workstation's configured Git credentials. The control plane uses its GitHub App installation token or
personal-token fallback to find or create the matching pull request against the run's base branch and returns its link
to Reviews. Verification has its own deadline; the push receives a fresh bounded Git deadline after verification. No
merge is performed.

```mermaid
sequenceDiagram
    participant Worker as Local worker
    participant API as Go control plane
    participant Remote as GitHub Git remote
    participant GH as GitHub REST API
    participant UI as Reviews dashboard
    Worker->>API: Heartbeat with sanitized github.com locator
    UI->>API: GET open issues and pull requests
    API->>API: Validate project locator and GitHub host
    opt GitHub App configured
        API->>API: Sign short-lived RS256 app JWT
        API->>GH: POST installation access-token endpoint
        GH-->>API: One-hour installation token
        API->>API: Cache token until one minute before expiry
    end
    API->>GH: GET open items (anonymous, App token, or PAT)
    loop Issue pages until 100 issues, a short page, or the page cap
        GH-->>API: Up to 100 recently updated issues and pull requests
        API->>API: Filter pull requests and retain up to 100 issues
    end
    API-->>UI: Provider queue data and issue-list completeness header
    UI->>UI: Search loaded titles, numbers, authors, and PR branches locally
    UI->>API: GET selected pull request diff
    API->>API: Validate project locator and pull request number
    API->>GH: GET /pulls/{number} (diff media type)
    GH-->>API: Bounded text diff
    API-->>UI: Diff for review
    UI->>API: POST PR review (COMMENT or REQUEST_CHANGES)
    API->>API: Validate repository, PR number, event, body, configured auth
    API->>GH: GET pull request head branch
    API->>GH: POST /pulls/{number}/reviews
    alt GitHub accepts the requested review event
        GH-->>API: Submitted review
    else Run-linked REQUEST_CHANGES returns HTTP 422
        GH-->>API: Request rejected
        API->>GH: POST /pulls/{number}/reviews (COMMENT fallback)
        GH-->>API: Comment submitted
    end
    opt PR branch maps to an agent run
        API->>API: Match run ID and project from isolated branch
        API->>API: Persist dashboard review feedback on the run
        opt REQUEST_CHANGES and worker can accept another code pass
            API->>API: Requeue the same run and branch
        end
    end
    API-->>UI: Submission and run-sync status
    UI->>API: POST issue comment
    API->>API: Validate local client, repository, issue number, body, configured auth
    API->>GH: GET issue and reject pull-request numbers
    API->>GH: POST /issues/{number}/comments
    GH-->>API: Created issue comment
    API-->>UI: Submission status
    UI->>API: PATCH issue state (open or closed)
    API->>API: Validate local client, repository, issue number, state, configured auth
    API->>GH: GET issue and reject pull-request numbers
    API->>GH: PATCH /issues/{number}
    GH-->>API: Updated issue
    API-->>UI: Updated state
    opt Successful non-empty agent run with configured auth and GitHub origin
        Worker->>Worker: Commit and verify; start fresh bounded push deadline
        Worker->>Remote: Push isolated run branch with local Git credentials
        Worker->>API: Report branch push result with run completion
        API->>GH: Find or create pull request for branch and base
        GH-->>API: Pull-request number and URL
        API-->>UI: Pull-request link appears in local branch review
    end
```

Endpoints:

- `GET /api/v1/projects/{id}/pull-requests`
- `GET /api/v1/projects/{id}/pull-requests/{number}/diff`
- `GET /api/v1/projects/{id}/issues`
- `POST /api/v1/projects/{id}/issues/{number}/comments`
- `PATCH /api/v1/projects/{id}/issues/{number}`
- `POST /api/v1/projects/{id}/pull-requests/{number}/reviews`

Only GitHub.com remotes with exactly an owner and repository are supported. Pull-request lists contain up to 100 open
items ordered by recent update. Issue lists scan at most 10 pages of 100 GitHub records and return up to 100 issues;
`X-Zenchron-Complete: false` tells the dashboard that the returned issue list may be incomplete. Public reads work
without credentials. Private reads need repository read access. Creating pull requests
and submitting PR reviews need **Pull requests: write**. Posting issue comments and changing issue state needs **Issues:
write** or **Pull requests: write** ([GitHub issue comments](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment), [GitHub issues](https://docs.github.com/en/rest/issues/issues#update-an-issue)). The control plane can authenticate with a GitHub App installation configured by `ZENCHRON_GITHUB_APP_ID`, `ZENCHRON_GITHUB_INSTALLATION_ID`, and `ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH`. In the managed installation, `auth github-app configure` stores the App IDs and managed key path in the existing owner-only LaunchAgent plist and copies the PEM into an owner-only file outside release directories. Reinstall and self-update preserve the plist environment; the supervisor passes these settings only to the control plane. The control plane signs an RS256 JWT, mints an installation token, and caches the token until one minute before GitHub's one-hour expiry. A configured `ZENCHRON_GITHUB_TOKEN` takes precedence as a personal-token fallback. Actions: read is optional and enables authenticated GitHub Actions history in Reports. The worker uses workstation Git credentials to push and never receives GitHub API credentials. The dashboard
never receives them either. The review body is limited to 1,000 bytes, and only `COMMENT` and `REQUEST_CHANGES` events are
accepted. The Reviews queue search filters the loaded list by item number, title, author, or pull-request source
branch without another provider request.

Submitting an issue comment, changing issue state, or submitting a PR review is an external write. Each endpoint requires a loopback client and
`application/json`; this is a local-preview guard, not user authentication. GitHub records comments and reviews under
the configured App or token actor; the current preview has no user identity or actor audit and must not be network-exposed. A worker push or PR creation failure keeps
the local diff available and is shown on the branch review. When a review is submitted from the dashboard for a
Zenchron-created PR, the control plane matches its isolated branch to the originating run and persists the comment.
`REQUEST_CHANGES` requeues that same run and branch when the worker is online with the profile's coding CLI ready, the profile has write permission,
and has attempts remaining. If the worker cannot accept another pass, the feedback is still stored and the dashboard
reports that no run was queued. If GitHub rejects a run-linked `REQUEST_CHANGES` with HTTP 422, the control plane
submits a `COMMENT` review instead, then records the change request on the run; the dashboard says GitHub recorded a
comment while the run queued or stored the requested changes. Other HTTP 422 review failures identify the pull-request
state and reviewer-permission check. GitHub reviews made directly on github.com are not yet imported; webhook or provider
polling is not implemented. Approve and merge are not enabled; Reviews shows both controls disabled in Live and states
the reason. Issue comments are submitted as top-level comments
authored as the configured App or personal-token owner.

Issue comment and state endpoints fetch the selected issue first and reject numbers that resolve to pull requests. GitHub's
[Issues API also includes pull requests](https://docs.github.com/en/rest/issues/issues), so UI filtering alone is not a
sufficient boundary.

## Verification

`go test ./cmd/zenchron -run 'TestGitHub|TestListGitHubIssuesPaginatesPastPullRequestsAndReportsTruncation' -count=1` verifies GitHub request headers, repository mapping, issue/PR
separation, bounded PR diff reads, issue-comment and issue-state payloads, PR-number rejection, review payloads, and
local-client/auth/event validation, including the linked-run 422-to-comment fallback and persisted change request. It
also verifies GitHub App JWT signature and claims, installation-token caching,
configuration validation, and private-key file permissions using a local fake GitHub server. `cd dashboard && npm run test:e2e -- e2e/github-reviews.spec.ts` checks live queue rendering, issue comments,
close/reopen, both provider review actions, and the write requests they send. The focused `home.spec.ts`
Reviews test covers unavailable state and local-branch review. These checks use fixtures; a real provider write and
private repository are not verified.

The diff read uses GitHub's [`application/vnd.github.diff` media type](https://docs.github.com/en/rest/pulls/pulls) on
the get-a-pull-request endpoint. The REST API also follows GitHub's
[pull-request reviews](https://docs.github.com/en/rest/pulls/reviews) and
[issues](https://docs.github.com/en/rest/issues/issues) endpoints.
