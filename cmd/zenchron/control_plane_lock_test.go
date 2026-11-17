package main

import "testing"

func TestControlPlaneLockPreventsTwoWriters(t *testing.T) {
	directory := t.TempDir()
	first, err := acquireControlPlaneLock(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if second, err := acquireControlPlaneLock(directory); err == nil {
		second.Close()
		t.Fatal("second control plane acquired the same state directory")
	}
}
