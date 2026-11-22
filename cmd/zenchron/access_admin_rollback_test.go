package main

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

type failingAuditLogFile struct {
	*os.File
	writeErr error
	syncErr  error
	closeErr error
}

func (file *failingAuditLogFile) Write(data []byte) (int, error) {
	if file.writeErr == nil {
		return file.File.Write(data)
	}
	written, err := file.File.Write(data[:len(data)/2])
	return written, errors.Join(file.writeErr, err)
}

func (file *failingAuditLogFile) Sync() error {
	if file.syncErr != nil {
		return file.syncErr
	}
	return file.File.Sync()
}

func (file *failingAuditLogFile) Close() error {
	return errors.Join(file.closeErr, file.File.Close())
}

func TestAuditAppendFailuresRestoreOriginalLog(t *testing.T) {
	for name, failure := range map[string]struct {
		writeErr error
		syncErr  error
		closeErr error
	}{
		"partial write": {writeErr: errors.New("write failed")},
		"sync":          {syncErr: errors.New("sync failed")},
		"close":         {closeErr: errors.New("close failed")},
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "audit.jsonl")
			previous := []byte("{\"action\":\"prior\"}\n")
			if err := os.WriteFile(path, previous, 0o600); err != nil {
				t.Fatal(err)
			}
			file, err := os.OpenFile(path, os.O_APPEND|os.O_RDWR, 0o600)
			if err != nil {
				t.Fatal(err)
			}
			failing := &failingAuditLogFile{File: file, writeErr: failure.writeErr, syncErr: failure.syncErr, closeErr: failure.closeErr}
			if err := appendAuditEntry(failing, path, []byte("{\"action\":\"new\"}\n")); err == nil {
				t.Fatal("failed append returned nil")
			}
			after, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(after, previous) {
				t.Fatalf("audit log after failed append = %q, want %q", after, previous)
			}
		})
	}
}

func TestAdminChangeFailureRestoresPolicy(t *testing.T) {
	harness := newAdminHarness(t)
	before, err := os.ReadFile(harness.path)
	if err != nil {
		t.Fatal(err)
	}
	auditPath := filepath.Join(t.TempDir(), "audit")
	if err := os.Mkdir(auditPath, 0o700); err != nil {
		t.Fatal(err)
	}
	harness.config.access.auditPath = auditPath

	body := fmt.Sprintf(`{"repositories":[%q]}`, repositoryA)
	response := harness.user("carol", http.MethodPut, "/api/v1/admin/users/bob", body)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("failed audit append returned HTTP %d: %s", response.Code, response.Body.String())
	}
	after, err := os.ReadFile(harness.path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(after, before) {
		t.Fatalf("policy changed after failed audit append:\nbefore: %s\nafter:  %s", before, after)
	}
}
