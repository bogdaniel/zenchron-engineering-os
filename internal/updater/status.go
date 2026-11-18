package updater

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const maxStatusReason = 500

type Status struct {
	RunningRevision     string    `json:"running_revision"`
	LatestRevision      string    `json:"latest_revision,omitempty"`
	State               string    `json:"state"`
	Progress            string    `json:"progress,omitempty"`
	WorkerCompatible    bool      `json:"worker_compatible"`
	ActiveRuns          int       `json:"active_runs"`
	BlockReason         string    `json:"block_reason,omitempty"`
	LastAttempt         time.Time `json:"last_attempt,omitempty"`
	LastSuccess         time.Time `json:"last_success,omitempty"`
	LastSuccessRevision string    `json:"last_success_revision,omitempty"`
	LastFailure         time.Time `json:"last_failure,omitempty"`
	LastFailedRevision  string    `json:"last_failed_revision,omitempty"`
	LastFailureReason   string    `json:"last_failure_reason,omitempty"`
}

func (status Status) Validate() error {
	switch status.State {
	case "idle", "checking", "building", "verifying", "waiting_for_runs", "activating", "active", "failed", "blocked":
	default:
		return fmt.Errorf("invalid update state %q", status.State)
	}
	if status.RunningRevision != "" && !fullSHA.MatchString(status.RunningRevision) {
		return errors.New("running revision is invalid")
	}
	if status.LatestRevision != "" && !fullSHA.MatchString(status.LatestRevision) {
		return errors.New("latest revision is invalid")
	}
	if status.ActiveRuns < 0 {
		return errors.New("active run count cannot be negative")
	}
	if status.LastSuccessRevision != "" && !fullSHA.MatchString(status.LastSuccessRevision) {
		return errors.New("last successful revision is invalid")
	}
	if status.LastFailedRevision != "" && !fullSHA.MatchString(status.LastFailedRevision) {
		return errors.New("last failed revision is invalid")
	}
	if len(status.Progress) > maxStatusReason || len(status.BlockReason) > maxStatusReason || len(status.LastFailureReason) > maxStatusReason {
		return errors.New("update status text exceeds its size limit")
	}
	return nil
}

func ReadStatus(path string) (Status, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return Status{}, err
	}
	var status Status
	decoder := json.NewDecoder(strings.NewReader(string(contents)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&status); err != nil {
		return Status{}, fmt.Errorf("decode update status: %w", err)
	}
	if err := status.Validate(); err != nil {
		return Status{}, err
	}
	return status, nil
}

func WriteStatus(path string, status Status) error {
	if err := status.Validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create update status directory: %w", err)
	}
	contents, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return fmt.Errorf("encode update status: %w", err)
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(contents, '\n'), 0o600); err != nil {
		return fmt.Errorf("write update status: %w", err)
	}
	file, err := os.OpenFile(temporary, os.O_RDWR, 0)
	if err != nil {
		os.Remove(temporary)
		return fmt.Errorf("open update status: %w", err)
	}
	if err := file.Sync(); err != nil {
		file.Close()
		os.Remove(temporary)
		return fmt.Errorf("sync update status: %w", err)
	}
	if err := file.Close(); err != nil {
		os.Remove(temporary)
		return fmt.Errorf("close update status: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		os.Remove(temporary)
		return fmt.Errorf("publish update status: %w", err)
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return fmt.Errorf("open update status directory: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync update status directory: %w", err)
	}
	return nil
}
