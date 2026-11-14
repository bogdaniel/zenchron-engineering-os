package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

type product struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Description   string    `json:"description"`
	RepositoryIDs []string  `json:"repository_ids"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	// CreatedBy is the GitHub login that created the product under an access policy.
	CreatedBy string `json:"created_by,omitempty"`
	// AccessRepositories are the repositories of the linked projects, recorded when the product is saved
	// under an access policy. Whoever may touch one of them may see and edit the product. They are stored
	// because a project id resolves to a repository only while its worker is registered, and they are
	// never returned: a viewer may lack access to some of them.
	AccessRepositories []string `json:"access_repositories,omitempty"`
}

type productStore struct {
	mu    sync.RWMutex
	items map[string]product
	path  string
	// repositoryOf resolves a project id to its repository; set when the store is wired to the registry.
	repositoryOf func(projectID string) (string, bool)
}

// visible reports whether the caller may see and edit a product: an administrator, its creator, or
// anyone who may touch one of its repositories.
func (item product) visible(access requestAccess) bool {
	return access.owns(item.CreatedBy) || slices.ContainsFunc(item.AccessRepositories, access.allows)
}

// public is the product as returned by the API.
func (item product) public() product {
	item.AccessRepositories = nil
	return item
}

// accessRepositories resolves the linked projects to repositories the caller may touch. Under an access
// policy a product may only link projects the caller can access.
func (store *productStore) accessRepositories(access requestAccess, projectIDs []string) ([]string, bool) {
	if !access.enforced {
		return nil, true
	}
	repositories := []string{}
	for _, projectID := range projectIDs {
		repository, known := "", false
		if store.repositoryOf != nil {
			repository, known = store.repositoryOf(projectID)
		}
		if !known || !access.allows(repository) {
			return nil, false
		}
		if !slices.Contains(repositories, repository) {
			repositories = append(repositories, repository)
		}
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
		item.RepositoryIDs == nil || item.CreatedAt.IsZero() || item.UpdatedAt.IsZero() {
		return false
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
	return true
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
		Name          string   `json:"name"`
		Description   string   `json:"description"`
		RepositoryIDs []string `json:"repository_ids"`
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
	access := accessFor(r)
	accessRepositories, permitted := store.accessRepositories(access, repositoryIDs)
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
		RepositoryIDs: repositoryIDs, CreatedAt: now, UpdatedAt: now,
		CreatedBy: access.creator(), AccessRepositories: accessRepositories,
	}
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
		Name          string   `json:"name"`
		Description   string   `json:"description"`
		RepositoryIDs []string `json:"repository_ids"`
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
	access := accessFor(r)
	accessRepositories, permitted := store.accessRepositories(access, repositoryIDs)
	store.mu.Lock()
	previous, exists := store.items[id]
	// A product the caller may not see is reported exactly like one that does not exist.
	if !exists || !previous.visible(access) {
		store.mu.Unlock()
		http.NotFound(w, r)
		return
	}
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
	if access.enforced {
		item.AccessRepositories = accessRepositories
	}
	item.UpdatedAt = time.Now().UTC()
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
