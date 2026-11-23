package main

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestManagedOAuthRollbackWaitsForGracefulDrainBeforeRestartingAgain(t *testing.T) {
	home := t.TempDir()
	path := managedOAuthConfigPath(home)
	if err := os.WriteFile(path, []byte(`{"client_id":"temporary"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	restartCalled := false
	waitCalled := false
	err := rollbackManagedOAuthAfterFailure(home, func() (int, error) { return 1, nil }, func() error {
		restartCalled = true
		return nil
	}, func(string) error {
		waitCalled = true
		return nil
	}, fmt.Errorf("OAuth activation timed out"))
	if err == nil || !strings.Contains(err.Error(), "1 active agent run(s)") {
		t.Fatalf("rollback result = %v, want active-run deferral", err)
	}
	if restartCalled || waitCalled {
		t.Fatalf("rollback called restart=%v wait=%v while work remained active", restartCalled, waitCalled)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("OAuth config was removed during graceful drain: %v", err)
	}
}

func TestManagedOAuthRollbackFailsClosedWhenWorkStateIsUnavailable(t *testing.T) {
	home := t.TempDir()
	path := managedOAuthConfigPath(home)
	if err := os.WriteFile(path, []byte(`{"client_id":"temporary"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	restartCalled := false
	err := rollbackManagedOAuthAfterFailure(home, func() (int, error) { return 0, fmt.Errorf("status unavailable") },
		func() error { restartCalled = true; return nil }, waitForLocalWorkspace, fmt.Errorf("OAuth activation timed out"))
	if err == nil || !strings.Contains(err.Error(), "work state could not be verified") {
		t.Fatalf("rollback result = %v, want fail-closed status", err)
	}
	if restartCalled {
		t.Fatal("rollback sent a second restart after active work could not be verified")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("OAuth config was removed while work state was unavailable: %v", err)
	}
}

func TestManagedOAuthRollbackRestartsAfterWorkIsVerifiedIdle(t *testing.T) {
	home := t.TempDir()
	path := managedOAuthConfigPath(home)
	if err := os.WriteFile(path, []byte(`{"client_id":"temporary"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	restartCalls := 0
	err := rollbackManagedOAuthAfterFailure(home, func() (int, error) { return 0, nil }, func() error {
		restartCalls++
		return nil
	}, func(string) error { return nil }, fmt.Errorf("OAuth activation timed out"))
	if err == nil || !strings.Contains(err.Error(), "OAuth activation timed out") {
		t.Fatalf("rollback result = %v, want activation failure", err)
	}
	if restartCalls != 1 {
		t.Fatalf("restart calls = %d, want one local-workspace restart", restartCalls)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("OAuth config still exists after idle rollback: stat error = %v", err)
	}
}
