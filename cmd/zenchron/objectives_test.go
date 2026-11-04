package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestObjectiveCreateListAndComplete(t *testing.T) {
	server := newMux()
	create := httptest.NewRequest(http.MethodPost, "/api/v1/objectives", strings.NewReader(
		`{"title":"Ship review workflow","owner":"Alex","product":"Core Product","due_date":"2026-12-15"}`,
	))
	response := httptest.NewRecorder()
	server.ServeHTTP(response, create)
	var created objective
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatalf("decode created objective: %v", err)
	}
	if response.Code != http.StatusCreated || created.ID == "" || created.Status != "in_progress" {
		t.Fatalf("create = %#v (HTTP %d)", created, response.Code)
	}

	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/objectives", nil))
	var listed []objective
	if err := json.NewDecoder(response.Body).Decode(&listed); err != nil {
		t.Fatalf("decode objectives: %v", err)
	}
	if response.Code != http.StatusOK || len(listed) != 1 || listed[0].ID != created.ID {
		t.Fatalf("list = %#v (HTTP %d)", listed, response.Code)
	}

	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPatch,
		"/api/v1/objectives/"+created.ID, strings.NewReader(`{"status":"completed"}`)))
	var updated objective
	if err := json.NewDecoder(response.Body).Decode(&updated); err != nil {
		t.Fatalf("decode updated objective: %v", err)
	}
	if response.Code != http.StatusOK || updated.Status != "completed" || updated.Progress != 100 {
		t.Fatalf("update = %#v (HTTP %d), want completed at 100%%", updated, response.Code)
	}
}

func TestObjectivesLinkProductsByID(t *testing.T) {
	server := newMux()
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/products", strings.NewReader(
		`{"name":"Core Product","repository_ids":[]}`,
	)))
	var product product
	if err := json.NewDecoder(response.Body).Decode(&product); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create product = %#v, decode error = %v, HTTP %d", product, err, response.Code)
	}

	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/objectives", strings.NewReader(
		`{"title":"Ship product objective","product_id":"`+product.ID+`"}`,
	)))
	var created objective
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create linked objective = %#v, decode error = %v, HTTP %d", created, err, response.Code)
	}
	if created.ProductID != product.ID || created.Product != product.Name {
		t.Fatalf("linked objective = %#v", created)
	}

	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/api/v1/products/"+product.ID, strings.NewReader(
		`{"name":"Nova Platform","repository_ids":[]}`,
	)))
	if response.Code != http.StatusOK {
		t.Fatalf("rename product returned HTTP %d: %s", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/objectives", nil))
	var listed []objective
	if err := json.NewDecoder(response.Body).Decode(&listed); err != nil || response.Code != http.StatusOK ||
		len(listed) != 1 || listed[0].ProductID != product.ID || listed[0].Product != "Nova Platform" {
		t.Fatalf("list after product rename = %#v, decode error = %v, HTTP %d", listed, err, response.Code)
	}

	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPatch,
		"/api/v1/objectives/"+created.ID, strings.NewReader(`{"product_id":""}`)))
	var unlinked objective
	if err := json.NewDecoder(response.Body).Decode(&unlinked); err != nil || response.Code != http.StatusOK ||
		unlinked.ProductID != "" || unlinked.Product != "" {
		t.Fatalf("clear product link = %#v, decode error = %v, HTTP %d", unlinked, err, response.Code)
	}
}

func TestObjectiveRejectsUnknownProductID(t *testing.T) {
	server := newMux()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/objectives", strings.NewReader(
		`{"title":"Invalid product link","product_id":"`+testProjectID+`"}`,
	))
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown product id returned HTTP %d: %s", response.Code, response.Body.String())
	}
}

func TestObjectiveEndpointsRejectInvalidInput(t *testing.T) {
	server := newMux()
	for _, testCase := range []struct {
		method     string
		path       string
		body       string
		wantStatus int
	}{
		{http.MethodPost, "/api/v1/objectives", `{"title":" "}`, http.StatusBadRequest},
		{http.MethodPost, "/api/v1/objectives", `{"title":"Goal","due_date":"tomorrow"}`, http.StatusBadRequest},
		{http.MethodPost, "/api/v1/objectives", `{"title":"Goal","unexpected":true}`, http.StatusBadRequest},
		{http.MethodPatch, "/api/v1/objectives/not-hex", `{"status":"blocked"}`, http.StatusBadRequest},
		{http.MethodPatch, "/api/v1/objectives/0123456789abcdef0123456789abcdef", `{"status":"unknown"}`, http.StatusBadRequest},
		{http.MethodPatch, "/api/v1/objectives/0123456789abcdef0123456789abcdef", `{"progress":101}`, http.StatusBadRequest},
		{http.MethodPatch, "/api/v1/objectives/0123456789abcdef0123456789abcdef", `{"progress":50}`, http.StatusNotFound},
	} {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(testCase.method, testCase.path, strings.NewReader(testCase.body)))
		if response.Code != testCase.wantStatus {
			t.Errorf("%s %s returned HTTP %d, want %d", testCase.method, testCase.path, response.Code, testCase.wantStatus)
		}
	}
}
