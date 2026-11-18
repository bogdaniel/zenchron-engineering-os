package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestVerifyReleaseBindsManifestToCandidateAndArtifactDigests(t *testing.T) {
	root := t.TempDir()
	candidate := Candidate{Repository: "bogdaniel/zenchron-engineering-os",
		Commit: "0123456789abcdef0123456789abcdef01234567", Tree: "abcdef0123456789abcdef0123456789abcdef01"}
	for path, content := range map[string]string{
		"bin/zenchron": "control plane", "bin/zenchron-worker": "worker", "dashboard/index.html": "dashboard",
	} {
		fullPath := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fullPath, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	manifest := Manifest{Repository: candidate.Repository, Commit: candidate.Commit, Tree: candidate.Tree,
		StateSchemaVersion: StateSchemaVersion, ControlPlaneProtocolVersion: workerapi.ProtocolVersion,
		WorkerProtocolVersion: workerapi.ProtocolVersion, Artifacts: map[string]string{}}
	for path, content := range map[string]string{
		"bin/zenchron": "control plane", "bin/zenchron-worker": "worker", "dashboard/index.html": "dashboard",
	} {
		digest := sha256.Sum256([]byte(content))
		manifest.Artifacts[path] = hex.EncodeToString(digest[:])
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "release.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyRelease(root, candidate); err != nil {
		t.Fatalf("VerifyRelease() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "bin", "zenchron-worker"), []byte("modified"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyRelease(root, candidate); err == nil {
		t.Fatal("VerifyRelease() accepted a modified worker artifact")
	}
}

func TestActiveReleasePointerIsAtomicAndValidatesSHA(t *testing.T) {
	root := t.TempDir()
	commit := "0123456789abcdef0123456789abcdef01234567"
	if err := SetActiveRelease(root, commit); err != nil {
		t.Fatal(err)
	}
	if got, err := ActiveRelease(root); err != nil || got != commit {
		t.Fatalf("ActiveRelease() = %q, %v; want %q", got, err, commit)
	}
	if err := SetActiveRelease(root, "main"); err == nil {
		t.Fatal("SetActiveRelease() accepted a branch name")
	}
}

func TestReleaseRetentionKeepsActiveAndPreviousRelease(t *testing.T) {
	root := t.TempDir()
	revisions := []string{
		"0123456789abcdef0123456789abcdef01234567",
		"abcdef0123456789abcdef0123456789abcdef01",
		"123456789abcdef0123456789abcdef012345678",
	}
	for _, revision := range revisions {
		path := filepath.Join(root, "releases", revision, "bin")
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "zenchron"), []byte(revision), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := SetActiveRelease(root, revisions[2]); err != nil {
		t.Fatal(err)
	}
	if err := RetainReleases(root, revisions[1]); err != nil {
		t.Fatal(err)
	}
	for index, revision := range revisions {
		_, err := os.Stat(filepath.Join(root, "releases", revision))
		if index > 0 && err != nil {
			t.Fatalf("retained release %s was removed: %v", revision, err)
		}
		if index == 0 && !os.IsNotExist(err) {
			t.Fatalf("old release %s remains: %v", revision, err)
		}
	}
}

func TestCandidateRequiresRepositoryAndFullLowercaseSHAs(t *testing.T) {
	for _, candidate := range []Candidate{
		{Repository: "owner/repo/extra", Commit: "0123456789abcdef0123456789abcdef01234567", Tree: "abcdef0123456789abcdef0123456789abcdef01"},
		{Repository: "owner/repo", Commit: "abcdef", Tree: "abcdef0123456789abcdef0123456789abcdef01"},
		{Repository: "owner/repo", Commit: "0123456789ABCDEF0123456789ABCDEF01234567", Tree: "abcdef0123456789abcdef0123456789abcdef01"},
	} {
		if err := candidate.Validate(); err == nil {
			t.Fatalf("Candidate.Validate() accepted %#v", candidate)
		}
	}
}

func TestBuildEnvironmentRemovesCredentialsButKeepsToolchainPath(t *testing.T) {
	got := safeBuildEnvironment([]string{
		"PATH=/usr/bin", "HOME=/Users/operator", "ZENCHRON_GITHUB_TOKEN=secret",
		"GITHUB_TOKEN=secret", "NODE_AUTH_TOKEN=secret", "OPENAI_API_KEY=secret", "LANG=en_US.UTF-8",
	})
	joined := strings.Join(got, "\n")
	if !strings.Contains(joined, "PATH=/usr/bin") || !strings.Contains(joined, "HOME=/Users/operator") ||
		!strings.Contains(joined, "LANG=en_US.UTF-8") {
		t.Fatalf("safeBuildEnvironment() dropped needed build variables: %q", got)
	}
	for _, secret := range []string{"ZENCHRON_GITHUB_TOKEN", "GITHUB_TOKEN", "NODE_AUTH_TOKEN", "OPENAI_API_KEY"} {
		if strings.Contains(joined, secret) {
			t.Fatalf("safeBuildEnvironment() leaked %s", secret)
		}
	}
}

func TestBuildReleaseStagesExactCommitAndMeasuresEveryArtifact(t *testing.T) {
	remote := filepath.Join(t.TempDir(), "source")
	if err := os.MkdirAll(filepath.Join(remote, "cmd", "zenchron"), 0o700); err != nil {
		t.Fatal(err)
	}
	for path, content := range map[string]string{
		"go.mod":                 "module example.test/release\n\ngo 1.23\n",
		"cmd/zenchron/main.go":   "package main\nfunc main() {}\n",
		"dashboard/package.json": "{}\n",
	} {
		fullPath := filepath.Join(remote, path)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fullPath, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{{"init", "--quiet"}, {"config", "user.name", "Release Test"},
		{"config", "user.email", "release@example.test"}, {"add", "."}, {"commit", "--quiet", "-m", "fixture"}} {
		command := exec.Command("git", args...)
		command.Dir = remote
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}
	readGit := func(args ...string) string {
		t.Helper()
		command := exec.Command("git", args...)
		command.Dir = remote
		output, err := command.Output()
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return strings.TrimSpace(string(output))
	}
	candidate := Candidate{Repository: "owner/repo", Commit: readGit("rev-parse", "HEAD"), Tree: readGit("rev-parse", "HEAD^{tree}")}
	tools := filepath.Join(t.TempDir(), "tools")
	if err := os.MkdirAll(tools, 0o700); err != nil {
		t.Fatal(err)
	}
	writeTool := func(name, script string) {
		t.Helper()
		path := filepath.Join(tools, name)
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	writeTool("go", `output=
while [ "$#" -gt 0 ]; do
	if [ "$1" = "-o" ]; then shift; output=$1; fi
	shift
done
cat > "$output" <<'EOF'
#!/bin/sh
if [ "$1" = "build-info" ]; then
	printf '%s' '{"state_schema_version":1,"protocol_version":1}'
fi
EOF
chmod +x "$output"
`)
	writeTool("npm", "if [ \"$1\" = \"run\" ]; then mkdir -p dist/assets; printf '<html>ok</html>' > dist/index.html; printf 'app' > dist/assets/app.js; fi\n")
	t.Setenv("PATH", tools+string(os.PathListSeparator)+os.Getenv("PATH"))
	root := filepath.Join(t.TempDir(), "managed")
	t.Cleanup(func() {
		_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if err == nil && entry.IsDir() {
				_ = os.Chmod(path, 0o700)
			}
			return nil
		})
	})
	manifest, err := buildReleaseFrom(context.Background(), root, candidate, remote, "")
	if err != nil {
		t.Fatalf("buildReleaseFrom() error = %v", err)
	}
	if manifest.Commit != candidate.Commit || manifest.Tree != candidate.Tree || len(manifest.Artifacts) != 4 {
		t.Fatalf("release manifest = %#v", manifest)
	}
	duplicate, err := buildReleaseFrom(context.Background(), root, candidate, remote, "")
	if err != nil || duplicate.Commit != manifest.Commit || duplicate.Artifacts["bin/zenchron"] != manifest.Artifacts["bin/zenchron"] {
		t.Fatalf("duplicate release observation = %#v, %v", duplicate, err)
	}
	if _, err := VerifyRelease(filepath.Join(root, "releases", candidate.Commit), candidate); err != nil {
		t.Fatalf("VerifyRelease() error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "releases", candidate.Commit, "build-home")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("published release contains the isolated build home: %v", err)
	}
	for _, binary := range []string{"zenchron", "zenchron-worker"} {
		info, err := os.Stat(filepath.Join(root, "releases", candidate.Commit, "bin", binary))
		if err != nil {
			t.Fatalf("stat release binary %s: %v", binary, err)
		}
		if info.Mode().Perm()&0o111 == 0 {
			t.Fatalf("release binary %s is not executable: mode %v", binary, info.Mode().Perm())
		}
	}
	if err := SetActiveRelease(root, candidate.Commit); err != nil {
		t.Fatalf("SetActiveRelease() error = %v", err)
	}
	if active, err := ActiveRelease(root); err != nil || active != candidate.Commit {
		t.Fatalf("ActiveRelease() = %q, %v", active, err)
	}
}

func TestBuildFailureLeavesCurrentReleaseActive(t *testing.T) {
	root := t.TempDir()
	previous := "0123456789abcdef0123456789abcdef01234567"
	candidate := Candidate{Repository: "owner/repo", Commit: "abcdef0123456789abcdef0123456789abcdef01",
		Tree: "1234567890abcdef1234567890abcdef12345678"}
	if err := os.MkdirAll(filepath.Join(root, "releases", previous), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := SetActiveRelease(root, previous); err != nil {
		t.Fatal(err)
	}
	if _, err := buildReleaseFrom(context.Background(), root, candidate, filepath.Join(root, "missing-source"), ""); err == nil {
		t.Fatal("release built from a missing source")
	}
	if active, err := ActiveRelease(root); err != nil || active != previous {
		t.Fatalf("failed build changed active release to %q: %v", active, err)
	}
	if _, err := os.Stat(filepath.Join(root, "releases", candidate.Commit)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed build published a partial candidate release: %v", err)
	}
	staging, err := os.ReadDir(filepath.Join(root, "staging"))
	if err != nil || len(staging) != 0 {
		t.Fatalf("failed build left staging trees behind: %v, %v", staging, err)
	}
}

func TestMakeWritableDirectoriesAllowsReadOnlyCacheCleanup(t *testing.T) {
	root := t.TempDir()
	cache := filepath.Join(root, "build-home", "pkg", "mod")
	if err := os.MkdirAll(cache, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, "module.zip"), []byte("cache"), 0o400); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(cache, 0o500); err != nil {
		t.Fatal(err)
	}
	if err := makeWritableDirectories(root); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(root); err != nil {
		t.Fatalf("read-only build cache could not be removed: %v", err)
	}
}
