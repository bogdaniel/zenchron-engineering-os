package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
)

const managedMenuBarBundleID = "com.zenchron.engineering.menubar"

func installManagedMenuBarApp(home, revision string) error {
	source := filepath.Join(home, "releases", revision, "macos", "Zenchron Menu Bar.app")
	if _, err := os.Lstat(source); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect release menu-bar app: %w", err)
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolve menu-bar install location: %w", err)
	}
	return installManagedMenuBarAppAtHome(home, revision, userHome)
}

func installManagedMenuBarAppAtHome(home, revision, userHome string) error {
	source := filepath.Join(home, "releases", revision, "macos", "Zenchron Menu Bar.app")
	if _, err := os.Lstat(source); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect release menu-bar app: %w", err)
	}
	repository := strings.TrimSpace(os.Getenv("ZENCHRON_UPDATE_REPOSITORY"))
	if repository == "" {
		repository = "bogdaniel/zenchron-engineering-os"
	}
	manifest, err := updater.VerifyRelease(filepath.Join(home, "releases", revision), updater.Candidate{
		Repository: repository, Commit: revision, Tree: readReleaseTree(home, revision),
	})
	if err != nil {
		return fmt.Errorf("verify menu-bar app release: %w", err)
	}
	if manifest.Platform == "" {
		return nil
	}
	destination := filepath.Join(userHome, "Applications", "Zenchron Menu Bar.app")
	return installStableMenuBarApp(source, destination)
}

func launchManagedMenuBarApp() error {
	userHome, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolve menu-bar app location: %w", err)
	}
	path := filepath.Join(userHome, "Applications", "Zenchron Menu Bar.app")
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect installed menu-bar app: %w", err)
	}
	if err := validateManagedMenuBarApp(path); err != nil {
		return fmt.Errorf("managed menu-bar app is unavailable: %w", err)
	}
	if output, err := exec.Command("open", "-g", path).CombinedOutput(); err != nil {
		return fmt.Errorf("launch menu-bar app: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func installStableMenuBarApp(source, destination string) error {
	if err := validateManagedMenuBarApp(source); err != nil {
		return fmt.Errorf("validate release menu-bar app: %w", err)
	}
	parent := filepath.Dir(destination)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return fmt.Errorf("create menu-bar app directory: %w", err)
	}
	staging, err := os.MkdirTemp(parent, ".zenchron-menu-bar-*")
	if err != nil {
		return fmt.Errorf("create menu-bar app staging directory: %w", err)
	}
	defer os.RemoveAll(staging)
	stagedApp := filepath.Join(staging, filepath.Base(destination))
	if output, err := exec.Command("ditto", source, stagedApp).CombinedOutput(); err != nil {
		return fmt.Errorf("stage menu-bar app: %w: %s", err, strings.TrimSpace(string(output)))
	}
	// Sealed releases are read-only; moving a directory and removing staging both need owner write access.
	if err := filepath.WalkDir(stagedApp, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		return os.Chmod(path, info.Mode().Perm()|0o200)
	}); err != nil {
		return fmt.Errorf("make staged menu-bar app writable: %w", err)
	}
	if err := validateManagedMenuBarApp(stagedApp); err != nil {
		return fmt.Errorf("verify staged menu-bar app: %w", err)
	}
	backup := filepath.Join(staging, "previous.app")
	if _, err := os.Lstat(destination); err == nil {
		if err := validateManagedMenuBarApp(destination); err != nil {
			return fmt.Errorf("refuse to replace existing application: %w", err)
		}
		if err := os.Rename(destination, backup); err != nil {
			return fmt.Errorf("preserve installed menu-bar app: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect installed menu-bar app: %w", err)
	}
	if err := os.Rename(stagedApp, destination); err != nil {
		if _, backupErr := os.Lstat(backup); backupErr == nil {
			if restoreErr := os.Rename(backup, destination); restoreErr != nil {
				return errors.Join(fmt.Errorf("activate menu-bar app: %w", err), fmt.Errorf("restore previous app: %w", restoreErr))
			}
		}
		return fmt.Errorf("activate menu-bar app: %w", err)
	}
	if err := os.RemoveAll(backup); err != nil {
		return fmt.Errorf("remove replaced menu-bar app: %w", err)
	}
	return nil
}

func validateManagedMenuBarApp(path string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("bundle is missing or is not a real directory")
	}
	if err := filepath.WalkDir(path, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 || (!entry.IsDir() && !entry.Type().IsRegular()) {
			return errors.New("bundle contains a symbolic link or unsupported file")
		}
		return nil
	}); err != nil {
		return fmt.Errorf("inspect bundle contents: %w", err)
	}
	plistPath := filepath.Join(path, "Contents", "Info.plist")
	plistInfo, err := os.Lstat(plistPath)
	if err != nil || !plistInfo.Mode().IsRegular() {
		return errors.New("bundle Info.plist is missing or unsafe")
	}
	plist, err := os.ReadFile(plistPath)
	if err != nil || !strings.Contains(string(plist), "<string>"+managedMenuBarBundleID+"</string>") {
		return errors.New("bundle identifier does not match Zenchron Menu Bar")
	}
	executable := filepath.Join(path, "Contents", "MacOS", "zenchron-menubar")
	executableInfo, err := os.Lstat(executable)
	if err != nil || !executableInfo.Mode().IsRegular() || executableInfo.Mode().Perm()&0o111 == 0 {
		return errors.New("bundle executable is missing or not executable")
	}
	return nil
}
