package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
)

type trustedBranch struct {
	Name      string `json:"name"`
	Protected bool   `json:"protected"`
	Commit    struct {
		SHA    string `json:"sha"`
		Commit struct {
			Tree struct {
				SHA string `json:"sha"`
			} `json:"tree"`
		} `json:"commit"`
	} `json:"commit"`
}

type requiredChecks struct {
	Contexts []string `json:"contexts"`
	Checks   []struct {
		Context string `json:"context"`
		AppID   int    `json:"app_id"`
	} `json:"checks"`
}

type branchRules []struct {
	Type       string `json:"type"`
	Parameters struct {
		RequiredStatusChecks []struct {
			Context       string `json:"context"`
			IntegrationID int    `json:"integration_id"`
		} `json:"required_status_checks"`
	} `json:"parameters"`
}

const githubUpdatePageSize, githubUpdateMaxPages = 100, 100

func (client gitHubClient) trustedMain(ctx context.Context, repository string) (updater.Candidate, error) {
	candidate := updater.Candidate{Repository: repository}
	if err := updater.ValidateRepository(repository); err != nil {
		return updater.Candidate{}, err
	}
	if !client.authConfigured() {
		return updater.Candidate{}, errors.New("GitHub authentication is required to verify protected main")
	}
	base := "/repos/" + repository
	var branch trustedBranch
	if err := client.getJSON(ctx, base+"/branches/main", &branch); err != nil {
		return updater.Candidate{}, fmt.Errorf("read trusted main: %w", err)
	}
	if branch.Name != "main" || branch.Commit.SHA == "" || branch.Commit.Commit.Tree.SHA == "" {
		return updater.Candidate{}, errors.New("GitHub returned an incomplete main revision")
	}
	candidate.Commit, candidate.Tree = strings.ToLower(branch.Commit.SHA), strings.ToLower(branch.Commit.Commit.Tree.SHA)
	if err := candidate.Validate(); err != nil {
		return updater.Candidate{}, fmt.Errorf("GitHub returned an invalid main revision: %w", err)
	}
	var commit struct {
		SHA    string `json:"sha"`
		Commit struct {
			Tree struct {
				SHA string `json:"sha"`
			} `json:"tree"`
			Verification struct {
				Verified bool `json:"verified"`
			} `json:"verification"`
		} `json:"commit"`
	}
	if err := client.getJSON(ctx, base+"/commits/"+candidate.Commit, &commit); err != nil {
		return updater.Candidate{}, fmt.Errorf("verify main commit metadata: %w", err)
	}
	if strings.ToLower(commit.SHA) != candidate.Commit || strings.ToLower(commit.Commit.Tree.SHA) != candidate.Tree ||
		!commit.Commit.Verification.Verified {
		return updater.Candidate{}, errors.New("GitHub cannot verify the exact main commit, tree and signature")
	}
	var rules branchRules
	for page := 1; page <= githubUpdateMaxPages; page++ {
		var pageRules branchRules
		query := url.Values{"per_page": {strconv.Itoa(githubUpdatePageSize)}, "page": {strconv.Itoa(page)}}
		rulesErr := client.getJSONQuery(ctx, base+"/rules/branches/main", query, &pageRules)
		if rulesErr != nil {
			if page == 1 && githubNotFound(rulesErr) {
				break
			}
			return updater.Candidate{}, fmt.Errorf("verify main rulesets: %w", rulesErr)
		}
		rules = append(rules, pageRules...)
		if len(pageRules) < githubUpdatePageSize {
			break
		}
		if page == githubUpdateMaxPages {
			return updater.Candidate{}, errors.New("main branch rules exceeded the bounded pagination limit")
		}
	}
	checks := requiredChecks{}
	for _, rule := range rules {
		if rule.Type != "required_status_checks" {
			continue
		}
		for _, check := range rule.Parameters.RequiredStatusChecks {
			if check.Context != "" {
				checks.Checks = append(checks.Checks, struct {
					Context string `json:"context"`
					AppID   int    `json:"app_id"`
				}{Context: check.Context, AppID: check.IntegrationID})
			}
		}
	}
	var protection struct {
		Required requiredChecks `json:"required_status_checks"`
	}
	protectionErr := client.getJSON(ctx, base+"/branches/main/protection", &protection)
	if protectionErr != nil && !githubNotFound(protectionErr) {
		return updater.Candidate{}, fmt.Errorf("verify main branch protection: %w", protectionErr)
	}
	if protectionErr != nil && branch.Protected {
		return updater.Candidate{}, errors.New("main is protected but its branch-protection checks are unreadable; grant the GitHub App Administration: read permission")
	}
	checks.Contexts = append(checks.Contexts, protection.Required.Contexts...)
	checks.Checks = append(checks.Checks, protection.Required.Checks...)
	if err := client.verifyRequiredChecks(ctx, base, candidate.Commit, checks); err != nil {
		return updater.Candidate{}, err
	}
	var pulls []struct {
		MergedAt *string `json:"merged_at"`
		Base     struct {
			Ref string `json:"ref"`
		} `json:"base"`
	}
	if err := client.getJSON(ctx, base+"/commits/"+candidate.Commit+"/pulls", &pulls); err != nil {
		return updater.Candidate{}, fmt.Errorf("verify merged pull request for main: %w", err)
	}
	for _, pull := range pulls {
		if pull.MergedAt != nil && pull.Base.Ref == "main" {
			return candidate, nil
		}
	}
	return updater.Candidate{}, errors.New("trusted main revision is not associated with a merged PR targeting main")
}

func verifyCurrentTrustedCandidate(ctx context.Context, client gitHubClient, candidate updater.Candidate) error {
	latest, err := client.trustedMain(ctx, candidate.Repository)
	if err != nil {
		return fmt.Errorf("trusted main is no longer verifiable: %w", err)
	}
	if latest.Commit != candidate.Commit || latest.Tree != candidate.Tree {
		return errors.New("trusted main advanced during release preparation")
	}
	return nil
}

func (client gitHubClient) gitFetchCredential(ctx context.Context) (string, error) {
	if client.token != "" {
		return client.token, nil
	}
	if client.appAuth == nil || !client.appAuth.configured() {
		return "", errors.New("GitHub authentication is required to fetch the trusted source")
	}
	return client.appAuth.accessToken(ctx, client)
}

func (client gitHubClient) verifyRequiredChecks(ctx context.Context, base, commit string, required requiredChecks) error {
	type checkKey struct {
		name  string
		appID int
	}
	type checkResult struct {
		updated time.Time
		success bool
		seen    bool
	}
	checks := make(map[checkKey]struct{}, len(required.Contexts)+len(required.Checks))
	for _, context := range required.Contexts {
		checks[checkKey{name: context, appID: -1}] = struct{}{}
	}
	for _, check := range required.Checks {
		appID := check.AppID
		if appID == 0 {
			appID = -1
		}
		checks[checkKey{name: check.Context, appID: appID}] = struct{}{}
	}
	if len(checks) == 0 {
		return errors.New("trusted main has no required status checks configured")
	}
	newest := func(previous checkResult, updated time.Time, success bool) checkResult {
		if previous.seen && updated.Before(previous.updated) {
			return previous
		}
		if previous.seen && updated.Equal(previous.updated) && !success {
			return checkResult{updated: updated, seen: true}
		}
		return checkResult{updated: updated, success: success, seen: true}
	}
	// ponytail: caps this commit-scoped verification at 10,000 results; increase only for repositories that exceed it.
	statuses := make(map[checkKey]checkResult)
	for page := 1; page <= githubUpdateMaxPages; page++ {
		var pageStatuses []struct {
			Context   string    `json:"context"`
			State     string    `json:"state"`
			UpdatedAt time.Time `json:"updated_at"`
		}
		query := url.Values{"per_page": {strconv.Itoa(githubUpdatePageSize)}, "page": {strconv.Itoa(page)}}
		if err := client.getJSONQuery(ctx, base+"/commits/"+commit+"/statuses", query, &pageStatuses); err != nil {
			return fmt.Errorf("read main commit statuses: %w", err)
		}
		for _, status := range pageStatuses {
			key := checkKey{name: status.Context, appID: -1}
			if _, required := checks[key]; !required {
				continue
			}
			statuses[key] = newest(statuses[key], status.UpdatedAt, status.State == "success")
		}
		if len(pageStatuses) < githubUpdatePageSize {
			break
		}
		if page == githubUpdateMaxPages {
			return errors.New("main commit statuses exceeded the bounded pagination limit")
		}
	}
	runs := make(map[checkKey]checkResult)
	for page := 1; page <= githubUpdateMaxPages; page++ {
		var pageResult struct {
			CheckRuns []struct {
				Name       string `json:"name"`
				Status     string `json:"status"`
				Conclusion string `json:"conclusion"`
				App        struct {
					ID int `json:"id"`
				} `json:"app"`
			} `json:"check_runs"`
		}
		query := url.Values{"per_page": {strconv.Itoa(githubUpdatePageSize)}, "page": {strconv.Itoa(page)}}
		if err := client.getJSONQuery(ctx, base+"/commits/"+commit+"/check-runs", query, &pageResult); err != nil {
			return fmt.Errorf("read main commit check runs: %w", err)
		}
		for _, check := range pageResult.CheckRuns {
			for key := range checks {
				if key.name != check.Name || (key.appID != -1 && key.appID != check.App.ID) {
					continue
				}
				passed := check.Status == "completed" && check.Conclusion == "success"
				previous := runs[key]
				runs[key] = checkResult{success: passed, seen: true}
				if previous.seen {
					runs[key] = checkResult{success: previous.success && passed, seen: true}
				}
			}
		}
		if len(pageResult.CheckRuns) < githubUpdatePageSize {
			break
		}
		if page == githubUpdateMaxPages {
			return errors.New("main commit check runs exceeded the bounded pagination limit")
		}
	}
	for key := range checks {
		status, hasStatus := statuses[key]
		run, hasRun := runs[key]
		if (!hasStatus && !hasRun) || (hasStatus && !status.success) || (hasRun && !run.success) {
			return fmt.Errorf("required main check %q is not successful", key.name)
		}
	}
	return nil
}

func (client gitHubClient) getJSON(ctx context.Context, path string, target any) error {
	return client.getJSONQuery(ctx, path, nil, target)
}

func (client gitHubClient) getJSONQuery(ctx context.Context, path string, query url.Values, target any) error {
	body, err := client.requestBytes(ctx, http.MethodGet, path, "application/vnd.github+json", query, nil)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, target); err != nil {
		return fmt.Errorf("decode GitHub response: %w", err)
	}
	return nil
}

func githubNotFound(err error) bool {
	return err != nil && strings.Contains(err.Error(), "GitHub returned HTTP 404")
}
