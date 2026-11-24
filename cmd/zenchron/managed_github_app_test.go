package main

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
)

func TestEnsureManagedAgentPreservesSavedGitHubAppSettingsForLoadedInstallation(t *testing.T) {
	userHome, managed, plist := managedGitHubAppTestSetup(t)
	t.Setenv("HOME", userHome)
	t.Setenv("ZENCHRON_MANAGED_HOME", managed)
	sourceKey := writeManagedAppTestKey(t, t.TempDir(), 0o600)
	t.Setenv("ZENCHRON_GITHUB_APP_ID", "222222")
	t.Setenv("ZENCHRON_GITHUB_INSTALLATION_ID", "333333")
	t.Setenv("ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH", sourceKey)
	savedKey := writeManagedAppTestKey(t, t.TempDir(), 0o600)
	commandDirectory := t.TempDir()
	commandLog := filepath.Join(t.TempDir(), "launchctl.log")
	t.Setenv("LAUNCHCTL_LOG", commandLog)
	writeLaunchctlStub(t, commandDirectory, "printf '%s\\n' \"$*\" >> \"$LAUNCHCTL_LOG\"\nexit 0\n")
	t.Setenv("PATH", commandDirectory+string(os.PathListSeparator)+"/usr/bin:/bin")
	contents := renderLaunchAgent(filepath.Join(userHome, ".local", "bin", "zenchron-engineering"), userHome,
		filepath.Join(managed, "logs"), map[string]string{
			"PATH": "/usr/bin:/bin", "ZENCHRON_LOCAL_STATUS_TOKEN": "existing",
			"ZENCHRON_GITHUB_APP_ID": "123456", "ZENCHRON_GITHUB_INSTALLATION_ID": "987654",
			"ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH": savedKey,
		})
	if err := os.WriteFile(plist, contents, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := ensureManagedAgent(managed, filepath.Join(userHome, ".local", "bin", "zenchron-engineering")); err != nil {
		t.Fatal(err)
	}
	updated, err := os.ReadFile(plist)
	if err != nil {
		t.Fatal(err)
	}
	environment, err := launchAgentEnvironmentValues(updated)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := environment["ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH"]
	keyInfo, err := os.Stat(keyPath)
	if err != nil || keyInfo.Mode().Perm() != 0o600 {
		t.Fatalf("managed private key mode = %v, %v; want 0600", keyInfo, err)
	}
	if environment["ZENCHRON_GITHUB_APP_ID"] != "123456" || environment["ZENCHRON_GITHUB_INSTALLATION_ID"] != "987654" || keyPath != savedKey {
		t.Fatal("repeated installation replaced saved GitHub App settings with transient shell values")
	}
	if strings.Contains(string(updated), string(mustReadFile(t, keyPath))) {
		t.Fatal("LaunchAgent plist contains private-key contents")
	}
	commands := string(mustReadFile(t, commandLog))
	if strings.Contains(commands, "kill SIGTERM") {
		t.Fatalf("repeated installation restarted the service for transient credentials: %q", commands)
	}
	for _, key := range managedGitHubAppEnvironmentKeys {
		t.Setenv(key, "")
	}
	if err := ensureManagedAgent(managed, filepath.Join(userHome, ".local", "bin", "zenchron-engineering")); err != nil {
		t.Fatalf("repeated install with no shell credentials: %v", err)
	}
	if got := strings.Count(string(mustReadFile(t, commandLog)), "kill SIGTERM"); got != 0 {
		t.Fatalf("idempotent install requested %d restarts, want none", got)
	}
}

func TestLaunchEnvironmentPreservesGitHubAppSettingsOnStoppedReinstall(t *testing.T) {
	userHome, managed, plist := managedGitHubAppTestSetup(t)
	t.Setenv("HOME", userHome)
	t.Setenv("ZENCHRON_MANAGED_HOME", managed)
	t.Setenv("ZENCHRON_GITHUB_APP_ID", "222222")
	t.Setenv("ZENCHRON_GITHUB_INSTALLATION_ID", "333333")
	t.Setenv("ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH", writeManagedAppTestKey(t, t.TempDir(), 0o600))
	legacyKey := writeManagedAppTestKey(t, t.TempDir(), 0o600)
	contents := renderLaunchAgent("entrypoint", userHome, filepath.Join(managed, "logs"), map[string]string{
		"PATH": "/usr/bin:/bin", "ZENCHRON_GITHUB_APP_ID": "123456",
		"ZENCHRON_GITHUB_INSTALLATION_ID": "987654", "ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH": legacyKey,
	})
	if err := os.WriteFile(plist, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	environment, err := launchEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	if environment["ZENCHRON_GITHUB_APP_ID"] != "123456" || environment["ZENCHRON_GITHUB_INSTALLATION_ID"] != "987654" {
		t.Fatal("stopped reinstall replaced saved App identifiers with transient shell values")
	}
	if environment["ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH"] == legacyKey {
		t.Fatal("reinstall continued to depend on the external source key")
	}
	keyInfo, err := os.Stat(environment["ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH"])
	if err != nil || keyInfo.Mode().Perm() != 0o600 {
		t.Fatalf("copied App key mode = %v, %v", keyInfo, err)
	}
}

func TestLaunchAgentGitHubAppEnvironmentRoundTripsEscapedValues(t *testing.T) {
	original := renderLaunchAgent("entrypoint", "home", "logs", map[string]string{
		"PATH": "/bin", "ZENCHRON_GITHUB_APP_ID": "123456",
		"ZENCHRON_GITHUB_INSTALLATION_ID": "987654", "ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH": "/private/a&b.pem",
	})
	updated, err := withLaunchAgentEnvironmentValues(original, map[string]string{"ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH": "/private/c<d>.pem"})
	if err != nil {
		t.Fatal(err)
	}
	values, err := launchAgentEnvironmentValues(updated)
	if err != nil {
		t.Fatal(err)
	}
	if values["ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH"] != "/private/c<d>.pem" || values["PATH"] != "/bin" {
		t.Fatalf("LaunchAgent environment round-trip = %#v", values)
	}
}

func TestSelfUpdateEnvironmentRetainsManagedGitHubAppSettings(t *testing.T) {
	for key, value := range map[string]string{
		"ZENCHRON_GITHUB_APP_ID": "123456", "ZENCHRON_GITHUB_INSTALLATION_ID": "987654",
		"ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH": "/managed/private-key.pem",
	} {
		t.Setenv(key, value)
	}
	updated := withEnvironment(os.Environ(), map[string]string{
		"ZENCHRON_MANAGED_HOME": "/managed/install", "ZENCHRON_MANAGED_REVISION": strings.Repeat("a", 40),
	})
	values := make(map[string]string)
	for _, entry := range updated {
		if key, value, ok := strings.Cut(entry, "="); ok {
			values[key] = value
		}
	}
	if values["ZENCHRON_GITHUB_APP_ID"] != "123456" || values["ZENCHRON_GITHUB_INSTALLATION_ID"] != "987654" ||
		values["ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH"] != "/managed/private-key.pem" {
		unexpected := make([]string, 0, len(managedGitHubAppEnvironmentKeys))
		for key, expected := range map[string]string{
			"ZENCHRON_GITHUB_APP_ID": "123456", "ZENCHRON_GITHUB_INSTALLATION_ID": "987654",
			"ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH": "/managed/private-key.pem",
		} {
			if values[key] != expected {
				unexpected = append(unexpected, key)
			}
		}
		t.Fatalf("self-update environment is missing or changed managed GitHub App settings: %s", strings.Join(unexpected, ", "))
	}
}

func TestCopyManagedGitHubAppKeyRejectsOversizedAndSymlinkedSources(t *testing.T) {
	home := t.TempDir()
	oversized := filepath.Join(t.TempDir(), "oversized.pem")
	if err := os.WriteFile(oversized, bytes.Repeat([]byte("x"), maxGitHubAppPrivateKeySize+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := copyManagedGitHubAppKey(home, oversized); err == nil || !strings.Contains(err.Error(), "size limit") {
		t.Fatalf("oversized source was not rejected by the bounded read: %v", err)
	}

	target := writeManagedAppTestKey(t, t.TempDir(), 0o600)
	link := filepath.Join(t.TempDir(), "linked.pem")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := copyManagedGitHubAppKey(home, link); err == nil {
		t.Fatal("symlinked source key was accepted")
	}
}

func TestPersistManagedGitHubAppConfigurationRepairsAndCreatesLaunchAgent(t *testing.T) {
	for _, test := range []struct {
		name      string
		plistMode string
	}{
		{name: "missing plist", plistMode: "missing"},
		{name: "legacy shutdown timeout", plistMode: "legacy_timeout"},
	} {
		t.Run(test.name, func(t *testing.T) {
			userHome, managed, plist := managedGitHubAppTestSetup(t)
			t.Setenv("HOME", userHome)
			t.Setenv("ZENCHRON_MANAGED_HOME", managed)
			t.Setenv("PATH", "/usr/bin:/bin")
			sourceKey := writeManagedAppTestKey(t, t.TempDir(), 0o600)
			appValues := map[string]string{
				"ZENCHRON_GITHUB_APP_ID": "123456", "ZENCHRON_GITHUB_INSTALLATION_ID": "987654",
				"ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH": sourceKey,
			}
			for key, value := range appValues {
				t.Setenv(key, value)
			}
			managedApp, configured, err := normalizeManagedGitHubAppEnvironment(managed, appValues)
			if err != nil || !configured {
				t.Fatalf("test App settings were not normalized: configured=%t error=%v", configured, err)
			}
			if test.plistMode == "legacy_timeout" {
				legacy := renderLaunchAgent("entrypoint", userHome, filepath.Join(managed, "logs"), managedApp)
				legacy = bytes.Replace(legacy, []byte("<key>ExitTimeOut</key><integer>0</integer>"), nil, 1)
				if err := os.WriteFile(plist, legacy, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			changed, err := persistManagedGitHubAppEnvironment(managed, managedApp)
			if err != nil || !changed {
				t.Fatalf("managed App settings were not persisted: changed=%t error=%v", changed, err)
			}
			contents := mustReadFile(t, plist)
			if !bytes.Contains(contents, []byte("<key>ExitTimeOut</key><integer>0</integer>")) {
				t.Fatal("LaunchAgent was saved without an unbounded graceful shutdown timeout")
			}
			changed, err = persistManagedGitHubAppEnvironment(managed, managedApp)
			if err != nil || changed {
				t.Fatalf("repeated configuration was not idempotent: changed=%t error=%v", changed, err)
			}
		})
	}
}

func TestConfigureGitHubAppParserDoesNotEchoArguments(t *testing.T) {
	secretArgument := "--private-key=/sensitive/local/path.pem"
	previousStderr := os.Stderr
	readEnd, writeEnd, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = writeEnd
	configureErr := configureManagedGitHubApp(t.TempDir(), []string{secretArgument, "--unknown"})
	helpErr := configureManagedGitHubApp(t.TempDir(), []string{"--help"})
	_ = writeEnd.Close()
	os.Stderr = previousStderr
	output, readErr := io.ReadAll(readEnd)
	_ = readEnd.Close()
	if readErr != nil {
		t.Fatal(readErr)
	}
	if configureErr == nil || helpErr != nil || !strings.Contains(string(output), "Usage:") ||
		strings.Contains(configureErr.Error(), secretArgument) || strings.Contains(string(output), secretArgument) {
		t.Fatalf("parser exposed a secret-bearing argument: err=%q output=%q", configureErr, output)
	}
}

func TestManagedUpdaterVerificationClassifiesFailureStates(t *testing.T) {
	configuredAt := time.Now().UTC()
	tests := []struct {
		name  string
		state updater.Status
		want  string
	}{
		{name: "stale status", state: updater.Status{State: "idle", LastAttempt: configuredAt.Add(-time.Second)}, want: "not_verified"},
		{name: "verified", state: updater.Status{State: "idle", LastAttempt: configuredAt}, want: "verified"},
		{name: "updating", state: updater.Status{State: "building", LastAttempt: configuredAt}, want: "verified_update_in_progress"},
		{name: "missing app configuration", state: updater.Status{State: "blocked", LastAttempt: configuredAt,
			BlockReason: "Could not verify trusted main: GitHub authentication is required to verify protected main"}, want: "missing_configuration"},
		{name: "invalid installation", state: updater.Status{State: "blocked", LastAttempt: configuredAt,
			BlockReason: "Could not verify trusted main: GitHub App installation not found: GitHub returned HTTP 404"}, want: "invalid_installation"},
		{name: "repository is unavailable", state: updater.Status{State: "blocked", LastAttempt: configuredAt,
			BlockReason: "Could not read trusted main: GitHub returned HTTP 404"}, want: "updater_verification_failure"},
		{name: "insufficient permissions", state: updater.Status{State: "blocked", LastAttempt: configuredAt,
			BlockReason: "Could not verify trusted main: GitHub returned HTTP 403"}, want: "insufficient_permissions"},
		{name: "trusted main rejected", state: updater.Status{State: "blocked", LastAttempt: configuredAt,
			BlockReason: "Could not verify trusted main: exact commit signature is unverified"}, want: "updater_verification_failure"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := managedUpdaterVerification(test.state, configuredAt); got != test.want {
				t.Fatalf("managed updater verification = %q, want %q", got, test.want)
			}
		})
	}
}

func TestGitHubAppConfigurationFingerprintBindsAppInstallationAndKey(t *testing.T) {
	key := writeManagedAppTestKey(t, t.TempDir(), 0o600)
	base := gitHubAppAuth{appID: "123", installationID: "456", privateKeyPath: key}
	want := base.configurationFingerprint()
	if want == "" || base.configurationFingerprint() != want {
		t.Fatal("GitHub App configuration fingerprint was empty or unstable")
	}
	changedApp := gitHubAppAuth{appID: "789", installationID: base.installationID, privateKeyPath: key}
	changedInstallation := gitHubAppAuth{appID: base.appID, installationID: "101112", privateKeyPath: key}
	if changedApp.configurationFingerprint() == want || changedInstallation.configurationFingerprint() == want {
		t.Fatal("GitHub App configuration fingerprint did not bind both IDs")
	}
}

func TestManagedGitHubAppRuntimeRefreshDecision(t *testing.T) {
	for _, test := range []struct {
		name       string
		diagnostic managedGitHubAppDiagnostic
		want       bool
	}{
		{name: "active exact app config", diagnostic: managedGitHubAppDiagnostic{Authentication: gitHubAuthMethodApp, Updater: "verified"}},
		{name: "stale active app config", diagnostic: managedGitHubAppDiagnostic{Authentication: gitHubAuthMethodApp, Updater: "runtime_configuration_stale"}, want: true},
		{name: "old runtime provider", diagnostic: managedGitHubAppDiagnostic{Authentication: gitHubAuthMethodMissing, Updater: "runtime_unavailable"}, want: true},
		{name: "pat takes precedence", diagnostic: managedGitHubAppDiagnostic{Authentication: gitHubAuthMethodPersonalToken,
			Updater: "personal_token_precedence"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := managedGitHubAppRuntimeNeedsRefresh(test.diagnostic); got != test.want {
				t.Fatalf("runtime refresh decision = %t, want %t", got, test.want)
			}
		})
	}
}

func TestGitHubAppBootstrapUsesSavedSettingsOverShellValues(t *testing.T) {
	userHome, managed, plist := managedGitHubAppTestSetup(t)
	t.Setenv("HOME", userHome)
	t.Setenv("ZENCHRON_MANAGED_HOME", managed)
	for _, key := range managedGitHubAppEnvironmentKeys {
		t.Setenv(key, "")
	}
	t.Setenv("ZENCHRON_GITHUB_APP_ID", "222222")
	t.Setenv("ZENCHRON_GITHUB_INSTALLATION_ID", "333333")
	t.Setenv("ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH", writeManagedAppTestKey(t, t.TempDir(), 0o600))
	commandDirectory := t.TempDir()
	commandLog := filepath.Join(t.TempDir(), "launchctl.log")
	t.Setenv("LAUNCHCTL_LOG", commandLog)
	writeLaunchctlStub(t, commandDirectory, "printf '%s\\n' \"$*\" >> \"$LAUNCHCTL_LOG\"\n[ \"$1\" = bootstrap ] && exit 1\nexit 0\n")
	t.Setenv("PATH", commandDirectory+string(os.PathListSeparator)+"/usr/bin:/bin")
	savedKey := writeManagedAppTestKey(t, t.TempDir(), 0o600)
	contents := renderLaunchAgent("managed-entrypoint", userHome, filepath.Join(managed, "logs"), map[string]string{
		"PATH": "/usr/bin:/bin", "ZENCHRON_GITHUB_APP_ID": "123456",
		"ZENCHRON_GITHUB_INSTALLATION_ID": "987654", "ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH": savedKey,
	})
	if err := os.WriteFile(plist, contents, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := bootstrapManagedGitHubAppLaunchAgent(managed, "managed-entrypoint"); err == nil {
		t.Fatal("a bootstrap conflict was treated as a successful start")
	}
	if _, err := os.Stat(plist); err != nil {
		t.Fatalf("saved LaunchAgent settings were not preserved: %v", err)
	}
	commands := string(mustReadFile(t, commandLog))
	if !strings.Contains(commands, "bootstrap gui/") || strings.Contains(commands, "bootout") {
		t.Fatalf("starting a stopped LaunchAgent unexpectedly unloaded a service: %q", commands)
	}
	environment, err := launchAgentEnvironmentValues(mustReadFile(t, plist))
	if err != nil || environment["ZENCHRON_GITHUB_APP_ID"] != "123456" ||
		environment["ZENCHRON_GITHUB_INSTALLATION_ID"] != "987654" ||
		environment["ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH"] != savedKey {
		t.Fatalf("bootstrap replaced configured App settings with shell values: %#v, %v", environment, err)
	}
}

func TestReloadManagedGitHubAppLaunchAgentUnloadsAndBootstrapsSavedDefinition(t *testing.T) {
	userHome, _, _ := managedGitHubAppTestSetup(t)
	t.Setenv("HOME", userHome)
	commandDirectory := t.TempDir()
	commandLog := filepath.Join(t.TempDir(), "launchctl.log")
	t.Setenv("LAUNCHCTL_LOG", commandLog)
	writeLaunchctlStub(t, commandDirectory, "printf '%s\\n' \"$*\" >> \"$LAUNCHCTL_LOG\"\nexit 0\n")
	t.Setenv("PATH", commandDirectory+string(os.PathListSeparator)+"/usr/bin:/bin")

	if err := reloadManagedGitHubAppLaunchAgent(); err != nil {
		t.Fatal(err)
	}
	commands := strings.Split(strings.TrimSpace(string(mustReadFile(t, commandLog))), "\n")
	if len(commands) != 2 || !strings.HasPrefix(commands[0], "bootout gui/") ||
		!strings.HasPrefix(commands[1], "bootstrap gui/") {
		t.Fatalf("LaunchAgent reload command sequence = %q", commands)
	}
}

func TestManagedGitHubAppStatusDistinguishesMissingKeyAndInstallation(t *testing.T) {
	userHome, managed, plist := managedGitHubAppTestSetup(t)
	t.Setenv("HOME", userHome)
	tests := []struct {
		name        string
		environment map[string]string
		wantConfig  string
		wantKey     string
		wantUpdater string
	}{
		{name: "missing configuration", environment: map[string]string{}, wantConfig: "missing", wantKey: "missing", wantUpdater: "missing_configuration"},
		{name: "unreadable key", environment: map[string]string{
			"ZENCHRON_GITHUB_APP_ID": "123456", "ZENCHRON_GITHUB_INSTALLATION_ID": "987654",
			"ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH": filepath.Join(managed, "missing.pem"),
		}, wantConfig: "present", wantKey: "unreadable", wantUpdater: "not_verified"},
		{name: "invalid installation", environment: map[string]string{
			"ZENCHRON_GITHUB_APP_ID": "123456", "ZENCHRON_GITHUB_INSTALLATION_ID": "987654",
			"ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH": writeManagedAppTestKey(t, t.TempDir(), 0o600),
		}, wantConfig: "present", wantKey: "readable", wantUpdater: "invalid_installation"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			contents := renderLaunchAgent("entrypoint", userHome, filepath.Join(managed, "logs"), test.environment)
			if err := os.WriteFile(plist, contents, 0o600); err != nil {
				t.Fatal(err)
			}
			diagnostic, err := inspectManagedGitHubAppStatus(managed)
			if err != nil {
				t.Fatal(err)
			}
			if diagnostic.Configuration != test.wantConfig || diagnostic.Key != test.wantKey || diagnostic.Updater != test.wantUpdater {
				t.Fatalf("managed GitHub App diagnostic = %#v", diagnostic)
			}
		})
	}
}

func TestGitHubAppDiagnosticDoesNotExposeConfigurationValues(t *testing.T) {
	previous := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = writer
	printGitHubAppDiagnostic(managedGitHubAppDiagnostic{Configuration: "present", Key: "readable", Updater: "verified"})
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	os.Stdout = previous
	var output bytes.Buffer
	if _, err := output.ReadFrom(reader); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "123456") || strings.Contains(output.String(), "987654") || strings.Contains(output.String(), "/") {
		t.Fatalf("GitHub App diagnostic exposed an ID or path: %q", output.String())
	}
}

func managedGitHubAppTestSetup(t *testing.T) (string, string, string) {
	t.Helper()
	userHome := t.TempDir()
	managed := filepath.Join(userHome, "installation")
	if err := os.MkdirAll(managed, 0o700); err != nil {
		t.Fatal(err)
	}
	launchDirectory := filepath.Join(userHome, "Library", "LaunchAgents")
	if err := os.MkdirAll(launchDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	return userHome, managed, filepath.Join(launchDirectory, managedLaunchAgentLabel+".plist")
}

func writeLaunchctlStub(t *testing.T, directory, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(directory, "launchctl"), []byte("#!/bin/sh\n"+body), 0o700); err != nil {
		t.Fatal(err)
	}
}

func writeManagedAppTestKey(t *testing.T, directory string, mode os.FileMode) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "private-key.pem")
	contents := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	if err := os.WriteFile(path, contents, mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return contents
}
