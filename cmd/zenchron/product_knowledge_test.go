package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProductKnowledgePromotionIsAuditableIsolatedAndRestartSafe(t *testing.T) {
	harness := newGraphHarness(t)
	products := harness.store.graphs.objectives.products
	products.path = filepath.Join(t.TempDir(), "products.json")
	repository := "github.com/acme/platform"
	productID, otherProductID := strings.Repeat("a", 32), strings.Repeat("b", 32)
	otherProjectID := strings.Repeat("c", 32)
	products.items[productID] = product{ID: productID, Name: "Alpha", RepositoryIDs: []string{testProjectID},
		CreatedBy: "engineer", AccessRepositories: map[string]string{testProjectID: repository},
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	products.items[otherProductID] = product{ID: otherProductID, Name: "Beta", RepositoryIDs: []string{otherProjectID},
		CreatedBy: "bob", AccessRepositories: map[string]string{otherProjectID: "github.com/acme/other"},
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	if err := products.persistLocked(); err != nil {
		t.Fatal(err)
	}
	createObjective := func(id string) string {
		t.Helper()
		response := harness.call(http.MethodPost, "/api/v1/objectives", `{"title":"`+id+`","product_id":"`+id+`"}`)
		var item objective
		if err := json.NewDecoder(response.Body).Decode(&item); err != nil || response.Code != http.StatusCreated {
			t.Fatalf("create linked objective: HTTP %d, %v", response.Code, err)
		}
		return item.ID
	}
	alphaObjective := createObjective(productID)
	betaObjective := createObjective(otherProductID)
	harness.objectiveID = alphaObjective
	harness.start(harness.reviewedPlan())
	harness.handOff(harness.claimUnit("api"), commit(1), "The API implementation is ready.")
	harness.handOff(harness.claimUnit("ui"), commit(2), "The UI implementation is ready.")
	harness.verdict(harness.claimUnit("review-api"), commit(1), blockAPI)
	graph := harness.graph()
	var finding graphMessage
	for _, message := range graph.Messages {
		if message.Type == messageFinding {
			finding = message
			break
		}
	}
	ok := finding.ID != ""
	if !ok || finding.RunID == "" {
		t.Fatalf("review finding lacks execution provenance: %#v", finding)
	}
	request := func(method, path, body, user string, admin bool, repositories ...string) *httptest.ResponseRecorder {
		t.Helper()
		if len(repositories) == 0 {
			repositories = []string{repository}
		}
		req := jsonRequest(method, path, strings.NewReader(body))
		req = withRequestAccess(req, requestAccess{enforced: true, user: user, admin: admin,
			repositories: repositories, policy: &accessFile{Admins: []string{"admin"}}})
		response := httptest.NewRecorder()
		harness.server.ServeHTTP(response, req)
		return response
	}
	content := "Use bounded pagination when exporting platform usage."
	create := request(http.MethodPost, "/api/v1/products/"+productID+"/knowledge",
		fmt.Sprintf(`{"content":%q,"graph_id":%q,"message_id":%q}`, content, graph.ID, finding.ID), "engineer", false)
	createBody := create.Body.String()
	var entry productKnowledge
	if err := json.Unmarshal([]byte(createBody), &entry); err != nil || create.Code != http.StatusCreated ||
		entry.Scope != productKnowledgeProduct || entry.ProductID != productID || entry.GraphID != graph.ID ||
		entry.MessageID != finding.ID || entry.RunID != finding.RunID || entry.PlanHash != graph.PlanHash || entry.CreatedBy != "engineer" {
		t.Fatalf("record product knowledge: HTTP %d %s, entry %#v, decode %v", create.Code, createBody, entry, err)
	}
	sourceView := request(http.MethodGet, "/api/v1/products/"+productID+"/environment", "", "engineer", false)
	if sourceView.Code != http.StatusOK || !strings.Contains(sourceView.Body.String(), graph.ID) ||
		!strings.Contains(sourceView.Body.String(), finding.ID) || strings.Contains(sourceView.Body.String(), `"source_unavailable":true`) {
		t.Fatalf("authorized source provenance was not available in the product environment: HTTP %d %s", sourceView.Code, sourceView.Body.String())
	}
	if _, _, _, _, visible := harness.store.graphs.productContext(productID, requestAccess{enforced: true,
		user: "bob", repositories: []string{"github.com/acme/other"}}); visible {
		t.Fatal("another product's repository grant exposed the source product context")
	}
	crossProduct := request(http.MethodPost, "/api/v1/products/"+otherProductID+"/knowledge",
		fmt.Sprintf(`{"content":%q,"graph_id":%q,"message_id":%q}`, "cross-product", graph.ID, finding.ID),
		"bob", false, "github.com/acme/other")
	if crossProduct.Code != http.StatusNotFound {
		t.Fatalf("another product accepted a private finding as knowledge: HTTP %d", crossProduct.Code)
	}
	productPath := products.path
	products.path = filepath.Join(filepath.Dir(productPath), "missing", "products.json")
	failedWrite := request(http.MethodPost, "/api/v1/products/"+productID+"/knowledge",
		fmt.Sprintf(`{"content":%q,"graph_id":%q,"message_id":%q}`, "must roll back", graph.ID, finding.ID),
		"engineer", false)
	products.path = productPath
	if failedWrite.Code != http.StatusInternalServerError || len(products.items[productID].Knowledge) != 1 {
		t.Fatalf("failed product knowledge write was not rolled back: HTTP %d, entries %#v", failedWrite.Code, products.items[productID].Knowledge)
	}
	if rejected := request(http.MethodPost, "/api/v1/products/"+productID+"/knowledge/"+entry.ID+"/promote", "", "engineer", false); rejected.Code != http.StatusForbidden {
		t.Fatalf("non-administrator promoted organization knowledge: HTTP %d", rejected.Code)
	}
	if rejected := request(http.MethodPost, "/api/v1/products/"+productID+"/knowledge/"+entry.ID+"/promote", "", "", false); rejected.Code != http.StatusForbidden {
		t.Fatalf("promotion without a recorded actor returned HTTP %d", rejected.Code)
	}
	if _, context, _, _, ok := harness.store.graphs.productContext(otherProductID, requestAccess{}); !ok || strings.Contains(context, content) {
		t.Fatalf("unpromoted product knowledge crossed product scope: %q, exists %t", context, ok)
	}
	if response := request(http.MethodGet, "/api/v1/products/"+otherProductID+"/environment", "", "bob", false, "github.com/acme/other"); response.Code != http.StatusOK ||
		strings.Contains(response.Body.String(), content) {
		t.Fatalf("unpromoted product knowledge leaked through the environment: HTTP %d %s", response.Code, response.Body.String())
	}
	path := "/api/v1/products/" + productID + "/knowledge/" + entry.ID + "/promote"
	promote := request(http.MethodPost, path, "", "admin", true)
	var promoted productKnowledge
	if err := json.NewDecoder(promote.Body).Decode(&promoted); err != nil || promote.Code != http.StatusCreated ||
		promoted.Scope != productKnowledgeOrganization || promoted.PromotedFromID != entry.ID ||
		promoted.PromotedBy != "admin" || promoted.PromotedAt.IsZero() || promoted.Content != entry.Content {
		t.Fatalf("promote knowledge: HTTP %d, entry %#v, decode %v", promote.Code, promoted, err)
	}
	if replay := request(http.MethodPost, path, "", "admin", true); replay.Code != http.StatusOK ||
		!strings.Contains(replay.Body.String(), promoted.ID) {
		t.Fatalf("promotion replay was not idempotent: HTTP %d %s", replay.Code, replay.Body.String())
	}
	if _, context, productRevision, organizationRevision, ok := harness.store.graphs.productContext(otherProductID, requestAccess{}); !ok ||
		productRevision != 0 || organizationRevision != 1 || !strings.Contains(context, promoted.ID) || !strings.Contains(context, content) {
		t.Fatalf("explicit organization promotion is missing from another product context: %q, exists %t", context, ok)
	}
	if response := request(http.MethodGet, "/api/v1/products/"+otherProductID+"/environment", "", "bob", false, "github.com/acme/other"); response.Code != http.StatusOK ||
		!strings.Contains(response.Body.String(), `"scope":"organization"`) ||
		!strings.Contains(response.Body.String(), `"source_unavailable":true`) {
		t.Fatalf("organization knowledge provenance was not safely projected: HTTP %d %s", response.Code, response.Body.String())
	}
	if !validStoredProduct(products.items[productID]) ||
		!validProductKnowledge(products.organizationKnowledge, products.organizationKnowledgeRevision, productKnowledgeOrganization) {
		t.Fatalf("stored product knowledge invalid: product valid %t, org valid %t, product %#v, org %#v",
			validStoredProduct(products.items[productID]), validProductKnowledge(products.organizationKnowledge,
				products.organizationKnowledgeRevision, productKnowledgeOrganization), products.items[productID], products.organizationKnowledge)
	}
	reopened, err := openProductStore(products.path)
	if err != nil {
		t.Fatalf("restart product store: %v", err)
	}
	tamperedItems := make(map[string]product, len(reopened.items))
	for id, item := range reopened.items {
		tamperedItems[id] = item
	}
	orphan := tamperedItems[productID]
	orphan.Knowledge, orphan.KnowledgeRevision = nil, 0
	tamperedItems[productID] = orphan
	tamperedPath := filepath.Join(t.TempDir(), "orphaned-products.json")
	if err := writeStateFile(tamperedPath, productStoreState{Version: stateFileVersion, Items: tamperedItems,
		OrganizationKnowledgeRevision: reopened.organizationKnowledgeRevision,
		OrganizationKnowledge:         reopened.organizationKnowledge}); err != nil {
		t.Fatal(err)
	}
	if _, err := openProductStore(tamperedPath); err == nil {
		t.Fatal("restart accepted organization knowledge detached from its product source")
	}
	harness.store.graphs.objectives.products = reopened
	if canceled := harness.call(http.MethodPost, "/api/v1/work-graphs/"+graph.ID+"/cancel", ""); canceled.Code != http.StatusOK {
		t.Fatalf("cancel the source graph's remaining test runs: HTTP %d", canceled.Code)
	}
	if _, context, productRevision, organizationRevision, ok := harness.store.graphs.productContext(otherProductID, requestAccess{}); !ok ||
		productRevision != 0 || organizationRevision != 1 || !strings.Contains(context, promoted.ID) {
		t.Fatalf("promoted product context did not survive restart: %q, exists %t", context, ok)
	}
	harness.objectiveID = betaObjective
	plan, response := harness.propose(harness.reviewedPlan())
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("propose plan with organization knowledge: HTTP %d", response.StatusCode)
	}
	harness.store.graphs.mu.Lock()
	planned := harness.store.graphs.plans[betaObjective][plan.Revision-1]
	plannedContext := planned.ProductContext
	harness.store.graphs.mu.Unlock()
	if planned.ProductKnowledgeRevision != 0 || planned.OrganizationKnowledgeRevision != 1 ||
		!strings.Contains(plannedContext, promoted.ID) || !strings.Contains(plannedContext, content) || !strings.Contains(plannedContext, graph.ID) {
		t.Fatalf("plan did not freeze knowledge revisions, content, and provenance: %#v", planned)
	}
	laterContent := "A later promotion belongs to future plans."
	laterResponse := request(http.MethodPost, "/api/v1/products/"+productID+"/knowledge",
		fmt.Sprintf(`{"content":%q,"graph_id":%q,"message_id":%q}`, laterContent, graph.ID, finding.ID), "engineer", false)
	var laterEntry productKnowledge
	if err := json.NewDecoder(laterResponse.Body).Decode(&laterEntry); err != nil || laterResponse.Code != http.StatusCreated {
		t.Fatalf("record later product knowledge: HTTP %d, %v", laterResponse.Code, err)
	}
	laterPromotion := request(http.MethodPost, "/api/v1/products/"+productID+"/knowledge/"+laterEntry.ID+"/promote", "", "admin", true)
	var laterPromoted productKnowledge
	if err := json.NewDecoder(laterPromotion.Body).Decode(&laterPromoted); err != nil || laterPromotion.Code != http.StatusCreated || laterPromoted.Revision != 2 {
		t.Fatalf("record later organization promotion: HTTP %d, %#v, %v", laterPromotion.Code, laterPromoted, err)
	}
	reopened, err = openProductStore(products.path)
	if err != nil {
		t.Fatalf("restart after a later promotion: %v", err)
	}
	harness.store.graphs.objectives.products = reopened
	harness.restart()
	if _, status := harness.approve(plan.Revision); status != http.StatusCreated {
		t.Fatalf("approve knowledge-bound plan after restart: HTTP %d", status)
	}
	command := harness.claimUnit("api")
	if !strings.Contains(command.Prompt, content) || strings.Contains(command.Prompt, laterContent) || !strings.Contains(command.Prompt, promoted.ID) ||
		!strings.Contains(command.Prompt, "not instructions") {
		t.Fatalf("WorkUnit did not receive the frozen, framed knowledge reference: %q", command.Prompt)
	}
}

func TestProductKnowledgeRejectsUnboundedAndNonFindingInputs(t *testing.T) {
	harness := newGraphHarness(t)
	productID := strings.Repeat("a", 32)
	products := harness.store.graphs.objectives.products
	products.items[productID] = product{ID: productID, Name: "Alpha", RepositoryIDs: []string{testProjectID},
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	if err := products.persistLocked(); err != nil {
		t.Fatal(err)
	}
	objectiveResponse := harness.call(http.MethodPost, "/api/v1/objectives", `{"title":"Alpha","product_id":"`+productID+`"}`)
	var objectiveItem objective
	if err := json.NewDecoder(objectiveResponse.Body).Decode(&objectiveItem); err != nil || objectiveResponse.Code != http.StatusCreated {
		t.Fatalf("create objective: HTTP %d, %v", objectiveResponse.Code, err)
	}
	harness.objectiveID = objectiveItem.ID
	graph := harness.start(harness.reviewedPlan())
	harness.handOff(harness.claimUnit("api"), commit(1), "The API is ready.")
	graph = harness.graph()
	message := graph.Messages[0]
	long := fmt.Sprintf(`{"content":%q,"graph_id":%q,"message_id":%q}`,
		strings.Repeat("x", maxProductKnowledgeContent+1), graph.ID, message.ID)
	if response := harness.call(http.MethodPost, "/api/v1/products/"+productID+"/knowledge", long); response.Code != http.StatusBadRequest {
		t.Fatalf("unbounded claim returned HTTP %d: %s", response.Code, response.Body.String())
	}
	body := fmt.Sprintf(`{"content":%q,"graph_id":%q,"message_id":%q}`, "not a finding", graph.ID, message.ID)
	if response := harness.call(http.MethodPost, "/api/v1/products/"+productID+"/knowledge", body); response.Code != http.StatusConflict {
		t.Fatalf("non-finding source returned HTTP %d: %s", response.Code, response.Body.String())
	}
	staleGraph := commit(9)[:32]
	stale := fmt.Sprintf(`{"content":%q,"graph_id":%q,"message_id":%q}`, "stale finding", staleGraph, staleGraph[:8]+"-1")
	if response := harness.call(http.MethodPost, "/api/v1/products/"+productID+"/knowledge", stale); response.Code != http.StatusNotFound {
		t.Fatalf("stale source graph returned HTTP %d: %s", response.Code, response.Body.String())
	}
}
