package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

type product struct {
	ID                    string   `json:"id"`
	Name                  string   `json:"name"`
	Description           string   `json:"description"`
	ConfigurationRevision int      `json:"configuration_revision"`
	DefaultWorkflowID     string   `json:"default_workflow_id,omitempty"`
	RepositoryIDs         []string `json:"repository_ids"`
	// ponytail: history is bounded by maxStateFileSize; add archival only if product edits approach that limit.
	ConfigurationHistory []productConfigurationRevision `json:"configuration_history,omitempty"`
	CreatedAt            time.Time                      `json:"created_at"`
	UpdatedAt            time.Time                      `json:"updated_at"`
	// CreatedBy is the GitHub login that created the product under an access policy.
	CreatedBy string `json:"created_by,omitempty"`
	// AccessRepositories maps each linked project id to its repository, recorded when the project is
	// linked under an access policy. Whoever may touch one of them may see and edit the product. They are
	// stored because a project id resolves to a repository only while its worker is registered, and they
	// are never returned: a viewer may lack access to some of them.
	AccessRepositories map[string]string `json:"access_repositories,omitempty"`
}

type productConfigurationRevision struct {
	Revision           int               `json:"revision"`
	Name               string            `json:"name"`
	Description        string            `json:"description"`
	RepositoryIDs      []string          `json:"repository_ids"`
	DefaultWorkflowID  string            `json:"default_workflow_id,omitempty"`
	ChangedBy          string            `json:"changed_by,omitempty"`
	ChangedAt          time.Time         `json:"changed_at"`
	AccessRepositories map[string]string `json:"access_repositories,omitempty"`
}

type productStore struct {
	mu    sync.RWMutex
	items map[string]product
	path  string
	// repositoryOf resolves a project id to its repository; set when the store is wired to the registry.
	repositoryOf func(projectID string) (string, bool)
	workflows    *workflowStore
}

// visible reports whether the caller may see and edit a product: an administrator, anyone who may touch
// one of its repositories, and, for a product without repositories, its creator. A creator who lost
// every repository of the product no longer sees it.
func (item product) visible(access requestAccess) bool {
	if !access.enforced || access.admin {
		return true
	}
	if len(item.AccessRepositories) == 0 {
		return access.owns(item.CreatedBy)
	}
	for _, repository := range item.AccessRepositories {
		if access.allows(repository) {
			return true
		}
	}
	return false
}

// public is the product as returned by the API.
func (item product) public() product {
	item.AccessRepositories = nil
	item.ConfigurationHistory = nil
	item.ConfigurationRevision = item.configurationRevision()
	return item
}

func (item product) configurationRevision() int {
	if item.ConfigurationRevision < 1 {
		return 1
	}
	return item.ConfigurationRevision
}

// accessRepositories returns the repository of every linked project. Under an access policy a product
// may only gain projects the caller can access; projects it already links keep their recorded
// repository, so a product stays editable while a linked project's worker is not registered and by a
// user who may touch only some of its repositories.
func (store *productStore) accessRepositories(access requestAccess, projectIDs []string, linked map[string]string) (map[string]string, bool) {
	repositories := make(map[string]string, len(projectIDs))
	for _, projectID := range projectIDs {
		if repository, kept := linked[projectID]; kept {
			repositories[projectID] = repository
			continue
		}
		if !access.enforced {
			// Without a policy nothing is checked or recorded for a newly linked project.
			continue
		}
		repository, known := "", false
		if store.repositoryOf != nil {
			repository, known = store.repositoryOf(projectID)
		}
		if !known || !access.allows(repository) {
			return nil, false
		}
		repositories[projectID] = repository
	}
	return repositories, true
}

func newProductStore() *productStore {
	return &productStore{items: make(map[string]product)}
}

func openProductStore(path string) (*productStore, error) {
	store := newProductStore()
	store.path = path
	var state struct {
		Version int                `json:"version"`
		Items   map[string]product `json:"items"`
	}
	exists, err := loadStateFile(path, &state)
	if err != nil {
		return nil, fmt.Errorf("load products: %w", err)
	}
	if !exists {
		return store, nil
	}
	if state.Version != stateFileVersion || state.Items == nil {
		return nil, fmt.Errorf("load products: unsupported or invalid state")
	}
	for id, item := range state.Items {
		if id != item.ID || !validStoredProduct(item) {
			return nil, fmt.Errorf("load products: invalid record %q", id)
		}
	}
	store.items = state.Items
	return store, nil
}

func (store *productStore) persistLocked() error {
	if store.path == "" {
		return nil
	}
	// ponytail: serialize snapshots under the store lock; move to a transactional writer if write traffic grows.
	return writeStateFile(store.path, struct {
		Version int                `json:"version"`
		Items   map[string]product `json:"items"`
	}{stateFileVersion, store.items})
}

func validStoredProduct(item product) bool {
	id, err := hex.DecodeString(item.ID)
	if err != nil || len(id) != 16 || item.ID != strings.ToLower(item.ID) ||
		strings.TrimSpace(item.Name) == "" || len(item.Name) > 100 || len(item.Description) > 2000 ||
		item.RepositoryIDs == nil || item.ConfigurationRevision < 0 || item.CreatedAt.IsZero() || item.UpdatedAt.IsZero() {
		return false
	}
	if item.DefaultWorkflowID != "" {
		if len(item.DefaultWorkflowID) > 100 || strings.TrimSpace(item.DefaultWorkflowID) != item.DefaultWorkflowID {
			return false
		}
	}
	seen := make(map[string]struct{}, len(item.RepositoryIDs))
	for _, repositoryID := range item.RepositoryIDs {
		decoded, err := hex.DecodeString(repositoryID)
		if err != nil || len(decoded) != 16 || repositoryID != strings.ToLower(repositoryID) {
			return false
		}
		if _, exists := seen[repositoryID]; exists {
			return false
		}
		seen[repositoryID] = struct{}{}
	}
	previousRevision := 0
	for _, revision := range item.ConfigurationHistory {
		if previousRevision > 0 && revision.Revision != previousRevision+1 ||
			revision.Revision < 1 || revision.Revision > item.configurationRevision() ||
			strings.TrimSpace(revision.Name) == "" || len(revision.Name) > 100 || len(revision.Description) > 2000 ||
			len(revision.ChangedBy) > 100 || revision.ChangedAt.IsZero() {
			return false
		}
		if revision.DefaultWorkflowID != "" && (len(revision.DefaultWorkflowID) > 100 ||
			strings.TrimSpace(revision.DefaultWorkflowID) != revision.DefaultWorkflowID) {
			return false
		}
		if !validProductRepositoryIDs(revision.RepositoryIDs) {
			return false
		}
		for id, repository := range revision.AccessRepositories {
			if !slices.Contains(revision.RepositoryIDs, id) || !validGitRemote(repository) {
				return false
			}
		}
		previousRevision = revision.Revision
	}
	if len(item.ConfigurationHistory) > 0 && previousRevision != item.configurationRevision() {
		return false
	}
	if len(item.ConfigurationHistory) > 0 {
		latest := item.ConfigurationHistory[len(item.ConfigurationHistory)-1]
		if latest.Name != item.Name || latest.Description != item.Description ||
			latest.DefaultWorkflowID != item.DefaultWorkflowID || !slices.Equal(latest.RepositoryIDs, item.RepositoryIDs) {
			return false
		}
	}
	return true
}

func validProductRepositoryIDs(ids []string) bool {
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		decoded, err := hex.DecodeString(id)
		if err != nil || len(decoded) != 16 || id != strings.ToLower(id) {
			return false
		}
		if _, exists := seen[id]; exists {
			return false
		}
		seen[id] = struct{}{}
	}
	return true
}

func (item product) configurationSnapshot(actor string, changedAt time.Time) productConfigurationRevision {
	return productConfigurationRevision{Revision: item.configurationRevision(), Name: item.Name, Description: item.Description,
		RepositoryIDs: slices.Clone(item.RepositoryIDs), DefaultWorkflowID: item.DefaultWorkflowID, ChangedBy: actor,
		ChangedAt: changedAt, AccessRepositories: maps.Clone(item.AccessRepositories)}
}

func (item product) configurationHistoryFor(access requestAccess) ([]productConfigurationRevisionView, bool) {
	history := slices.Clone(item.ConfigurationHistory)
	if len(history) == 0 {
		changedAt := item.UpdatedAt
		if item.configurationRevision() == 1 {
			changedAt = item.CreatedAt
		}
		history = []productConfigurationRevision{item.configurationSnapshot("", changedAt)}
	}
	complete := len(history) == item.configurationRevision() && history[0].Revision == 1
	result := make([]productConfigurationRevisionView, 0, len(history))
	showAllRepositories := !access.enforced || access.admin
	for _, revision := range history {
		visibleIDs := make([]string, 0, len(revision.RepositoryIDs))
		redacted := false
		for _, id := range revision.RepositoryIDs {
			repository, known := revision.AccessRepositories[id]
			if showAllRepositories || known && access.allows(repository) {
				visibleIDs = append(visibleIDs, id)
				continue
			}
			redacted = true
		}
		result = append(result, productConfigurationRevisionView{Revision: revision.Revision, Name: revision.Name,
			Description: revision.Description, RepositoryIDs: visibleIDs, DefaultWorkflowID: revision.DefaultWorkflowID,
			ChangedBy: revision.ChangedBy, ChangedAt: revision.ChangedAt, RepositoriesRedacted: redacted})
	}
	return result, complete
}

func (store *productStore) list(w http.ResponseWriter, r *http.Request) {
	access := accessFor(r)
	store.mu.RLock()
	items := make([]product, 0, len(store.items))
	for _, item := range store.items {
		if item.visible(access) {
			items = append(items, item.public())
		}
	}
	store.mu.RUnlock()
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	writeJSON(w, http.StatusOK, items)
}

func (store *productStore) get(id string) (product, bool) {
	store.mu.RLock()
	item, exists := store.items[id]
	store.mu.RUnlock()
	return item, exists
}

func (store *productStore) create(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name              string   `json:"name"`
		Description       string   `json:"description"`
		RepositoryIDs     []string `json:"repository_ids"`
		DefaultWorkflowID string   `json:"default_workflow_id"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	if input.Name == "" || len(input.Name) > 100 || len(input.Description) > 2000 {
		http.Error(w, "product name or description is invalid", http.StatusBadRequest)
		return
	}
	repositoryIDs, ok := normalizeRepositoryIDs(input.RepositoryIDs)
	if !ok {
		http.Error(w, "repository_ids must contain unique 32-character hexadecimal ids", http.StatusBadRequest)
		return
	}
	input.DefaultWorkflowID = strings.TrimSpace(input.DefaultWorkflowID)
	if input.DefaultWorkflowID != "" && !store.validWorkflow(input.DefaultWorkflowID) {
		http.Error(w, "default_workflow_id must identify a saved workflow", http.StatusBadRequest)
		return
	}
	access := accessFor(r)
	accessRepositories, permitted := store.accessRepositories(access, repositoryIDs, nil)
	if !permitted {
		http.Error(w, "repository_ids include a project you cannot access", http.StatusForbidden)
		return
	}
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		http.Error(w, "could not create product id", http.StatusInternalServerError)
		return
	}
	now := time.Now().UTC()
	item := product{
		ID: hex.EncodeToString(idBytes), Name: input.Name, Description: input.Description,
		ConfigurationRevision: 1, RepositoryIDs: repositoryIDs, DefaultWorkflowID: input.DefaultWorkflowID,
		CreatedAt: now, UpdatedAt: now,
		CreatedBy: access.user, AccessRepositories: accessRepositories,
	}
	item.ConfigurationHistory = []productConfigurationRevision{item.configurationSnapshot(access.user, now)}
	store.mu.Lock()
	if store.nameExists(access, item.Name, "") {
		store.mu.Unlock()
		http.Error(w, "product name already exists", http.StatusConflict)
		return
	}
	store.items[item.ID] = item
	if err := store.persistLocked(); err != nil {
		delete(store.items, item.ID)
		store.mu.Unlock()
		http.Error(w, "could not persist product", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusCreated, item.public())
}

func (store *productStore) update(w http.ResponseWriter, r *http.Request) {
	id := strings.ToLower(r.PathValue("id"))
	decoded, err := hex.DecodeString(id)
	if err != nil || len(decoded) != 16 {
		http.Error(w, "product id must be 32 hexadecimal characters", http.StatusBadRequest)
		return
	}
	var input struct {
		Name              string   `json:"name"`
		Description       string   `json:"description"`
		RepositoryIDs     []string `json:"repository_ids"`
		DefaultWorkflowID *string  `json:"default_workflow_id"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	if input.Name == "" || len(input.Name) > 100 || len(input.Description) > 2000 {
		http.Error(w, "product name or description is invalid", http.StatusBadRequest)
		return
	}
	repositoryIDs, ok := normalizeRepositoryIDs(input.RepositoryIDs)
	if !ok {
		http.Error(w, "repository_ids must contain unique 32-character hexadecimal ids", http.StatusBadRequest)
		return
	}
	if input.DefaultWorkflowID != nil {
		*input.DefaultWorkflowID = strings.TrimSpace(*input.DefaultWorkflowID)
		if *input.DefaultWorkflowID != "" && !store.validWorkflow(*input.DefaultWorkflowID) {
			http.Error(w, "default_workflow_id must identify a saved workflow", http.StatusBadRequest)
			return
		}
	}
	access := accessFor(r)
	store.mu.Lock()
	previous, exists := store.items[id]
	// A product the caller may not see is reported exactly like one that does not exist.
	if !exists || !previous.visible(access) {
		store.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	accessRepositories, permitted := store.accessRepositories(access, repositoryIDs, previous.AccessRepositories)
	if !permitted {
		store.mu.Unlock()
		http.Error(w, "repository_ids include a project you cannot access", http.StatusForbidden)
		return
	}
	if store.nameExists(access, input.Name, id) {
		store.mu.Unlock()
		http.Error(w, "product name already exists", http.StatusConflict)
		return
	}
	item := previous
	item.Name, item.Description, item.RepositoryIDs = input.Name, input.Description, repositoryIDs
	if input.DefaultWorkflowID != nil {
		item.DefaultWorkflowID = *input.DefaultWorkflowID
	}
	item.AccessRepositories = accessRepositories
	item.ConfigurationRevision = previous.configurationRevision()
	configurationChanged := item.Name != previous.Name || item.Description != previous.Description ||
		item.DefaultWorkflowID != previous.DefaultWorkflowID || !slices.Equal(item.RepositoryIDs, previous.RepositoryIDs)
	if configurationChanged {
		item.ConfigurationRevision++
	}
	item.UpdatedAt = time.Now().UTC()
	item.ConfigurationHistory = slices.Clone(previous.ConfigurationHistory)
	if configurationChanged {
		if len(item.ConfigurationHistory) == 0 {
			changedAt := previous.UpdatedAt
			if previous.configurationRevision() == 1 {
				changedAt = previous.CreatedAt
			}
			item.ConfigurationHistory = append(item.ConfigurationHistory, previous.configurationSnapshot("", changedAt))
		}
		item.ConfigurationHistory = append(item.ConfigurationHistory, item.configurationSnapshot(access.user, item.UpdatedAt))
	}
	store.items[id] = item
	if err := store.persistLocked(); err != nil {
		store.items[id] = previous
		store.mu.Unlock()
		http.Error(w, "could not persist product", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusOK, item.public())
}

func (store *productStore) validWorkflow(id string) bool {
	if store.workflows == nil {
		return false
	}
	store.workflows.mu.RLock()
	defer store.workflows.mu.RUnlock()
	_, exists := store.workflows.items[id]
	return exists
}

// nameExists compares only with products the caller can see, so the answer does not reveal the name of
// a product in a project the caller has no access to.
func (store *productStore) nameExists(access requestAccess, name, exceptID string) bool {
	// ponytail: linear scan fits small product catalogs; index normalized names if the catalog grows.
	for id, item := range store.items {
		if id != exceptID && item.visible(access) && strings.EqualFold(item.Name, name) {
			return true
		}
	}
	return false
}

func normalizeRepositoryIDs(ids []string) ([]string, bool) {
	if ids == nil {
		return nil, false
	}
	seen := make(map[string]struct{}, len(ids))
	for i, id := range ids {
		id = strings.ToLower(strings.TrimSpace(id))
		decoded, err := hex.DecodeString(id)
		if err != nil || len(decoded) != 16 {
			return nil, false
		}
		if _, exists := seen[id]; exists {
			return nil, false
		}
		seen[id] = struct{}{}
		ids[i] = id
	}
	return ids, true
}
