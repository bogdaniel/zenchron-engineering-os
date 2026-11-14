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

type objective struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Owner       string    `json:"owner"`
	Product     string    `json:"product"`
	ProductID   string    `json:"product_id,omitempty"`
	Status      string    `json:"status"`
	Progress    int       `json:"progress"`
	DueDate     string    `json:"due_date"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	// CreatedBy is the GitHub login that created the objective under an access policy.
	CreatedBy string `json:"created_by,omitempty"`
}

// visible reports whether the caller may see and edit an objective. An objective follows its product;
// one without a product belongs to its creator and to administrators.
func (store *objectiveStore) visible(access requestAccess, item objective) bool {
	if product, exists := store.products.get(item.ProductID); item.ProductID != "" && exists {
		return product.visible(access)
	}
	return access.owns(item.CreatedBy)
}

type objectiveStore struct {
	mu       sync.RWMutex
	items    map[string]objective
	path     string
	products *productStore
}

func newObjectiveStore(products *productStore) *objectiveStore {
	return &objectiveStore{items: make(map[string]objective), products: products}
}

func openObjectiveStore(path string, products *productStore) (*objectiveStore, error) {
	store := newObjectiveStore(products)
	store.path = path
	var state struct {
		Version int                  `json:"version"`
		Items   map[string]objective `json:"items"`
	}
	exists, err := loadStateFile(path, &state)
	if err != nil {
		return nil, fmt.Errorf("load objectives: %w", err)
	}
	if !exists {
		return store, nil
	}
	if state.Version != stateFileVersion || state.Items == nil {
		return nil, fmt.Errorf("load objectives: unsupported or invalid state")
	}
	for id, item := range state.Items {
		if id != item.ID || !validStoredObjective(item) {
			return nil, fmt.Errorf("load objectives: invalid record %q", id)
		}
		if item.ProductID != "" {
			if _, exists := products.get(item.ProductID); !exists {
				return nil, fmt.Errorf("load objectives: product %q does not exist", item.ProductID)
			}
		}
	}
	store.items = state.Items
	return store, nil
}

func (store *objectiveStore) persistLocked() error {
	if store.path == "" {
		return nil
	}
	return writeStateFile(store.path, struct {
		Version int                  `json:"version"`
		Items   map[string]objective `json:"items"`
	}{stateFileVersion, store.items})
}

func validStoredObjective(item objective) bool {
	id, err := hex.DecodeString(item.ID)
	if err != nil || len(id) != 16 || item.ID != strings.ToLower(item.ID) ||
		strings.TrimSpace(item.Title) == "" || len(item.Title) > 200 ||
		len(item.Description) > 5000 || len(item.Owner) > 128 || len(item.Product) > 100 ||
		(item.ProductID != "" && !validProductID(item.ProductID)) ||
		!validObjectiveStatus(item.Status) || item.Progress < 0 || item.Progress > 100 ||
		(item.Status == "completed" && item.Progress != 100) || item.CreatedAt.IsZero() || item.UpdatedAt.IsZero() {
		return false
	}
	if item.DueDate != "" {
		if _, err := time.Parse("2006-01-02", item.DueDate); err != nil {
			return false
		}
	}
	return true
}

func (store *objectiveStore) list(w http.ResponseWriter, r *http.Request) {
	access := accessFor(r)
	store.mu.RLock()
	items := make([]objective, 0, len(store.items))
	for _, item := range store.items {
		if store.visible(access, item) {
			items = append(items, item)
		}
	}
	store.mu.RUnlock()
	for i := range items {
		if product, exists := store.products.get(items[i].ProductID); items[i].ProductID != "" && exists {
			items[i].Product = product.Name
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	writeJSON(w, http.StatusOK, items)
}

func (store *objectiveStore) create(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Title       string `json:"title"`
		Description string `json:"description"`
		Owner       string `json:"owner"`
		Product     string `json:"product"`
		ProductID   string `json:"product_id"`
		DueDate     string `json:"due_date"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	input.Title = strings.TrimSpace(input.Title)
	input.Description = strings.TrimSpace(input.Description)
	input.Owner = strings.TrimSpace(input.Owner)
	input.Product = strings.TrimSpace(input.Product)
	input.ProductID = strings.ToLower(strings.TrimSpace(input.ProductID))
	if input.Title == "" || len(input.Title) > 200 {
		http.Error(w, "title must be between 1 and 200 bytes", http.StatusBadRequest)
		return
	}
	if len(input.Description) > 5000 || len(input.Owner) > 128 || len(input.Product) > 100 {
		http.Error(w, "objective field exceeds its maximum length", http.StatusBadRequest)
		return
	}
	if input.DueDate != "" {
		if _, err := time.Parse("2006-01-02", input.DueDate); err != nil {
			http.Error(w, "due_date must use YYYY-MM-DD format", http.StatusBadRequest)
			return
		}
	}
	if input.ProductID != "" {
		if !validProductID(input.ProductID) {
			http.Error(w, "product_id must be a 32-character hexadecimal id", http.StatusBadRequest)
			return
		}
		product, exists := store.products.get(input.ProductID)
		if !exists || !product.visible(accessFor(r)) {
			http.Error(w, "product_id does not identify a saved product", http.StatusBadRequest)
			return
		}
		input.Product = product.Name
	}
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		http.Error(w, "could not create objective id", http.StatusInternalServerError)
		return
	}
	now := time.Now().UTC()
	item := objective{
		ID: hex.EncodeToString(idBytes), Title: input.Title, Description: input.Description,
		Owner: input.Owner, Product: input.Product, ProductID: input.ProductID,
		Status: "in_progress", DueDate: input.DueDate,
		CreatedAt: now, UpdatedAt: now, CreatedBy: accessFor(r).creator(),
	}
	store.mu.Lock()
	store.items[item.ID] = item
	if err := store.persistLocked(); err != nil {
		delete(store.items, item.ID)
		store.mu.Unlock()
		http.Error(w, "could not persist objective", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusCreated, item)
}

func (store *objectiveStore) update(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Title       *string `json:"title"`
		Description *string `json:"description"`
		Owner       *string `json:"owner"`
		DueDate     *string `json:"due_date"`
		Status      *string `json:"status"`
		Progress    *int    `json:"progress"`
		ProductID   *string `json:"product_id"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	if input.Title == nil && input.Description == nil && input.Owner == nil && input.DueDate == nil &&
		input.Status == nil && input.Progress == nil && input.ProductID == nil {
		http.Error(w, "at least one objective field is required", http.StatusBadRequest)
		return
	}
	if input.Title != nil {
		*input.Title = strings.TrimSpace(*input.Title)
		if *input.Title == "" || len(*input.Title) > 200 {
			http.Error(w, "title must be between 1 and 200 bytes", http.StatusBadRequest)
			return
		}
	}
	if input.Description != nil {
		*input.Description = strings.TrimSpace(*input.Description)
		if len(*input.Description) > 5000 {
			http.Error(w, "description exceeds its maximum length", http.StatusBadRequest)
			return
		}
	}
	if input.Owner != nil {
		*input.Owner = strings.TrimSpace(*input.Owner)
		if len(*input.Owner) > 128 {
			http.Error(w, "owner exceeds its maximum length", http.StatusBadRequest)
			return
		}
	}
	if input.DueDate != nil && *input.DueDate != "" {
		if _, err := time.Parse("2006-01-02", *input.DueDate); err != nil {
			http.Error(w, "due_date must use YYYY-MM-DD format", http.StatusBadRequest)
			return
		}
	}
	if input.Status != nil && !validObjectiveStatus(*input.Status) {
		http.Error(w, "invalid objective status", http.StatusBadRequest)
		return
	}
	if input.Progress != nil && (*input.Progress < 0 || *input.Progress > 100) {
		http.Error(w, "progress must be between 0 and 100", http.StatusBadRequest)
		return
	}
	var linkedProduct product
	if input.ProductID != nil {
		*input.ProductID = strings.ToLower(strings.TrimSpace(*input.ProductID))
	}
	if input.ProductID != nil && *input.ProductID != "" {
		if !validProductID(*input.ProductID) {
			http.Error(w, "product_id must be empty or a 32-character hexadecimal id", http.StatusBadRequest)
			return
		}
		var exists bool
		linkedProduct, exists = store.products.get(*input.ProductID)
		if !exists || !linkedProduct.visible(accessFor(r)) {
			http.Error(w, "product_id does not identify a saved product", http.StatusBadRequest)
			return
		}
	}
	id := strings.ToLower(r.PathValue("id"))
	if decoded, err := hex.DecodeString(id); err != nil || len(decoded) != 16 {
		http.Error(w, "objective id must be 32 hexadecimal characters", http.StatusBadRequest)
		return
	}
	store.mu.Lock()
	item, exists := store.items[id]
	// An objective the caller may not see is reported exactly like one that does not exist.
	if !exists || !store.visible(accessFor(r), item) {
		store.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	previous := item
	if input.Title != nil {
		item.Title = *input.Title
	}
	if input.Description != nil {
		item.Description = *input.Description
	}
	if input.Owner != nil {
		item.Owner = *input.Owner
	}
	if input.DueDate != nil {
		item.DueDate = *input.DueDate
	}
	if input.Status != nil {
		item.Status = *input.Status
	}
	if input.Progress != nil {
		item.Progress = *input.Progress
	}
	if input.ProductID != nil {
		item.ProductID = *input.ProductID
		item.Product = linkedProduct.Name
	}
	if item.Status == "completed" {
		item.Progress = 100
	}
	item.UpdatedAt = time.Now().UTC()
	store.items[id] = item
	if err := store.persistLocked(); err != nil {
		store.items[id] = previous
		store.mu.Unlock()
		http.Error(w, "could not persist objective", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusOK, item)
}

func validProductID(id string) bool {
	decoded, err := hex.DecodeString(id)
	return err == nil && len(decoded) == 16 && id == strings.ToLower(id)
}

func validObjectiveStatus(status string) bool {
	switch status {
	case "on_track", "at_risk", "blocked", "in_progress", "completed":
		return true
	default:
		return false
	}
}
