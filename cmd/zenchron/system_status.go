package main

import (
	"crypto/hmac"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
)

type systemStatus struct {
	Revision     string `json:"revision,omitempty"`
	DashboardURL string `json:"dashboard_url"`
	Workers      struct {
		Online int `json:"online"`
		Total  int `json:"total"`
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
	UpdateState    string `json:"update_state"`
	UpdateRevision string `json:"update_revision,omitempty"`
	UpdateProgress string `json:"update_progress,omitempty"`
	UpdateReason   string `json:"update_reason,omitempty"`
}

const maxSystemStatusLinks = 5

type systemStatusWorkItem struct {
	GraphID        string `json:"graph_id"`
	ObjectiveID    string `json:"objective_id"`
	ObjectiveTitle string `json:"objective_title"`
	updatedAt      time.Time
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
	token := strings.TrimSpace(os.Getenv("ZENCHRON_LOCAL_STATUS_TOKEN"))
	if token == "" || !hmac.Equal([]byte(r.Header.Get("X-Zenchron-Local-Status-Token")), []byte(token)) {
		http.Error(w, "system status credential required", http.StatusUnauthorized)
		return
	}

	status := systemStatus{Revision: strings.TrimSpace(os.Getenv("ZENCHRON_RELEASE_REVISION")),
		DashboardURL: "http://127.0.0.1:8080/?mode=live", UpdateState: "unknown"}
	registry.mu.RLock()
	status.Workers.Total = len(registry.workers)
	for _, worker := range registry.workers {
		if time.Since(worker.LastSeen) <= workerOnlineWindow {
			status.Workers.Online++
		}
	}
	registry.mu.RUnlock()

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
