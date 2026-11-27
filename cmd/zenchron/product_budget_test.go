package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProductMonthlyBudgetIsValidatedVersionedAndKeptAcrossRestart(t *testing.T) {
	dataDir := t.TempDir()
	server, err := newPersistentMux(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, jsonRequest(method, path, strings.NewReader(body)))
		return response
	}
	if response := call(http.MethodPost, "/api/v1/products", `{"name":"Shop","repository_ids":[],"monthly_budget_cents":-1}`); response.Code != http.StatusBadRequest {
		t.Fatalf("negative budget = HTTP %d", response.Code)
	}
	created := call(http.MethodPost, "/api/v1/products", `{"name":"Shop","repository_ids":[],"monthly_budget_cents":5000}`)
	var item product
	if err := json.NewDecoder(created.Body).Decode(&item); err != nil || created.Code != http.StatusCreated || item.MonthlyBudgetCents != 5000 {
		t.Fatalf("create with budget: HTTP %d %#v %v", created.Code, item, err)
	}
	// Omitting the budget on update keeps it; setting it records a new configuration revision.
	if response := call(http.MethodPut, "/api/v1/products/"+item.ID, `{"name":"Shop","repository_ids":[]}`); response.Code != http.StatusOK {
		t.Fatalf("update without budget = HTTP %d", response.Code)
	}
	if response := call(http.MethodPut, "/api/v1/products/"+item.ID,
		`{"name":"Shop","repository_ids":[],"monthly_budget_cents":1000000001}`); response.Code != http.StatusBadRequest {
		t.Fatalf("budget above the bound = HTTP %d", response.Code)
	}
	if response := call(http.MethodPut, "/api/v1/products/"+item.ID,
		`{"name":"Shop","repository_ids":[],"monthly_budget_cents":7500}`); response.Code != http.StatusOK {
		t.Fatalf("update budget = HTTP %d %s", response.Code, response.Body.String())
	}

	server, err = newPersistentMux(dataDir)
	if err != nil {
		t.Fatalf("restart: %v", err)
	}
	var environment productEnvironment
	response := call(http.MethodGet, "/api/v1/products/"+item.ID+"/environment", "")
	if err := json.NewDecoder(response.Body).Decode(&environment); err != nil || response.Code != http.StatusOK {
		t.Fatalf("environment: HTTP %d %v", response.Code, err)
	}
	history := environment.ConfigurationHistory
	if environment.ConfigurationRevision != 2 || len(history) != 2 || history[0].MonthlyBudgetCents != 5000 ||
		history[1].MonthlyBudgetCents != 7500 {
		t.Fatalf("budget history = %#v, revision %d", history, environment.ConfigurationRevision)
	}
	products := decodeList[product](t, call(http.MethodGet, "/api/v1/products", ""))
	if len(products) != 1 || products[0].MonthlyBudgetCents != 7500 {
		t.Fatalf("listed product budget = %#v", products)
	}
}
