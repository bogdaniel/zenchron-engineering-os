package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
)

// ponytail: one API process per data directory; snapshots cap at 16 MiB before database migration.
const maxStateFileSize = 16 << 20

const stateFileVersion = updater.StateSchemaVersion

func controlPlaneDataDirectory() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("ZENCHRON_DATA_DIR")); configured != "" {
		return filepath.Abs(configured)
	}
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("find user config directory: %w", err)
	}
	return filepath.Join(configDir, "zenchron"), nil
}

func loadStateFile(path string, target any) (bool, error) {
	return loadStateFileWithLimit(path, target, maxStateFileSize)
}

func loadStateFileWithLimit(path string, target any, limit int64) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect state file: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return false, fmt.Errorf("state file is not regular or exceeds %d bytes", limit)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false, fmt.Errorf("read state file: %w", err)
	}
	if int64(len(data)) > limit {
		return false, fmt.Errorf("state file exceeds %d bytes", limit)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return false, fmt.Errorf("decode state file: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return false, fmt.Errorf("state file must contain one JSON value")
	}
	return true, nil
}

func writeStateFile(path string, value any) (err error) {
	return writeStateFileWithLimit(path, value, maxStateFileSize)
}

func writeStateFileWithLimit(path string, value any, limit int64) (err error) {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode state: %w", err)
	}
	if int64(len(data)) > limit {
		return fmt.Errorf("state exceeds %d bytes", limit)
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".zenchron-state-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary state file: %w", err)
	}
	tempPath := temp.Name()
	closed, renamed := false, false
	defer func() {
		if !closed {
			if closeErr := temp.Close(); err == nil && closeErr != nil {
				err = fmt.Errorf("close temporary state file: %w", closeErr)
			}
		}
		if !renamed {
			if removeErr := os.Remove(tempPath); err == nil && removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				err = fmt.Errorf("remove temporary state file: %w", removeErr)
			}
		}
	}()
	if err := temp.Chmod(0o600); err != nil {
		return fmt.Errorf("secure temporary state file: %w", err)
	}
	if _, err := temp.Write(data); err != nil {
		return fmt.Errorf("write temporary state file: %w", err)
	}
	if err := temp.Sync(); err != nil {
		return fmt.Errorf("sync temporary state file: %w", err)
	}
	if err := temp.Close(); err != nil {
		closed = true
		return fmt.Errorf("close temporary state file: %w", err)
	}
	closed = true
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace state file: %w", err)
	}
	renamed = true
	return nil
}

func ensurePrivateDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("%s is not a directory", filepath.Base(path))
	}
	return nil
}
