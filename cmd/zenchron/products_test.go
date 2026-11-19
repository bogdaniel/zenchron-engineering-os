package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProductsCanBeCreatedUpdatedAndListed(t *testing.T) {
	server := newMux()
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/products", strings.NewReader(
		`{"name":"Core Product","description":"Platform APIs","repository_ids":["`+testProjectID+`"],"default_workflow_id":"pr-review-release"}`,
	)))
	var created product
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create product = %#v, decode error = %v, HTTP %d", created, err, response.Code)
	}
	if created.Name != "Core Product" || created.ConfigurationRevision != 1 || len(created.RepositoryIDs) != 1 ||
		created.RepositoryIDs[0] != testProjectID || created.DefaultWorkflowID != "pr-review-release" {
		t.Fatalf("created product = %#v", created)
	}

	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/api/v1/products/"+created.ID, strings.NewReader(
		`{"name":"Core Product","description":"Updated","repository_ids":[]}`,
	)))
	var updated product
	if err := json.NewDecoder(response.Body).Decode(&updated); err != nil || response.Code != http.StatusOK {
		t.Fatalf("update product = %#v, decode error = %v, HTTP %d", updated, err, response.Code)
	}
	if updated.Description != "Updated" || updated.ConfigurationRevision != 2 || len(updated.RepositoryIDs) != 0 {
		t.Fatalf("updated product = %#v", updated)
	}
	if updated.DefaultWorkflowID != created.DefaultWorkflowID {
		t.Fatalf("omitted workflow setting was not preserved: %#v", updated)
	}

	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/products", nil))
	var items []product
	if err := json.NewDecoder(response.Body).Decode(&items); err != nil || response.Code != http.StatusOK ||
		len(items) != 1 || items[0].ID != created.ID || items[0].Description != "Updated" {
		t.Fatalf("list products = %#v, decode error = %v, HTTP %d", items, err, response.Code)
	}
}

func TestProductConfigurationRevisionAdvancesOnlyWhenConfigurationChanges(t *testing.T) {
	server := newMux()
	create := httptest.NewRecorder()
	server.ServeHTTP(create, httptest.NewRequest(http.MethodPost, "/api/v1/products", strings.NewReader(
		`{"name":"Versioned","description":"Initial","repository_ids":[]}`)))
	var created map[string]json.RawMessage
	if err := json.NewDecoder(create.Body).Decode(&created); err != nil || create.Code != http.StatusCreated {
		t.Fatalf("create product: HTTP %d, %v", create.Code, err)
	}
	var id string
	var revision int
	if err := json.Unmarshal(created["id"], &id); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(created["configuration_revision"], &revision); err != nil || revision != 1 {
		t.Fatalf("created config revision = %d, error %v; want 1", revision, err)
	}

	update := func(description string) int {
		t.Helper()
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/api/v1/products/"+id, strings.NewReader(
			`{"name":"Versioned","description":"`+description+`","repository_ids":[]}`)))
		var product map[string]json.RawMessage
		if err := json.NewDecoder(response.Body).Decode(&product); err != nil || response.Code != http.StatusOK {
			t.Fatalf("update product: HTTP %d, %v", response.Code, err)
		}
		if err := json.Unmarshal(product["configuration_revision"], &revision); err != nil {
			t.Fatalf("decode config revision: %v", err)
		}
		return revision
	}
	if got := update("Changed"); got != 2 {
		t.Fatalf("changed config revision = %d, want 2", got)
	}
	if got := update("Changed"); got != 2 {
		t.Fatalf("unchanged config revision = %d, want 2", got)
	}
}

func TestLegacyProductWithoutConfigurationRevisionRemainsReadableAndAdvances(t *testing.T) {
	id := strings.Repeat("a", 32)
	createdAt := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	legacy, err := json.Marshal(struct {
		ID            string    `json:"id"`
		Name          string    `json:"name"`
		Description   string    `json:"description"`
		RepositoryIDs []string  `json:"repository_ids"`
		CreatedAt     time.Time `json:"created_at"`
		UpdatedAt     time.Time `json:"updated_at"`
	}{id, "Legacy", "Old state format", []string{}, createdAt, createdAt})
	if err != nil {
		t.Fatal(err)
	}
	state, err := json.Marshal(struct {
		Version int                        `json:"version"`
		Items   map[string]json.RawMessage `json:"items"`
	}{stateFileVersion, map[string]json.RawMessage{id: legacy}})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "products.json")
	if err := os.WriteFile(path, state, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := openProductStore(path)
	if err != nil {
		t.Fatal(err)
	}
	loaded, exists := store.get(id)
	if !exists || loaded.public().ConfigurationRevision != 1 {
		t.Fatalf("legacy product = %#v, exists %t; expected revision 1", loaded, exists)
	}
	request := httptest.NewRequest(http.MethodPut, "/api/v1/products/"+id,
		strings.NewReader(`{"name":"Legacy","description":"Updated","repository_ids":[]}`))
	request.SetPathValue("id", id)
	response := httptest.NewRecorder()
	store.update(response, request)
	var updated product
	if err := json.NewDecoder(response.Body).Decode(&updated); err != nil || response.Code != http.StatusOK ||
		updated.ConfigurationRevision != 2 {
		t.Fatalf("update legacy product = %#v, decode error %v, HTTP %d", updated, err, response.Code)
	}
}

func TestProductDefaultWorkflowMustExistAndCanBeCleared(t *testing.T) {
	server := newMux()
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/products", strings.NewReader(
		`{"name":"Invalid","repository_ids":[],"default_workflow_id":"missing"}`)))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown default workflow returned HTTP %d", response.Code)
	}

	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/products", strings.NewReader(
		`{"name":"Configured","repository_ids":[],"default_workflow_id":"pr-review-release"}`)))
	var created product
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil || response.Code != http.StatusCreated ||
		created.ConfigurationRevision != 1 {
		t.Fatalf("create configured product: decode error %v, HTTP %d", err, response.Code)
	}

	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/api/v1/products/"+created.ID, strings.NewReader(
		`{"name":"Configured","repository_ids":[],"default_workflow_id":""}`)))
	var updated product
	if err := json.NewDecoder(response.Body).Decode(&updated); err != nil || response.Code != http.StatusOK ||
		updated.DefaultWorkflowID != "" || updated.ConfigurationRevision != 2 {
		t.Fatalf("clear default workflow: product %#v, error %v, HTTP %d", updated, err, response.Code)
	}
}

func TestProductsRejectInvalidAndDuplicateNames(t *testing.T) {
	server := newMux()
	for _, body := range []string{
		`{"name":"Core Product","repository_ids":["` + testProjectID + `","` + testProjectID + `"]}`,
		`{"name":"Core Product"}`,
	} {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/products", strings.NewReader(body)))
		if response.Code != http.StatusBadRequest {
			t.Errorf("invalid product body returned HTTP %d: %s", response.Code, response.Body.String())
		}
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/products", strings.NewReader(
		`{"name":"Core Product","repository_ids":[]}`,
	)))
	if response.Code != http.StatusCreated {
		t.Fatalf("create first product returned HTTP %d: %s", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/products", strings.NewReader(
		`{"name":"core product","repository_ids":[]}`,
	)))
	if response.Code != http.StatusConflict {
		t.Fatalf("duplicate product returned HTTP %d: %s", response.Code, response.Body.String())
	}
}
