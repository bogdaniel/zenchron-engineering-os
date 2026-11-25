package main

import (
	"slices"
	"strings"
	"time"
)

type publicationAuthorization struct {
	CommitSHA string `json:"commit_sha"`
	GraphID   string `json:"graph_id,omitempty"`
	// GraphRevision records the state seen by the person; ordinary projection changes do not revoke authority.
	GraphRevision int       `json:"graph_revision,omitempty"`
	PlanRevision  int       `json:"plan_revision,omitempty"`
	PlanHash      string    `json:"plan_hash,omitempty"`
	By            string    `json:"by"`
	At            time.Time `json:"at"`
	Attempt       int       `json:"attempt"`
}

func validPublicationAuthorizations(authorizations []publicationAuthorization, attempts int) bool {
	if len(authorizations) > maxAgentRunAttempts {
		return false
	}
	for _, authorization := range authorizations {
		if !fullGitSHA(authorization.CommitSHA) || strings.TrimSpace(authorization.By) == "" ||
			len(authorization.By) > 100 || authorization.At.IsZero() || authorization.Attempt < 1 ||
			authorization.Attempt > attempts || (authorization.GraphID == "" && (authorization.GraphRevision != 0 ||
			authorization.PlanRevision != 0 || authorization.PlanHash != "")) ||
			(authorization.GraphID != "" && (!validHexID(authorization.GraphID) || authorization.GraphRevision < 1 ||
				authorization.PlanRevision < 1 || authorization.PlanHash == "" || len(authorization.PlanHash) > 128)) {
			return false
		}
	}
	return true
}

func (item agentRun) publicationAuthorized(commitSHA string) bool {
	return slices.ContainsFunc(item.PublicationAuthorizations, func(authorization publicationAuthorization) bool {
		return authorization.CommitSHA == commitSHA
	})
}

func (item agentRun) publicationAuthorizedFor(commitSHA, graphID string, planRevision int, planHash string) bool {
	return slices.ContainsFunc(item.PublicationAuthorizations, func(authorization publicationAuthorization) bool {
		return authorization.CommitSHA == commitSHA && authorization.GraphID == graphID &&
			authorization.PlanRevision == planRevision && authorization.PlanHash == planHash
	})
}

// graphPublicationAttemptActiveLocked requires the run-store lock.
func (store *agentRunStore) graphPublicationAttemptActiveLocked(graphID string) bool {
	for _, item := range store.items {
		if item.GraphID == graphID && (item.Publishing || item.Status == "running" && item.PublishOnly) {
			return true
		}
	}
	return false
}

// graphPublicationInProgress reports an external PR operation that graph cancellation cannot undo.
func (store *agentRunStore) graphPublicationInProgress(graphID string) bool {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.graphPublicationAttemptActiveLocked(graphID) {
		return true
	}
	for _, item := range store.items {
		if item.GraphID == graphID && item.PullRequestURL != "" {
			return true
		}
	}
	return false
}
