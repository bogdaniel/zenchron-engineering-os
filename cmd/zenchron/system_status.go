package main

import (
	"crypto/hmac"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

type systemStatus struct {
	Revision           string `json:"revision,omitempty"`
	DashboardURL       string `json:"dashboard_url"`
	DashboardAvailable bool   `json:"dashboard_available"`
	Workers            struct {
		Online    int                    `json:"online"`
		Total     int                    `json:"total"`
		Providers []systemStatusProvider `json:"providers,omitempty"`
	} `json:"workers"`
	Work struct {
		ActiveGraphs     int                    `json:"active_graphs"`
		ActiveGraph      *systemStatusWorkItem  `json:"active_graph,omitempty"`
		ActiveGraphLinks []systemStatusWorkItem `json:"active_graph_links,omitempty"`
		Decisions        []systemStatusDecision `json:"decisions,omitempty"`
		BlockedGraphs    int                    `json:"blocked_graphs"`
		QueuedUnits      int                    `json:"queued_units"`
		RunningUnits     int                    `json:"running_units"`
		WaitingUnits     int                    `json:"waiting_units"`
		FailedUnits      int                    `json:"failed_units"`
		OpenDecisions    int                    `json:"open_decisions"`
	} `json:"work"`
	Usage          *systemStatusUsage `json:"usage,omitempty"`
	UpdateState    string             `json:"update_state"`
	UpdateRevision string             `json:"update_revision,omitempty"`
	UpdateProgress string             `json:"update_progress,omitempty"`
	UpdateReason   string             `json:"update_reason,omitempty"`
}

type systemStatusUsage struct {
	Runs          int      `json:"runs"`
	RunsWithUsage int      `json:"runs_with_usage"`
	InputTokens   *int64   `json:"input_tokens,omitempty"`
	OutputTokens  *int64   `json:"output_tokens,omitempty"`
	RunsWithCost  int      `json:"runs_with_cost"`
	CostUSD       *float64 `json:"cost_usd,omitempty"`
}

const maxSystemStatusLinks = 5

type systemStatusWorkItem struct {
	GraphID        string `json:"graph_id"`
	ObjectiveID    string `json:"objective_id"`
	ObjectiveTitle string `json:"objective_title"`
	updatedAt      time.Time
}

type systemStatusProvider struct {
	ID              string `json:"id"`
	ReadyWorkers    int    `json:"ready_workers"`
	ReportedWorkers int    `json:"reported_workers"`
}

type systemStatusDecision struct {
	ID             string `json:"id"`
	GraphID        string `json:"graph_id"`
	ObjectiveID    string `json:"objective_id"`
	ObjectiveTitle string `json:"objective_title"`
	From           string `json:"from"`
	createdAt      time.Time
}

func writeLocalSystemStatus(w http.ResponseWriter, r *http.Request, registry *workerRegistry, graphs *workGraphStore) {
	if !isLoopbackRequest(r) {
		http.Error(w, "system status is available only to the local operator", http.StatusForbidden)
		return
	}
	token := localStatusCredential()
	if token == "" || !hmac.Equal([]byte(r.Header.Get("X-Zenchron-Local-Status-Token")), []byte(token)) {
		http.Error(w, "system status credential required", http.StatusUnauthorized)
		return
	}

	status := systemStatus{Revision: strings.TrimSpace(os.Getenv("ZENCHRON_RELEASE_REVISION")),
		DashboardURL:       "http://127.0.0.1:8080/?mode=live",
		DashboardAvailable: dashboardIndexAvailable(os.Getenv("ZENCHRON_DASHBOARD_DIR")), UpdateState: "unknown"}
	registry.mu.RLock()
	status.Workers.Total = len(registry.workers)
	providers := make(map[string]systemStatusProvider)
	for _, worker := range registry.workers {
		if time.Since(worker.LastSeen) > workerOnlineWindow {
			continue
		}
		status.Workers.Online++
		seenProviders := make(map[string]bool, len(worker.Providers))
		for _, provider := range worker.Providers {
			if !workerapi.IsCLIProvider(provider.ID) || seenProviders[provider.ID] {
				continue
			}
			seenProviders[provider.ID] = true
			current := providers[provider.ID]
			current.ID = provider.ID
			current.ReportedWorkers++
			if provider.Ready {
				current.ReadyWorkers++
			}
			providers[provider.ID] = current
		}
	}
	for _, provider := range providers {
		status.Workers.Providers = append(status.Workers.Providers, provider)
	}
	registry.mu.RUnlock()
	sort.Slice(status.Workers.Providers, func(i, j int) bool {
		return status.Workers.Providers[i].ID < status.Workers.Providers[j].ID
	})

	graphs.mu.Lock()
	// ponytail: five links per menu section; add pagination if operators need older items.
	var activeGraphUpdatedAt time.Time
	var activeGraphID string
	for _, graph := range graphs.graphs {
		if graph.Status == graphActive {
			status.Work.ActiveGraphs++
			status.Work.ActiveGraphLinks = append(status.Work.ActiveGraphLinks, systemStatusWorkItem{
				GraphID: graph.ID, ObjectiveID: graph.ObjectiveID, ObjectiveTitle: graph.ObjectiveTitle,
				updatedAt: graph.UpdatedAt,
			})
			if status.Work.ActiveGraph == nil || graph.UpdatedAt.After(activeGraphUpdatedAt) ||
				(graph.UpdatedAt.Equal(activeGraphUpdatedAt) && graph.ID < activeGraphID) {
				status.Work.ActiveGraph = &systemStatusWorkItem{
					GraphID: graph.ID, ObjectiveID: graph.ObjectiveID, ObjectiveTitle: graph.ObjectiveTitle,
				}
				activeGraphUpdatedAt = graph.UpdatedAt
				activeGraphID = graph.ID
			}
		} else if graph.Status == graphBlocked {
			status.Work.BlockedGraphs++
		}
		resolved := make(map[string]bool)
		for _, message := range graph.Messages {
			if message.Type == messageDecisionResolution {
				resolved[message.Resolves] = true
			}
		}
		for _, message := range graph.Messages {
			if graph.Status != graphCancelled && message.Type == messageDecisionRequest && !resolved[message.ID] {
				status.Work.OpenDecisions++
				status.Work.Decisions = append(status.Work.Decisions, systemStatusDecision{
					ID: message.ID, GraphID: graph.ID, ObjectiveID: graph.ObjectiveID,
					ObjectiveTitle: graph.ObjectiveTitle, From: message.From, createdAt: message.CreatedAt,
				})
			}
		}
		for _, unit := range graph.Units {
			switch unit.State {
			case unitQueued:
				status.Work.QueuedUnits++
			case unitRunning:
				status.Work.RunningUnits++
			case unitWaiting, unitBlocked:
				status.Work.WaitingUnits++
			case unitFailed:
				status.Work.FailedUnits++
			}
		}
	}
	graphs.mu.Unlock()
	sort.Slice(status.Work.ActiveGraphLinks, func(i, j int) bool {
		left, right := status.Work.ActiveGraphLinks[i], status.Work.ActiveGraphLinks[j]
		if left.updatedAt.Equal(right.updatedAt) {
			return left.GraphID < right.GraphID
		}
		return left.updatedAt.After(right.updatedAt)
	})
	if len(status.Work.ActiveGraphLinks) > maxSystemStatusLinks {
		status.Work.ActiveGraphLinks = status.Work.ActiveGraphLinks[:maxSystemStatusLinks]
	}
	sort.Slice(status.Work.Decisions, func(i, j int) bool {
		left, right := status.Work.Decisions[i], status.Work.Decisions[j]
		if left.createdAt.Equal(right.createdAt) {
			return left.ID < right.ID
		}
		return left.createdAt.After(right.createdAt)
	})
	if len(status.Work.Decisions) > maxSystemStatusLinks {
		status.Work.Decisions = status.Work.Decisions[:maxSystemStatusLinks]
	}
	status.Usage = summarizeStoredRunUsage(graphs.runs)
	if path := strings.TrimSpace(os.Getenv("ZENCHRON_UPDATE_STATUS_FILE")); path != "" {
		if update, err := updater.ReadStatus(path); err != nil {
			status.UpdateState = "unavailable"
			status.UpdateReason = "Updater status is unavailable"
		} else {
			status.UpdateState = update.State
			status.UpdateRevision = update.LatestRevision
			status.UpdateProgress = update.Progress
			if update.State == "blocked" || update.State == "failed" {
				status.UpdateReason = update.BlockReason
				if status.UpdateReason == "" {
					status.UpdateReason = update.LastFailureReason
				}
			}
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, status)
}

func summarizeStoredRunUsage(runs *agentRunStore) *systemStatusUsage {
	if runs == nil {
		return nil
	}

	const maxTokenTotal = int64(1<<63 - 1)
	usage := &systemStatusUsage{}
	var inputTokens, outputTokens int64
	var costUSD float64
	tokensValid, costValid := true, true

	runs.mu.Lock()
	defer runs.mu.Unlock()
	for _, run := range runs.items {
		usage.Runs++
		if run.Usage == nil {
			continue
		}
		usage.RunsWithUsage++
		if tokensValid {
			if run.Usage.InputTokens > maxTokenTotal-inputTokens || run.Usage.OutputTokens > maxTokenTotal-outputTokens {
				tokensValid = false
			} else {
				inputTokens += run.Usage.InputTokens
				outputTokens += run.Usage.OutputTokens
			}
		}
		if run.Usage.CostUSD == nil {
			continue
		}
		usage.RunsWithCost++
		if costValid {
			costUSD += *run.Usage.CostUSD
			costValid = !math.IsInf(costUSD, 0) && !math.IsNaN(costUSD)
		}
	}
	if usage.RunsWithUsage > 0 && tokensValid {
		usage.InputTokens, usage.OutputTokens = &inputTokens, &outputTokens
	}
	if usage.RunsWithCost > 0 && costValid {
		usage.CostUSD = &costUSD
	}
	return usage
}

func localStatusCredential() string {
	// Read the plist first so a live credential repair also updates an older supervisor process.
	if path, err := managedLaunchAgentPlistPath(); err == nil {
		if contents, err := os.ReadFile(path); err == nil {
			if token, found, err := launchAgentStatusCredential(contents); err == nil && found && token != "" {
				return token
			}
		}
	}
	return strings.TrimSpace(os.Getenv("ZENCHRON_LOCAL_STATUS_TOKEN"))
}
