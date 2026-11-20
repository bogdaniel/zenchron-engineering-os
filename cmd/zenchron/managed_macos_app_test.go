package main

import (
	"os"
	"path/filepath"
	"testing"
)

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
