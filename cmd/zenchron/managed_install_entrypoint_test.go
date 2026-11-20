package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallStableEntrypointMigratesLegacyCommandPackageSymlink(t *testing.T) {
	userHome := t.TempDir()
	module := t.TempDir()
	canonicalDirectory := filepath.Join(userHome, ".local", "bin")
	canonical := filepath.Join(canonicalDirectory, "zenchron-engineering")
	legacyBinary := filepath.Join(module, "zenchron-engineering")
	t.Setenv("HOME", userHome)

	if err := os.MkdirAll(filepath.Join(module, "cmd", "zenchron-engineering"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(module, "go.mod"),
		[]byte("module github.com/bogdaniel/zenchron-engineering\n\ngo 1.23\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(module, "cmd", "zenchron-engineering", "main.go"),
		[]byte("package main\nimport \"fmt\"\nfunc main() { fmt.Print(\"legacy cli\") }\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	build := exec.Command("go", "build", "-o", legacyBinary, "./cmd/zenchron-engineering")
	build.Dir = module
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build legacy CLI fixture: %v: %s", err, output)
	}
	if err := os.MkdirAll(canonicalDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(legacyBinary, canonical); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", canonicalDirectory+string(os.PathListSeparator)+"/usr/bin:/bin")

	installed, err := installStableEntrypoint(filepath.Join(userHome, "managed"))
	if err != nil {
		t.Fatalf("install over recognized legacy CLI symlink: %v", err)
	}
	if installed != canonical {
		t.Fatalf("installed command = %q, want %q", installed, canonical)
	}
	output, err := exec.Command(canonical + ".legacy").CombinedOutput()
	if err != nil || strings.TrimSpace(string(output)) != "legacy cli" {
		t.Fatalf("retired CLI returned %q, %v; want preserved legacy executable", output, err)
	}
}
