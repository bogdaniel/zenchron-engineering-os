package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

type agentProfile struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Description  string    `json:"description"`
	Provider     string    `json:"provider"`
	Model        string    `json:"model"`
	Status       string    `json:"status"`
	SystemPrompt string    `json:"system_prompt"`
	GoalPrompt   string    `json:"goal_prompt"`
	Tools        []string  `json:"tools"`
	Version      int       `json:"version"`
	UpdatedAt    time.Time `json:"updated_at"`
	// CreatedBy is the GitHub login that created the profile under an access policy. Every signed-in
	// user may read and run a profile; only its creator or an administrator may change it.
	CreatedBy string `json:"created_by,omitempty"`
}

type agentProfileInput struct {
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Provider     string   `json:"provider"`
	Model        string   `json:"model"`
	Status       string   `json:"status"`
	SystemPrompt string   `json:"system_prompt"`
	GoalPrompt   string   `json:"goal_prompt"`
	Tools        []string `json:"tools"`
}

type agentProfileStore struct {
	mu    sync.RWMutex
	items map[string]agentProfile
	path  string
}

const maxAgentTools = 6

func newAgentProfileStore() *agentProfileStore {
	return &agentProfileStore{items: make(map[string]agentProfile)}
}

func openAgentProfileStore(path string) (*agentProfileStore, error) {
	store := newAgentProfileStore()
	store.path = path
	var state struct {
		Version int                     `json:"version"`
		Items   map[string]agentProfile `json:"items"`
	}
	exists, err := loadStateFile(path, &state)
	if err != nil {
		return nil, fmt.Errorf("load agent profiles: %w", err)
	}
	if !exists {
		return store, nil
	}
	if state.Version != stateFileVersion || state.Items == nil {
		return nil, fmt.Errorf("load agent profiles: unsupported or invalid state")
	}
	for id, item := range state.Items {
		if id != item.ID || !validStoredAgentProfile(item) {
			return nil, fmt.Errorf("load agent profiles: invalid record %q", id)
		}
	}
	store.items = state.Items
	return store, nil
}

func (store *agentProfileStore) persistLocked() error {
	if store.path == "" {
		return nil
	}
	return writeStateFile(store.path, struct {
		Version int                     `json:"version"`
		Items   map[string]agentProfile `json:"items"`
	}{stateFileVersion, store.items})
}

func validStoredAgentProfile(item agentProfile) bool {
	id, err := hex.DecodeString(item.ID)
	if err != nil || len(id) != 16 || item.ID != strings.ToLower(item.ID) || item.Version < 1 ||
		strings.TrimSpace(item.Name) == "" || len(item.Name) > 100 || len(item.Description) > 500 ||
		!validAgentProvider(item.Provider) || !validAgentModel(item.Model) ||
		(item.Status != "active" && item.Status != "disabled") || len(item.SystemPrompt) > 20_000 ||
		len(item.GoalPrompt) > 5_000 || item.UpdatedAt.IsZero() || !validAgentTools(item.Tools) {
		return false
	}
	return true
}

func validAgentProvider(provider string) bool {
	return provider != "" && provider == strings.TrimSpace(provider) && len(provider) <= 100
}

func validAgentModel(model string) bool {
	return model != "" && model == strings.TrimSpace(model) && len(model) <= 200
}

func validAgentTools(tools []string) bool {
	if len(tools) > maxAgentTools {
		return false
	}
	seen := make(map[string]bool, len(tools))
	for _, tool := range tools {
		if !validAgentTool(tool) || seen[tool] {
			return false
		}
		seen[tool] = true
	}
	return true
}

func validAgentTool(tool string) bool {
	switch tool {
	case "code.search", "code.write", "docs.search", "git.diff", "git.read", "tests.run":
		return true
	default:
		return false
	}
}

func (store *agentProfileStore) list(w http.ResponseWriter, _ *http.Request) {
	store.mu.RLock()
	items := make([]agentProfile, 0, len(store.items))
	for _, item := range store.items {
		items = append(items, item)
	}
	store.mu.RUnlock()
	sort.Slice(items, func(i, j int) bool { return items[i].UpdatedAt.After(items[j].UpdatedAt) })
	writeJSON(w, http.StatusOK, items)
}

func (store *agentProfileStore) create(w http.ResponseWriter, r *http.Request) {
	var input agentProfileInput
	if !decodeJSONBody(w, r, &input) {
		return
	}
	profile, ok := input.profile(w)
	if !ok {
		return
	}
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		http.Error(w, "could not create agent profile id", http.StatusInternalServerError)
		return
	}
	profile.ID = hex.EncodeToString(idBytes)
	profile.Version = 1
	profile.CreatedBy = accessFor(r).creator()
	profile.UpdatedAt = time.Now().UTC()
	store.mu.Lock()
	store.items[profile.ID] = profile
	if err := store.persistLocked(); err != nil {
		delete(store.items, profile.ID)
		store.mu.Unlock()
		http.Error(w, "could not persist agent profile", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusCreated, profile)
}

func (store *agentProfileStore) update(w http.ResponseWriter, r *http.Request) {
	var input agentProfileInput
	if !decodeJSONBody(w, r, &input) {
		return
	}
	profile, ok := input.profile(w)
	if !ok {
		return
	}
	id := strings.ToLower(r.PathValue("id"))
	decoded, err := hex.DecodeString(id)
	if err != nil || len(decoded) != 16 {
		http.Error(w, "agent profile id must be 32 hexadecimal characters", http.StatusBadRequest)
		return
	}
	store.mu.Lock()
	previous, exists := store.items[id]
	if !exists {
		store.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if !accessFor(r).owns(previous.CreatedBy) {
		store.mu.Unlock()
		http.Error(w, "only the profile's creator or an administrator can change it", http.StatusForbidden)
		return
	}
	profile.ID, profile.CreatedBy = id, previous.CreatedBy
	profile.Version = previous.Version + 1
	profile.UpdatedAt = time.Now().UTC()
	store.items[id] = profile
	if err := store.persistLocked(); err != nil {
		store.items[id] = previous
		store.mu.Unlock()
		http.Error(w, "could not persist agent profile", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusOK, profile)
}

func (input agentProfileInput) profile(w http.ResponseWriter) (agentProfile, bool) {
	profile := agentProfile{
		Name: strings.TrimSpace(input.Name), Description: strings.TrimSpace(input.Description),
		Provider: strings.TrimSpace(input.Provider), Model: strings.TrimSpace(input.Model),
		Status: input.Status, SystemPrompt: strings.TrimSpace(input.SystemPrompt),
		GoalPrompt: strings.TrimSpace(input.GoalPrompt), Tools: append([]string{}, input.Tools...),
	}
	if profile.Status == "" {
		profile.Status = "active"
	}
	if profile.Name == "" || len(profile.Name) > 100 || len(profile.Description) > 500 ||
		!validAgentProvider(profile.Provider) || !validAgentModel(profile.Model) ||
		(profile.Status != "active" && profile.Status != "disabled") ||
		len(profile.SystemPrompt) > 20_000 || len(profile.GoalPrompt) > 5_000 || !validAgentTools(profile.Tools) {
		http.Error(w, "invalid agent profile fields or unsupported tools", http.StatusBadRequest)
		return agentProfile{}, false
	}
	return profile, true
}
