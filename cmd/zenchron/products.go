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

type product struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Description   string    `json:"description"`
	RepositoryIDs []string  `json:"repository_ids"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type productStore struct {
	mu    sync.RWMutex
	items map[string]product
	path  string
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

func (store *productStore) list(w http.ResponseWriter, _ *http.Request) {
	store.mu.RLock()
	items := make([]product, 0, len(store.items))
	for _, item := range store.items {
		items = append(items, item)
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
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		http.Error(w, "could not create product id", http.StatusInternalServerError)
		return
	}
	now := time.Now().UTC()
	item := product{
		ID: hex.EncodeToString(idBytes), Name: input.Name, Description: input.Description,
		RepositoryIDs: repositoryIDs, CreatedAt: now, UpdatedAt: now,
	}
	store.mu.Lock()
	if store.nameExists(item.Name, "") {
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
	writeJSON(w, http.StatusCreated, item)
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
	store.mu.Lock()
	previous, exists := store.items[id]
	if !exists {
		store.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if store.nameExists(input.Name, id) {
		store.mu.Unlock()
		http.Error(w, "product name already exists", http.StatusConflict)
		return
	}
	item := previous
	item.Name, item.Description, item.RepositoryIDs = input.Name, input.Description, repositoryIDs
	item.UpdatedAt = time.Now().UTC()
	store.items[id] = item
	if err := store.persistLocked(); err != nil {
		store.items[id] = previous
		store.mu.Unlock()
		http.Error(w, "could not persist product", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusOK, item)
}

func (store *productStore) nameExists(name, exceptID string) bool {
	// ponytail: linear scan fits small product catalogs; index normalized names if the catalog grows.
	for id, item := range store.items {
		if id != exceptID && strings.EqualFold(item.Name, name) {
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
