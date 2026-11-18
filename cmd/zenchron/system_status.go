package main

import (
	"net/http"
	"os"
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
		ActiveGraphs  int `json:"active_graphs"`
		BlockedGraphs int `json:"blocked_graphs"`
		QueuedUnits   int `json:"queued_units"`
		RunningUnits  int `json:"running_units"`
		WaitingUnits  int `json:"waiting_units"`
		FailedUnits   int `json:"failed_units"`
		OpenDecisions int `json:"open_decisions"`
	} `json:"work"`
	UpdateState string `json:"update_state"`
}

func writeLocalSystemStatus(w http.ResponseWriter, r *http.Request, registry *workerRegistry, graphs *workGraphStore) {
	if !isLoopbackRequest(r) || !localRequestOrigin(r) {
		http.Error(w, "system status is available only to the local operator", http.StatusForbidden)
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
	for _, graph := range graphs.graphs {
		if graph.Status == graphActive {
			status.Work.ActiveGraphs++
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
			if message.Type == messageDecisionRequest && !resolved[message.ID] {
				status.Work.OpenDecisions++
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

	if path := strings.TrimSpace(os.Getenv("ZENCHRON_UPDATE_STATUS_FILE")); path != "" {
		if update, err := updater.ReadStatus(path); err == nil {
			status.UpdateState = update.State
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, status)
}
