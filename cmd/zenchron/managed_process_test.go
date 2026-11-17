package main

import (
	"strings"
	"testing"
)

func TestManagedWorkerReceivesOnlyExecutionCredentials(t *testing.T) {
	base := []string{
		"PATH=/usr/bin", "ZENCHRON_WORKER_TOKEN=worker-token", "ZENCHRON_GITHUB_TOKEN=github-token",
		"ZENCHRON_GITHUB_WEBHOOK_SECRET=webhook-secret", "ZENCHRON_SESSION_SECRET=session-secret",
		"ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH=/private/app.pem", "ZENCHRON_ACCESS_FILE=/private/access.json",
		"ZENCHRON_DATA_DIR=/private/state", "ZENCHRON_UPDATE_REPOSITORY=owner/repo",
	}
	got := strings.Join(managedWorkerEnvironment(base, "/projects", "0123456789abcdef0123456789abcdef01234567"), "\n")
	for _, key := range []string{"ZENCHRON_GITHUB_TOKEN", "ZENCHRON_GITHUB_WEBHOOK_SECRET", "ZENCHRON_SESSION_SECRET",
		"ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH", "ZENCHRON_ACCESS_FILE", "ZENCHRON_DATA_DIR", "ZENCHRON_UPDATE_REPOSITORY"} {
		if strings.Contains(got, key) {
			t.Fatalf("worker received privileged environment variable %s", key)
		}
	}
	for _, expected := range []string{"ZENCHRON_WORKER_TOKEN=worker-token", "ZENCHRON_PROJECTS_ROOT=/projects",
		"ZENCHRON_RELEASE_REVISION=0123456789abcdef0123456789abcdef01234567", "ZENCHRON_CONTROL_PLANE_URL=http://127.0.0.1:8080"} {
		if !strings.Contains(got, expected) {
			t.Fatalf("worker environment omitted %q: %s", expected, got)
		}
	}
}
