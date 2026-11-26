package updater

import (
	"os"
	"path/filepath"
	"testing"
)

// The menu-bar app ships its executable outside bin/; sealing must not strip it.
func TestMakeReadOnlyKeepsBundleExecutables(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "macos", "Zenchron Menu Bar.app", "Contents", "MacOS", "zenchron-menubar")
	plist := filepath.Join(root, "macos", "Zenchron Menu Bar.app", "Contents", "Info.plist")
	if err := os.MkdirAll(filepath.Dir(executable), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(plist, []byte("plist"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := makeReadOnly(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = filepath.WalkDir(root, func(path string, _ os.DirEntry, _ error) error { return os.Chmod(path, 0o755) })
	})
	for path, want := range map[string]os.FileMode{executable: 0o555, plist: 0o444} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != want {
			t.Fatalf("%s mode = %v, want %v", filepath.Base(path), info.Mode().Perm(), want)
		}
	}
}
