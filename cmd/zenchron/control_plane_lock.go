package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func acquireControlPlaneLock(dataDir string) (*os.File, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create runtime ownership directory: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(dataDir, "control-plane.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open control-plane ownership lock: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, fmt.Errorf("another control plane already owns this state directory: %w", err)
	}
	return file, nil
}
