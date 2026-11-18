package main

import (
	"strings"
	"testing"
	"time"
)

func TestHumanReviewStageAfterRemediationWaitsForApproval(t *testing.T) {
	newHead := strings.Repeat("c", 40)
	item := agentRun{Status: "succeeded", CommitSHA: newHead, ImportedReviewID: 12}
	reviews := []gitHubReview{{ID: 12, State: "CHANGES_REQUESTED", CommitID: testCommit, AuthorAssociation: "MEMBER"}}
	reviews[0].User.Login = "reviewer"
	if stage := humanReviewStage(item, newHead, reviews); stage != "awaiting_human_rereview" || outstandingChangeRequest(reviews) == "" {
		t.Fatalf("remediated review stage = %q, expected human re-review with merge blocked", stage)
	}
	reviews = append(reviews, gitHubReview{ID: 99, State: "CHANGES_REQUESTED", CommitID: newHead, AuthorAssociation: "NONE"})
	if stage := humanReviewStage(item, newHead, reviews); stage != "awaiting_human_rereview" {
		t.Fatalf("untrusted review changed human review stage to %q", stage)
	}
	approval := gitHubReview{ID: 13, State: "APPROVED", CommitID: newHead, AuthorAssociation: "OWNER"}
	approval.User.Login = "reviewer"
	reviews = append(reviews, approval)
	if stage := humanReviewStage(item, newHead, reviews); stage != "fresh_approval_received" {
		t.Fatalf("fresh approval stage = %q", stage)
	}
	decision := func(id int64, state, commit, login string, minute int) gitHubReview {
		review := gitHubReview{ID: id, State: state, CommitID: commit, AuthorAssociation: "MEMBER",
			SubmittedAt: time.Date(2026, 11, 17, 12, minute, 0, 0, time.UTC)}
		review.User.Login = login
		return review
	}
	for _, test := range []struct {
		name    string
		reviews []gitHubReview
	}{
		{name: "newer request from another reviewer", reviews: []gitHubReview{
			decision(12, "CHANGES_REQUESTED", testCommit, "reviewer-a", 0),
			decision(20, "APPROVED", newHead, "reviewer-b", 1),
			decision(21, "CHANGES_REQUESTED", newHead, "reviewer-c", 2),
		}},
		{name: "later approval does not clear another reviewer's outstanding request", reviews: []gitHubReview{
			decision(12, "CHANGES_REQUESTED", testCommit, "reviewer-a", 0),
			decision(21, "CHANGES_REQUESTED", newHead, "reviewer-c", 1),
			decision(22, "APPROVED", newHead, "reviewer-b", 2),
		}},
		{name: "newer request from the approving reviewer", reviews: []gitHubReview{
			decision(12, "CHANGES_REQUESTED", testCommit, "reviewer-a", 0),
			decision(20, "APPROVED", newHead, "reviewer-a", 1),
			decision(21, "CHANGES_REQUESTED", newHead, "reviewer-a", 2),
		}},
		{name: "comment does not clear a request", reviews: []gitHubReview{
			decision(12, "CHANGES_REQUESTED", testCommit, "reviewer-a", 0),
			decision(20, "CHANGES_REQUESTED", newHead, "reviewer-a", 1),
			decision(21, "COMMENTED", newHead, "reviewer-a", 2),
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if stage := humanReviewStage(item, newHead, test.reviews); stage != "feedback_not_addressed" {
				t.Fatalf("stage = %q; newer unresolved feedback must remain visible", stage)
			}
		})
	}
}
