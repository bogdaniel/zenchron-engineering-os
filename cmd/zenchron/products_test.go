package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
	if created.Name != "Core Product" || len(created.RepositoryIDs) != 1 || created.RepositoryIDs[0] != testProjectID ||
		created.DefaultWorkflowID != "pr-review-release" {
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
	if updated.Description != "Updated" || len(updated.RepositoryIDs) != 0 {
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
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create configured product: decode error %v, HTTP %d", err, response.Code)
	}

	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/api/v1/products/"+created.ID, strings.NewReader(
		`{"name":"Configured","repository_ids":[],"default_workflow_id":""}`)))
	var updated product
	if err := json.NewDecoder(response.Body).Decode(&updated); err != nil || response.Code != http.StatusOK || updated.DefaultWorkflowID != "" {
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
