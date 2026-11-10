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

// accessFile is the operator-maintained record of who may do what. It is the single authority for
// worker identity and for which repositories a user or worker may touch.
type accessFile struct {
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
}

// accessPolicy reloads the access file when it changes, so removing a grant revokes it without a
// restart. An unreadable or invalid file denies everything until it is fixed.
// ponytail: one stat per request; replace with a database table when grants are edited through an API.
type accessPolicy struct {
	path string

	mu       sync.Mutex
	modTime  time.Time
	size     int64
	snapshot *accessFile
}

func loadAccessPolicy() (*accessPolicy, error) {
	path := strings.TrimSpace(os.Getenv("ZENCHRON_ACCESS_FILE"))
	if path == "" {
		return nil, nil
	}
	policy := &accessPolicy{path: path}
	if _, err := policy.current(); err != nil {
		return nil, err
	}
	return policy, nil
}

func (policy *accessPolicy) current() (*accessFile, error) {
	policy.mu.Lock()
	defer policy.mu.Unlock()
	info, err := os.Stat(policy.path)
	if err != nil {
		policy.snapshot = nil
		return nil, fmt.Errorf("inspect ZENCHRON_ACCESS_FILE: %w", err)
	}
	if policy.snapshot != nil && info.ModTime().Equal(policy.modTime) && info.Size() == policy.size {
		return policy.snapshot, nil
	}
	var file accessFile
	policy.snapshot = nil
	if exists, err := loadStateFile(policy.path, &file); err != nil || !exists {
		return nil, fmt.Errorf("load ZENCHRON_ACCESS_FILE: %v", err)
	}
	if err := file.normalize(); err != nil {
		return nil, fmt.Errorf("ZENCHRON_ACCESS_FILE: %w", err)
	}
	policy.snapshot, policy.modTime, policy.size = &file, info.ModTime(), info.Size()
	return policy.snapshot, nil
}

func (file *accessFile) normalize() error {
	seen := map[string]bool{}
	for index := range file.Workers {
		grant := &file.Workers[index]
		grant.ID, grant.TokenSHA256 = strings.ToLower(grant.ID), strings.ToLower(grant.TokenSHA256)
		grant.Owner = strings.ToLower(strings.TrimSpace(grant.Owner))
		digest, err := hex.DecodeString(grant.TokenSHA256)
		if !validHexID(grant.ID) || err != nil || len(digest) != sha256.Size || seen[grant.ID] {
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
	return nil
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
		if (id == "" || grant.ID == id) && secureEqual(grant.TokenSHA256, presented) {
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
	return !access.enforced || (repository != "" && slices.Contains(access.repositories, repository))
}

// mayDispatchTo reports whether the user may start work on a worker: their own, or a shared one.
func (access requestAccess) mayDispatchTo(workerID string) bool {
	if !access.enforced {
		return true
	}
	grant, enrolled := access.policy.worker(workerID)
	return enrolled && (grant.Owner == "" || grant.Owner == access.user)
}
