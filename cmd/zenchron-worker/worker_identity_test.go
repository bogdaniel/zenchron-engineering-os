package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkerIdentitySurvivesAHostnameChange(t *testing.T) {
	config := t.TempDir()
	first, err := persistentWorkerID(config, "Bogdans-Laptop.local")
	if err != nil {
		t.Fatal(err)
	}
	// The first start keeps today's hostname-derived identity, so existing repository links still resolve.
	if first != stableID("Bogdans-Laptop.local\x00"+config) {
		t.Fatalf("first identity = %s, want the hostname-derived one", first)
	}
	if info, err := os.Stat(filepath.Join(config, "zenchron", "worker-id")); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("identity file = %v, %v", info, err)
	}
	// macOS renamed the host when the network changed.
	second, err := persistentWorkerID(config, "dhcp-10-0-0-12.local")
	if err != nil || second != first {
		t.Fatalf("identity after hostname change = %s, %v; want %s", second, err, first)
	}
	project := t.TempDir()
	if projectAt(project, first).ID != projectAt(project, second).ID {
		t.Fatal("project identity changed with the hostname")
	}
}

func TestWorkerIdentityRefusesACorruptFile(t *testing.T) {
	config := t.TempDir()
	path := filepath.Join(config, "zenchron", "worker-id")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("not-an-id\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := persistentWorkerID(config, "host"); err == nil || !strings.Contains(err.Error(), "invalid") {
		t.Fatalf("corrupt identity: error = %v", err)
	}
}
