package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

const systemStatusGrantLifetime = 365 * 24 * time.Hour
const maxSystemStatusGrants = 100

type systemStatusGrant struct {
	ID        string    `json:"id"`
	User      string    `json:"user"`
	TokenHash string    `json:"token_sha256"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

type systemStatusGrantStore struct {
	path string
	mu   sync.Mutex
}

type systemStatusGrantState struct {
	Version int                 `json:"version"`
	Grants  []systemStatusGrant `json:"grants"`
}

func newSystemStatusGrantStore(dataDir string) *systemStatusGrantStore {
	return &systemStatusGrantStore{path: filepath.Join(dataDir, "system-status-grants.json")}
}

func (store *systemStatusGrantStore) load() (systemStatusGrantState, error) {
	var state systemStatusGrantState
	exists, err := loadStateFile(store.path, &state)
	if err != nil {
		return state, fmt.Errorf("read menu status grants: %w", err)
	}
	if !exists {
		return systemStatusGrantState{Version: 1}, nil
	}
	if state.Version != 1 {
		return state, errors.New("menu status grant file has an unsupported version")
	}
	if err := state.validate(); err != nil {
		return state, fmt.Errorf("validate menu status grants: %w", err)
	}
	return state, nil
}

func (state systemStatusGrantState) validate() error {
	if len(state.Grants) > maxSystemStatusGrants {
		return fmt.Errorf("grant count exceeds %d", maxSystemStatusGrants)
	}
	ids := make(map[string]bool, len(state.Grants))
	for _, grant := range state.Grants {
		id, err := base64.RawURLEncoding.DecodeString(grant.ID)
		if err != nil || len(id) != 16 || ids[grant.ID] || !validTokenHash(grant.TokenHash) ||
			grant.User == "" || grant.User != strings.ToLower(strings.TrimSpace(grant.User)) ||
			grant.CreatedAt.IsZero() || grant.ExpiresAt.Sub(grant.CreatedAt) <= 0 ||
			grant.ExpiresAt.Sub(grant.CreatedAt) > systemStatusGrantLifetime {
			return errors.New("grant record is malformed")
		}
		ids[grant.ID] = true
	}
	return nil
}

func (store *systemStatusGrantStore) authenticate(token string, access *accessFile, enforced bool, allowedUsers []string) (string, bool) {
	if token == "" || len(token) > 256 {
		return "", false
	}
	digest := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(digest[:])
	store.mu.Lock()
	defer store.mu.Unlock()
	state, err := store.load()
	if err != nil {
		return "", false
	}
	now := time.Now()
	for _, grant := range state.Grants {
		if !secureEqual(grant.TokenHash, hash) || !now.Before(grant.ExpiresAt) {
			continue
		}
		if enforced {
			if access == nil || !slices.Contains(access.Admins, grant.User) {
				return "", false
			}
		} else if !slices.Contains(allowedUsers, grant.User) {
			return "", false
		}
		return grant.User, true
	}
	return "", false
}

func (store *systemStatusGrantStore) serve(w http.ResponseWriter, r *http.Request, access requestAccess) {
	if !isLoopbackRequest(r) {
		http.Error(w, "menu status pairing is available only on the local installation", http.StatusForbidden)
		return
	}
	if access.enforced && !access.admin {
		http.Error(w, "administrator access required", http.StatusForbidden)
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	state, err := store.load()
	if err != nil {
		http.Error(w, "menu status grants are unavailable", http.StatusServiceUnavailable)
		return
	}
	state.Grants = slices.DeleteFunc(state.Grants, func(grant systemStatusGrant) bool {
		return !time.Now().Before(grant.ExpiresAt)
	})
	if r.Method == http.MethodGet {
		grants := make([]struct {
			ID        string    `json:"id"`
			User      string    `json:"user"`
			CreatedAt time.Time `json:"created_at"`
			ExpiresAt time.Time `json:"expires_at"`
		}, 0, len(state.Grants))
		for _, grant := range state.Grants {
			if !access.enforced || access.admin || grant.User == access.user {
				grants = append(grants, struct {
					ID        string    `json:"id"`
					User      string    `json:"user"`
					CreatedAt time.Time `json:"created_at"`
					ExpiresAt time.Time `json:"expires_at"`
				}{ID: grant.ID, User: grant.User, CreatedAt: grant.CreatedAt, ExpiresAt: grant.ExpiresAt})
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"grants": grants})
		return
	}
	if r.Method == http.MethodPost {
		if len(state.Grants) >= maxSystemStatusGrants {
			http.Error(w, "maximum menu status grant count reached; revoke an unused grant", http.StatusConflict)
			return
		}
		token, err := randomToken(32)
		if err != nil {
			http.Error(w, "could not create menu status credential", http.StatusInternalServerError)
			return
		}
		id, err := randomToken(16)
		if err != nil {
			http.Error(w, "could not create menu status grant", http.StatusInternalServerError)
			return
		}
		digest := sha256.Sum256([]byte(token))
		createdAt := time.Now().UTC()
		grant := systemStatusGrant{ID: id, User: access.user, TokenHash: hex.EncodeToString(digest[:]),
			CreatedAt: createdAt, ExpiresAt: createdAt.Add(systemStatusGrantLifetime)}
		state.Grants = append(state.Grants, grant)
		if err := store.save(state); err != nil {
			http.Error(w, "could not save menu status grant", http.StatusInternalServerError)
			return
		}
		if err := store.audit(access.user, "created", id); err != nil {
			state.Grants = slices.DeleteFunc(state.Grants, func(item systemStatusGrant) bool { return item.ID == id })
			if rollbackErr := store.save(state); rollbackErr != nil {
				fmt.Fprintf(os.Stderr, "menu status grant audit and rollback failed: %v; %v\n", err, rollbackErr)
			}
			http.Error(w, "could not audit menu status grant", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"id": id, "credential": token, "expires_at": grant.ExpiresAt})
		return
	}
	if r.Method == http.MethodDelete {
		id := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/api/v1/system/status/credentials/"))
		if id == "" || strings.Contains(id, "/") {
			http.NotFound(w, r)
			return
		}
		previous := slices.Clone(state.Grants)
		before := len(state.Grants)
		state.Grants = slices.DeleteFunc(state.Grants, func(grant systemStatusGrant) bool {
			return grant.ID == id && (!access.enforced || access.admin || grant.User == access.user)
		})
		if len(state.Grants) == before {
			http.NotFound(w, r)
			return
		}
		if err := store.save(state); err != nil {
			http.Error(w, "could not revoke menu status grant", http.StatusInternalServerError)
			return
		}
		if err := store.audit(access.user, "revoked", id); err != nil {
			state.Grants = previous
			if restoreErr := store.save(state); restoreErr != nil {
				fmt.Fprintf(os.Stderr, "menu status grant audit and rollback failed: %v; %v\n", err, restoreErr)
			}
			http.Error(w, "grant revoked but audit recording failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
}

func (store *systemStatusGrantStore) save(state systemStatusGrantState) error {
	state.Version = 1
	if err := state.validate(); err != nil {
		return fmt.Errorf("validate menu status grants: %w", err)
	}
	return writeStateFile(store.path, state)
}

func (store *systemStatusGrantStore) audit(actor, action, target string) error {
	file, err := os.OpenFile(store.path+".audit.jsonl", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	data, err := json.Marshal(auditRecord{Time: time.Now().UTC(), Actor: actor, Action: "menu_status_" + action,
		Target: target})
	if err != nil {
		return errors.Join(err, file.Close())
	}
	data = append(data, '\n')
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	return errors.Join(writeErr, syncErr, file.Close())
}

type systemStatusGrantRequestKey struct{}

func withSystemStatusGrant(r *http.Request, user string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), systemStatusGrantRequestKey{}, user))
}

func hasSystemStatusGrant(r *http.Request) bool {
	_, ok := r.Context().Value(systemStatusGrantRequestKey{}).(string)
	return ok
}
