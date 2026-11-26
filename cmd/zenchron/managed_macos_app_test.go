package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Sealed releases are read-only; the staged copy must still move into place and be cleaned up.
func TestStableMenuBarInstallFromSealedRelease(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "release", "Zenchron Menu Bar.app")
	destination := filepath.Join(root, "Applications", "Zenchron Menu Bar.app")
	for _, bundle := range []string{source, destination} {
		contents := filepath.Join(bundle, "Contents")
		if err := os.MkdirAll(filepath.Join(contents, "MacOS"), 0o700); err != nil {
			t.Fatal(err)
		}
		plist := "<plist><dict><key>CFBundleIdentifier</key><string>" + managedMenuBarBundleID + "</string></dict></plist>"
		if err := os.WriteFile(filepath.Join(contents, "Info.plist"), []byte(plist), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(contents, "MacOS", "zenchron-menubar"), []byte(bundle), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	seal := func(mode os.FileMode) {
		_ = filepath.WalkDir(source, func(path string, entry os.DirEntry, _ error) error {
			if entry.IsDir() || entry.Name() == "zenchron-menubar" {
				return os.Chmod(path, mode|0o111)
			}
			return os.Chmod(path, mode)
		})
	}
	seal(0o444)
	// A release sealed before #530 lost the executable's exec bit too.
	if err := os.Chmod(filepath.Join(source, "Contents", "MacOS", "zenchron-menubar"), 0o444); err != nil {
		t.Fatal(err)
	}
	// An app installed from such a release is read-only as well.
	if err := os.Chmod(filepath.Join(destination, "Contents", "MacOS", "zenchron-menubar"), 0o555); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(destination, "Contents", "MacOS"), 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { seal(0o644) })
	tools := filepath.Join(root, "tools")
	if err := os.MkdirAll(tools, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tools, "ditto"), []byte("#!/bin/sh\ncp -R \"$1\" \"$2\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", tools+string(os.PathListSeparator)+os.Getenv("PATH"))
	if err := installStableMenuBarApp(source, destination); err != nil {
		t.Fatalf("install from sealed release: %v", err)
	}
	if installed, err := os.ReadFile(filepath.Join(destination, "Contents", "MacOS", "zenchron-menubar")); err != nil || string(installed) != source {
		t.Fatalf("installed executable = %q, %v", installed, err)
	}
	leftovers, err := filepath.Glob(filepath.Join(filepath.Dir(destination), ".zenchron-menu-bar-*"))
	if err != nil || len(leftovers) != 0 {
		t.Fatalf("staging directories left behind: %v, %v", leftovers, err)
	}
}

func TestStableMenuBarInstallIsIdempotentAndUpdatesInPlace(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "release", "Zenchron Menu Bar.app")
	destination := filepath.Join(root, "Applications", "Zenchron Menu Bar.app")
	writeBundle := func(path, identifier, executable string) {
		t.Helper()
		contents := filepath.Join(path, "Contents")
		if err := os.MkdirAll(filepath.Join(contents, "MacOS"), 0o700); err != nil {
			t.Fatal(err)
		}
		plist := "<plist><dict><key>CFBundleIdentifier</key><string>" + identifier + "</string></dict></plist>"
		if err := os.WriteFile(filepath.Join(contents, "Info.plist"), []byte(plist), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(contents, "MacOS", "zenchron-menubar"), []byte(executable), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	writeBundle(source, managedMenuBarBundleID, "v1")
	tools := filepath.Join(root, "tools")
	if err := os.MkdirAll(tools, 0o700); err != nil {
		t.Fatal(err)
	}
	ditto := filepath.Join(tools, "ditto")
	if err := os.WriteFile(ditto, []byte("#!/bin/sh\ncp -R \"$1\" \"$2\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", tools+string(os.PathListSeparator)+os.Getenv("PATH"))
	if err := installStableMenuBarApp(source, destination); err != nil {
		t.Fatal(err)
	}
	if err := installStableMenuBarApp(source, destination); err != nil {
		t.Fatalf("second installation was not idempotent: %v", err)
	}
	writeBundle(source, managedMenuBarBundleID, "v2")
	if err := installStableMenuBarApp(source, destination); err != nil {
		t.Fatalf("update was not applied: %v", err)
	}
	installed, err := os.ReadFile(filepath.Join(destination, "Contents", "MacOS", "zenchron-menubar"))
	if err != nil || string(installed) != "v2" {
		t.Fatalf("installed executable = %q, %v", installed, err)
	}
	entries, err := os.ReadDir(filepath.Dir(destination))
	if err != nil || len(entries) != 1 || entries[0].Name() != filepath.Base(destination) {
		t.Fatalf("staging or backup bundle remained: %v, %v", entries, err)
	}
}

func TestStableMenuBarInstallRefusesAnUnmanagedBundle(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "release", "Zenchron Menu Bar.app")
	destination := filepath.Join(root, "Applications", "Zenchron Menu Bar.app")
	contents := func(path, identifier string) {
		t.Helper()
		appContents := filepath.Join(path, "Contents")
		if err := os.MkdirAll(filepath.Join(appContents, "MacOS"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(appContents, "Info.plist"),
			[]byte("<string>"+identifier+"</string>"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(appContents, "MacOS", "zenchron-menubar"), []byte("contents"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	contents(source, managedMenuBarBundleID)
	contents(destination, "another.application")
	if err := installStableMenuBarApp(source, destination); err == nil {
		t.Fatal("installation replaced an unrelated application")
	}
	installed, err := os.ReadFile(filepath.Join(destination, "Contents", "MacOS", "zenchron-menubar"))
	if err != nil || string(installed) != "contents" {
		t.Fatalf("unmanaged destination changed: %q, %v", installed, err)
	}
}
