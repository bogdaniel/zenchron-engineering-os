package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	maxAuditRecordsReturned = 500
	maxAuditLineSize        = 64 << 10
)

// GitHub logins: letters, digits and single hyphens, at most 39 characters.
var githubLoginPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9]|-[a-z0-9]){0,38}$`)

// auditRecord is one change to the access policy: who made it, when, and what it changed. Token hashes
// are never recorded; a rotation is recorded as the fact that the token changed.
type auditRecord struct {
	Time   time.Time `json:"time"`
	Actor  string    `json:"actor"`
	Action string    `json:"action"`
	Target string    `json:"target"`
	Before any       `json:"before,omitempty"`
	After  any       `json:"after,omitempty"`
}

type userView struct {
	Login        string   `json:"login"`
	Admin        bool     `json:"admin"`
	Repositories []string `json:"repositories"`
}

// workerView is a worker grant without its token hashes.
type workerView struct {
	ID                     string     `json:"id"`
	Owner                  string     `json:"owner"`
	Repositories           []string   `json:"repositories"`
	PreviousTokenExpiresAt *time.Time `json:"previous_token_expires_at,omitempty"`
}

func (file *accessFile) userView(login string) userView {
	return userView{Login: login, Admin: slices.Contains(file.Admins, login),
		Repositories: append([]string{}, file.Users[login]...)}
}

func (grant workerGrant) view() workerView {
	view := workerView{ID: grant.ID, Owner: grant.Owner, Repositories: append([]string{}, grant.Repositories...)}
	if grant.PreviousTokenSHA256 != "" {
		view.PreviousTokenExpiresAt = grant.PreviousTokenExpiresAt
	}
	return view
}

// serveAdmin is the grant-management API. Every route requires an administrator of the current policy.
func (policy *accessPolicy) serveAdmin(w http.ResponseWriter, r *http.Request) {
	access := accessFor(r)
	if !access.admin {
		http.Error(w, "administrator access required", http.StatusForbidden)
		return
	}
	resource, name, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/"), "/")
	name = strings.ToLower(name)
	switch {
	case resource == "access" && name == "" && r.Method == http.MethodGet:
		policy.showAccess(w, access.policy)
	case resource == "audit" && name == "" && r.Method == http.MethodGet:
		policy.showAudit(w, r)
	case resource == "users" && name != "" && r.Method == http.MethodPut:
		policy.setUser(w, r, access.user, name)
	case resource == "users" && name != "" && r.Method == http.MethodDelete:
		policy.deleteUser(w, access.user, name)
	case resource == "workers" && name != "" && r.Method == http.MethodPut:
		policy.setWorker(w, r, access.user, name)
	case resource == "workers" && name != "" && r.Method == http.MethodDelete:
		policy.deleteWorker(w, access.user, name)
	default:
		http.NotFound(w, r)
	}
}

func (policy *accessPolicy) showAccess(w http.ResponseWriter, file *accessFile) {
	logins := slices.Clone(file.Admins)
	for login := range file.Users {
		logins = append(logins, login)
	}
	sort.Strings(logins)
	users := []userView{}
	for _, login := range slices.Compact(logins) {
		users = append(users, file.userView(login))
	}
	workers := []workerView{}
	for _, grant := range file.Workers {
		workers = append(workers, grant.view())
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users, "workers": workers})
}

// errAccessChange is a refused change; its text is safe to return to the administrator.
type errAccessChange struct {
	status  int
	message string
}

func (err errAccessChange) Error() string { return err.message }

// change applies one edit to the policy file and records it. The audit record is written only for a
// change that was stored, and a change whose record cannot be written is undone, so the file and the
// audit log never disagree about what an administrator did.
func (policy *accessPolicy) change(w http.ResponseWriter, actor, action, target string, edit func(file *accessFile) (before, after any, err error)) {
	policy.mu.Lock()
	defer policy.mu.Unlock()
	fail := func(err error) {
		var refused errAccessChange
		if errors.As(err, &refused) {
			http.Error(w, refused.message, refused.status)
			return
		}
		log.Printf("access policy change %s failed: %v", action, err)
		http.Error(w, "could not change the access policy", http.StatusInternalServerError)
	}
	previous, err := os.ReadFile(policy.path)
	if err != nil {
		fail(fmt.Errorf("read policy: %w", err))
		return
	}
	file, err := policy.current()
	if err != nil {
		fail(err)
		return
	}
	before, after, err := edit(file)
	if err != nil {
		fail(err)
		return
	}
	if err := file.normalize(); err != nil {
		fail(errAccessChange{http.StatusBadRequest, "the change would make the access policy invalid"})
		return
	}
	if err := writeStateFile(policy.path, file); err != nil {
		fail(fmt.Errorf("write policy: %w", err))
		return
	}
	record := auditRecord{Time: time.Now().UTC(), Actor: actor, Action: action, Target: target, Before: before, After: after}
	if err := policy.appendAudit(record); err != nil {
		if restoreErr := os.WriteFile(policy.path, previous, 0o600); restoreErr != nil {
			log.Printf("access policy change %s could not be audited (%v) or undone (%v)", action, err, restoreErr)
		}
		fail(fmt.Errorf("append audit record: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, after)
}

func (policy *accessPolicy) appendAudit(record auditRecord) error {
	line, err := json.Marshal(record)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(policy.auditPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(append(line, '\n')); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

// showAudit returns the newest records first.
// ponytail: reads the whole log to return its tail; add an index or rotate the file if it grows large.
func (policy *accessPolicy) showAudit(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if value := r.URL.Query().Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > maxAuditRecordsReturned {
			http.Error(w, "limit must be between 1 and 500", http.StatusBadRequest)
			return
		}
		limit = parsed
	}
	records := []auditRecord{}
	file, err := os.Open(policy.auditPath)
	if errors.Is(err, os.ErrNotExist) {
		writeJSON(w, http.StatusOK, records)
		return
	}
	if err != nil {
		http.Error(w, "could not read the audit log", http.StatusInternalServerError)
		return
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 4096), maxAuditLineSize)
	for scanner.Scan() {
		var record auditRecord
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			http.Error(w, "the audit log is damaged", http.StatusInternalServerError)
			return
		}
		records = append(records, record)
	}
	if err := scanner.Err(); err != nil {
		http.Error(w, "could not read the audit log", http.StatusInternalServerError)
		return
	}
	slices.Reverse(records)
	writeJSON(w, http.StatusOK, records[:min(limit, len(records))])
}

func (policy *accessPolicy) setUser(w http.ResponseWriter, r *http.Request, actor, login string) {
	var input struct {
		Admin        bool     `json:"admin"`
		Repositories []string `json:"repositories"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	if !githubLoginPattern.MatchString(login) || !validRepositoryGrants(input.Repositories) {
		http.Error(w, "login or repositories are invalid", http.StatusBadRequest)
		return
	}
	policy.change(w, actor, "user.set", login, func(file *accessFile) (any, any, error) {
		var before any
		if file.knows(login) {
			before = file.userView(login)
		}
		if !input.Admin && slices.Equal(file.Admins, []string{login}) {
			return nil, nil, errAccessChange{http.StatusConflict, "the last administrator cannot be demoted"}
		}
		file.Admins = slices.DeleteFunc(file.Admins, func(admin string) bool { return admin == login })
		if input.Admin {
			file.Admins = append(file.Admins, login)
		}
		file.Users[login] = append([]string{}, input.Repositories...)
		return before, file.userView(login), nil
	})
}

func (policy *accessPolicy) deleteUser(w http.ResponseWriter, actor, login string) {
	policy.change(w, actor, "user.delete", login, func(file *accessFile) (any, any, error) {
		if !file.knows(login) {
			return nil, nil, errAccessChange{http.StatusNotFound, "user not found"}
		}
		if slices.Equal(file.Admins, []string{login}) {
			return nil, nil, errAccessChange{http.StatusConflict, "the last administrator cannot be removed"}
		}
		before := file.userView(login)
		file.Admins = slices.DeleteFunc(file.Admins, func(admin string) bool { return admin == login })
		delete(file.Users, login)
		return before, map[string]string{"login": login, "status": "removed"}, nil
	})
}

func (policy *accessPolicy) setWorker(w http.ResponseWriter, r *http.Request, actor, id string) {
	var input struct {
		Owner        string   `json:"owner"`
		Repositories []string `json:"repositories"`
		// TokenSHA256 enrolls a new worker or rotates an enrolled worker's token. Omitted, the token stays.
		TokenSHA256 string `json:"token_sha256"`
		// RevokePreviousToken ends the rotation overlap at once.
		RevokePreviousToken bool `json:"revoke_previous_token"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	input.Owner, input.TokenSHA256 = strings.ToLower(strings.TrimSpace(input.Owner)), strings.ToLower(input.TokenSHA256)
	if !validHexID(id) || (input.Owner != "" && !githubLoginPattern.MatchString(input.Owner)) ||
		!validRepositoryGrants(input.Repositories) || (input.TokenSHA256 != "" && !validTokenHash(input.TokenSHA256)) {
		http.Error(w, "worker id, owner, repositories, or token hash are invalid", http.StatusBadRequest)
		return
	}
	action := "worker.set"
	policy.change(w, actor, action, id, func(file *accessFile) (any, any, error) {
		index := slices.IndexFunc(file.Workers, func(grant workerGrant) bool { return grant.ID == id })
		if index < 0 {
			if input.TokenSHA256 == "" {
				return nil, nil, errAccessChange{http.StatusBadRequest, "a new worker needs a token hash"}
			}
			grant := workerGrant{ID: id, TokenSHA256: input.TokenSHA256, Owner: input.Owner,
				Repositories: append([]string{}, input.Repositories...)}
			file.Workers = append(file.Workers, grant)
			return nil, workerChange{workerView: grant.view(), TokenChanged: true}, nil
		}
		grant := &file.Workers[index]
		before := grant.view()
		grant.Owner, grant.Repositories = input.Owner, append([]string{}, input.Repositories...)
		tokenChanged := input.TokenSHA256 != "" && input.TokenSHA256 != grant.TokenSHA256
		if tokenChanged {
			expires := time.Now().UTC().Add(tokenRotationOverlap)
			grant.PreviousTokenSHA256, grant.PreviousTokenExpiresAt = grant.TokenSHA256, &expires
			grant.TokenSHA256 = input.TokenSHA256
		}
		if input.RevokePreviousToken {
			grant.PreviousTokenSHA256, grant.PreviousTokenExpiresAt = "", nil
		}
		return before, workerChange{workerView: grant.view(), TokenChanged: tokenChanged,
			PreviousTokenRevoked: input.RevokePreviousToken}, nil
	})
}

// workerChange is what an audit record and the API response say about a worker change.
type workerChange struct {
	workerView
	TokenChanged         bool `json:"token_changed,omitempty"`
	PreviousTokenRevoked bool `json:"previous_token_revoked,omitempty"`
}

func (policy *accessPolicy) deleteWorker(w http.ResponseWriter, actor, id string) {
	policy.change(w, actor, "worker.delete", id, func(file *accessFile) (any, any, error) {
		index := slices.IndexFunc(file.Workers, func(grant workerGrant) bool { return grant.ID == id })
		if index < 0 {
			return nil, nil, errAccessChange{http.StatusNotFound, "worker not found"}
		}
		before := file.Workers[index].view()
		file.Workers = slices.Delete(file.Workers, index, index+1)
		return before, map[string]string{"id": id, "status": "removed"}, nil
	})
}
