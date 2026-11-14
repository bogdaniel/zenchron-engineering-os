package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
)

// tokenRotationOverlap is how long a worker's previous token stays valid after a new one is set, so the
// worker can be restarted with the new token without an outage.
const tokenRotationOverlap = 24 * time.Hour

// accessFile is the record of who may do what. It is the single authority for administrators, worker
// identity, and which repositories a user or worker may touch. An operator seeds it with the first
// administrator; after that it is changed through the admin API, which audits every change.
type accessFile struct {
	// Admins may change this policy and may read and change everything it protects.
	Admins  []string            `json:"admins,omitempty"`
	Workers []workerGrant       `json:"workers"`
	Users   map[string][]string `json:"users"`
}

// workerGrant enrolls one worker. The control plane stores only a hash of the worker's token. An empty
// owner marks a shared execution machine that any user with repository access may dispatch to.
type workerGrant struct {
	ID           string   `json:"id"`
	TokenSHA256  string   `json:"token_sha256"`
	Owner        string   `json:"owner"`
	Repositories []string `json:"repositories"`
	// The token replaced by the last rotation is accepted until it expires.
	PreviousTokenSHA256    string     `json:"previous_token_sha256,omitempty"`
	PreviousTokenExpiresAt *time.Time `json:"previous_token_expires_at,omitempty"`
}

// accessPolicy reads the access file on every request, so removing a grant revokes it without a
// restart. An unreadable or invalid file denies everything until it is fixed.
// ponytail: one small file read per request and one writer at a time; move grants to a database table
// together with the rest of the state when the control plane gets more than one instance.
type accessPolicy struct {
	path string
	// auditPath is the append-only record of changes made through the admin API.
	auditPath string
	// mu serializes changes: each one reads, edits, and replaces the whole file.
	mu sync.Mutex
}

func loadAccessPolicy() (*accessPolicy, error) {
	path := strings.TrimSpace(os.Getenv("ZENCHRON_ACCESS_FILE"))
	if path == "" {
		return nil, nil
	}
	policy := &accessPolicy{path: path, auditPath: path + ".audit.jsonl"}
	if _, err := policy.current(); err != nil {
		return nil, err
	}
	return policy, nil
}

func (policy *accessPolicy) current() (*accessFile, error) {
	var file accessFile
	exists, err := loadStateFile(policy.path, &file)
	if err != nil {
		return nil, fmt.Errorf("load ZENCHRON_ACCESS_FILE: %w", err)
	}
	if !exists {
		return nil, fmt.Errorf("ZENCHRON_ACCESS_FILE does not exist")
	}
	if err := file.normalize(); err != nil {
		return nil, fmt.Errorf("ZENCHRON_ACCESS_FILE: %w", err)
	}
	return &file, nil
}

func (file *accessFile) normalize() error {
	seen := map[string]bool{}
	for index := range file.Workers {
		grant := &file.Workers[index]
		grant.ID, grant.TokenSHA256 = strings.ToLower(grant.ID), strings.ToLower(grant.TokenSHA256)
		grant.Owner = strings.ToLower(strings.TrimSpace(grant.Owner))
		grant.PreviousTokenSHA256 = strings.ToLower(grant.PreviousTokenSHA256)
		if !validHexID(grant.ID) || !validTokenHash(grant.TokenSHA256) || seen[grant.ID] ||
			(grant.PreviousTokenSHA256 != "" && (!validTokenHash(grant.PreviousTokenSHA256) || grant.PreviousTokenExpiresAt == nil)) {
			return fmt.Errorf("worker %d needs a unique 32-hex id and a SHA-256 token hash", index)
		}
		seen[grant.ID] = true
		if !validRepositoryGrants(grant.Repositories) {
			return fmt.Errorf("worker %s lists an invalid repository", grant.ID)
		}
	}
	users := make(map[string][]string, len(file.Users))
	for login, repositories := range file.Users {
		login = strings.ToLower(strings.TrimSpace(login))
		if login == "" || !validRepositoryGrants(repositories) {
			return fmt.Errorf("user %q is blank or lists an invalid repository", login)
		}
		users[login] = repositories
	}
	file.Users = users
	for index, login := range file.Admins {
		file.Admins[index] = strings.ToLower(strings.TrimSpace(login))
		if file.Admins[index] == "" {
			return fmt.Errorf("administrator %d is blank", index)
		}
	}
	return nil
}

func validTokenHash(value string) bool {
	digest, err := hex.DecodeString(value)
	return err == nil && len(digest) == sha256.Size
}

// knows reports whether a GitHub login appears in the policy at all, which is what lets it keep a session.
func (file *accessFile) knows(login string) bool {
	_, granted := file.Users[login]
	return granted || slices.Contains(file.Admins, login)
}

func validRepositoryGrants(repositories []string) bool {
	return !slices.ContainsFunc(repositories, func(repository string) bool {
		return repository == "" || !validGitRemote(repository)
	})
}

func (file *accessFile) worker(id string) (workerGrant, bool) {
	index := slices.IndexFunc(file.Workers, func(grant workerGrant) bool { return grant.ID == id })
	if index < 0 {
		return workerGrant{}, false
	}
	return file.Workers[index], true
}

// authenticateWorker binds a bearer token to exactly one enrolled worker id. An empty id accepts any
// enrolled worker and is used only for the worker readiness probe.
func (file *accessFile) authenticateWorker(id, authorization string) (workerGrant, bool) {
	parts := strings.Fields(authorization)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return workerGrant{}, false
	}
	digest := sha256.Sum256([]byte(parts[1]))
	presented := hex.EncodeToString(digest[:])
	for _, grant := range file.Workers {
		if id != "" && grant.ID != id {
			continue
		}
		previousValid := grant.PreviousTokenSHA256 != "" && grant.PreviousTokenExpiresAt != nil &&
			time.Now().Before(*grant.PreviousTokenExpiresAt)
		if secureEqual(grant.TokenSHA256, presented) || (previousValid && secureEqual(grant.PreviousTokenSHA256, presented)) {
			return grant, true
		}
	}
	return workerGrant{}, false
}

// requestAccess is what the authenticated caller of one request may touch. The zero value is the
// unrestricted local workspace: no authentication is configured and the listener is loopback-only.
type requestAccess struct {
	enforced     bool
	user         string
	admin        bool
	repositories []string
	policy       *accessFile
}

type requestAccessKey struct{}

func withRequestAccess(r *http.Request, access requestAccess) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), requestAccessKey{}, access))
}

func accessFor(r *http.Request) requestAccess {
	access, _ := r.Context().Value(requestAccessKey{}).(requestAccess)
	return access
}

func (access requestAccess) allows(repository string) bool {
	return !access.enforced || access.admin || (repository != "" && slices.Contains(access.repositories, repository))
}

// owns reports whether the caller may change a definition created by createdBy: its creator or an
// administrator. A definition without a recorded creator predates the policy and is left to administrators.
func (access requestAccess) owns(createdBy string) bool {
	return !access.enforced || access.admin || (createdBy != "" && createdBy == access.user)
}

// creator is what a new definition records as its creator.
func (access requestAccess) creator() string {
	return access.user
}

// mayDispatchTo reports whether the user may start work on a worker: their own, or a shared one.
func (access requestAccess) mayDispatchTo(workerID string) bool {
	if !access.enforced {
		return true
	}
	grant, enrolled := access.policy.worker(workerID)
	return enrolled && (grant.Owner == "" || grant.Owner == access.user)
}
