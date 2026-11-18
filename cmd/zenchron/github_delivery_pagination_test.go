package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestGitHubReviewAndCheckReadsIncludeLaterPages(t *testing.T) {
	pageOne := "[" + strings.TrimSuffix(strings.Repeat(`{"id":1},`, 100), ",") + "]"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("per_page") != "100" {
			t.Errorf("page size = %q", r.URL.Query().Get("per_page"))
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		switch r.URL.Path {
		case "/repos/acme/platform/pulls/12/reviews":
			if page == 1 {
				_, _ = w.Write([]byte(pageOne))
				return
			}
			_, _ = w.Write([]byte(`[{"id":101,"state":"CHANGES_REQUESTED"}]`))
		case "/repos/acme/platform/commits/" + mergeHead + "/check-runs":
			if page == 1 {
				_, _ = w.Write([]byte(`{"check_runs":[` + strings.TrimSuffix(strings.Repeat(`{"name":"ci"},`, 100), ",") + `]}`))
				return
			}
			_, _ = w.Write([]byte(`{"check_runs":[{"name":"required","status":"completed","conclusion":"failure"}]}`))
		default:
			t.Errorf("unexpected request: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := gitHubClient{apiURL: server.URL, client: server.Client()}
	reviews, err := client.pullRequestReviews(context.Background(), "acme", "platform", 12)
	if err != nil || len(reviews) != 101 || reviews[100].ID != 101 {
		t.Fatalf("reviews = %d, err = %v", len(reviews), err)
	}
	checks, err := client.commitCheckRuns(context.Background(), "acme", "platform", mergeHead)
	if err != nil || len(checks) != 101 || checks[100].Conclusion != "failure" {
		t.Fatalf("checks = %d, err = %v", len(checks), err)
	}
}

func TestGitHubReviewPaginationStopsAtBound(t *testing.T) {
	page := "[" + strings.TrimSuffix(strings.Repeat(`{"id":1},`, 100), ",") + "]"
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = fmt.Fprint(w, page)
	}))
	defer server.Close()
	client := gitHubClient{apiURL: server.URL, client: server.Client()}
	if _, err := client.pullRequestReviews(context.Background(), "acme", "platform", 12); err == nil {
		t.Fatal("pagination at the bound returned success")
	}
	if requests != maxGitHubPages {
		t.Fatalf("requests = %d, want %d", requests, maxGitHubPages)
	}
}
