package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// persistentWorkerID returns this worker's identity, stored once under the user config directory. The first start
// stores the ID the hostname-based formula produced, so existing repository links keep resolving; from then on a
// hostname change (macOS changes it with the network) no longer changes the worker or its project IDs.
func persistentWorkerID(configDir, hostname string) (string, error) {
	path := filepath.Join(configDir, "zenchron", "worker-id")
	if _, err := os.Stat(path); err == nil {
		return persistentWorkerIDStored(path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("read worker identity: %w", err)
	}
	id := stableID(hostname + "\x00" + configDir)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("create worker identity directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".worker-id-*")
	if err != nil {
		return "", fmt.Errorf("store worker identity: %w", err)
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.WriteString(id + "\n"); err != nil {
		temporary.Close()
		return "", fmt.Errorf("store worker identity: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return "", fmt.Errorf("store worker identity: %w", err)
	}
	// Link, not rename: a concurrent first start that already stored an identity keeps it.
	if err := os.Link(temporary.Name(), path); err != nil && !errors.Is(err, os.ErrExist) {
		return "", fmt.Errorf("store worker identity: %w", err)
	}
	return persistentWorkerIDStored(path)
}

func persistentWorkerIDStored(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read worker identity: %w", err)
	}
	if id := strings.TrimSpace(string(data)); validID(id) {
		return id, nil
	}
	return "", fmt.Errorf("worker identity file %s is invalid; remove it to derive a new identity", path)
}
