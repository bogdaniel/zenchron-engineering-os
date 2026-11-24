package main

import (
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func systemUpdateStatus(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	path := strings.TrimSpace(os.Getenv("ZENCHRON_UPDATE_STATUS_FILE"))
	if path == "" {
		http.Error(w, "managed updates are unavailable", http.StatusServiceUnavailable)
		return
	}
	status, err := updater.ReadStatus(path)
	if err != nil {
		http.Error(w, "update status is unavailable", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func requestSystemUpdate(w http.ResponseWriter, r *http.Request) {
	if !isLoopbackRequest(r) || !localRequestOrigin(r) {
		http.Error(w, "update actions are available only to the local operator", http.StatusForbidden)
		return
	}
	pid, err := strconv.Atoi(strings.TrimSpace(os.Getenv("ZENCHRON_MANAGED_SUPERVISOR_PID")))
	if err != nil || pid <= 1 {
		http.Error(w, "managed update supervisor is unavailable", http.StatusServiceUnavailable)
		return
	}
	process, err := os.FindProcess(pid)
	if err != nil || process.Signal(syscall.SIGUSR1) != nil {
		http.Error(w, "could not request an update check", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func setRunAdmission(w http.ResponseWriter, r *http.Request, runs *agentRunStore, paused bool) {
	if !managedSupervisorRequest(r) {
		http.Error(w, "release transitions are available only to the local supervisor", http.StatusForbidden)
		return
	}
	runs.mu.Lock()
	runs.quiesced = paused
	runs.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func activeSystemRunCount(w http.ResponseWriter, r *http.Request, runs *agentRunStore) {
	if !managedSupervisorRequest(r) && !localStatusCredentialRequest(r) {
		http.Error(w, "run status requires a local status or supervisor credential", http.StatusForbidden)
		return
	}
	active, err := runs.countActiveRuns()
	if err != nil {
		http.Error(w, "could not persist expired agent run lease", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"active_runs": active})
}

func (store *agentRunStore) countActiveRuns() (int, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.recoverExpiredLocked(time.Now().UTC()) {
		if err := store.persistLocked(); err != nil {
			return 0, err
		}
	}
	active := 0
	for _, run := range store.items {
		if run.Status == "running" || run.Publishing {
			active++
		}
	}
	return active, nil
}

func activeSystemWorkerCompatibility(w http.ResponseWriter, r *http.Request, registry *workerRegistry) {
	if !isLoopbackRequest(r) {
		http.Error(w, "worker status is available only to the local supervisor", http.StatusForbidden)
		return
	}
	expected := strings.TrimSpace(os.Getenv("ZENCHRON_RELEASE_REVISION"))
	registry.mu.RLock()
	compatible := false
	for _, worker := range registry.workers {
		if time.Since(worker.LastSeen) <= workerOnlineWindow && worker.ProtocolVersion == workerapi.ProtocolVersion &&
			worker.ReleaseRevision == expected && expected != "" {
			compatible = true
			break
		}
	}
	registry.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]bool{"compatible": compatible})
}

func isLoopbackRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	return err == nil && isLoopbackHost(host)
}

func localRequestOrigin(r *http.Request) bool {
	origin, err := url.Parse(r.Header.Get("Origin"))
	if err != nil || origin.Host != r.Host || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return false
	}
	if !isLoopbackHost(origin.Hostname()) {
		return false
	}
	if r.TLS != nil {
		return origin.Scheme == "https"
	}
	return origin.Scheme == "http"
}
