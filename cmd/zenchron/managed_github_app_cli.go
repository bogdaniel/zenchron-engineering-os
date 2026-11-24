package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
)

const gitHubAppVerificationTimeout = 30 * time.Second

type managedGitHubAppDiagnostic struct {
	Configuration  string
	Key            string
	Authentication string
	Updater        string
}

func runManagedGitHubAppCommand(args []string) error {
	if len(args) == 0 {
		return errors.New("use `zenchron-engineering auth github-app configure` or `status`")
	}
	if runtime.GOOS != "darwin" {
		return errors.New("GitHub App setup requires the managed macOS installation")
	}
	home, err := managedHome()
	if err != nil {
		return err
	}
	switch args[0] {
	case "configure":
		return configureManagedGitHubApp(home, args[1:])
	case "status":
		if len(args) != 1 {
			return errors.New("use `zenchron-engineering auth github-app status`")
		}
		return printManagedGitHubAppStatus(home)
	default:
		return errors.New("use `zenchron-engineering auth github-app configure` or `status`")
	}
}

func configureManagedGitHubApp(home string, args []string) error {
	flags := flag.NewFlagSet("auth github-app configure", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	appID := flags.String("app-id", "", "GitHub App ID")
	installationID := flags.String("installation-id", "", "GitHub App installation ID")
	privateKey := flags.String("private-key", "", "local GitHub App PEM file")
	if err := flags.Parse(args); err != nil {
		return errors.New("GitHub App configuration arguments are invalid")
	}
	if flags.NArg() != 0 || strings.TrimSpace(*appID) == "" || strings.TrimSpace(*installationID) == "" ||
		strings.TrimSpace(*privateKey) == "" {
		return errors.New("usage: zenchron-engineering auth github-app configure --app-id ID --installation-id ID --private-key FILE")
	}
	if _, err := updater.ActiveRelease(home); err != nil {
		return errors.New("configure GitHub App access from the existing managed installation")
	}
	loaded, err := managedLaunchAgentLoaded()
	if err != nil {
		return err
	}
	if loaded {
		if err := managedGitHubAppSetupPreflight(home); err != nil {
			return err
		}
	}
	appEnvironment, configured, err := normalizeManagedGitHubAppEnvironment(home, map[string]string{
		"ZENCHRON_GITHUB_APP_ID": *appID, "ZENCHRON_GITHUB_INSTALLATION_ID": *installationID,
		"ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH": *privateKey,
	})
	if err != nil || !configured {
		return errors.New("GitHub App settings could not be validated; no managed configuration was changed")
	}
	configuredAt := time.Now().UTC()
	changed, err := persistManagedGitHubAppEnvironment(home, appEnvironment)
	if err != nil {
		return errors.New("GitHub App settings could not be saved; existing managed configuration was preserved")
	}
	if !changed {
		diagnostic, err := inspectManagedGitHubAppStatus(home)
		printGitHubAppDiagnostic(diagnostic)
		if err != nil {
			return err
		}
		if diagnostic.Authentication == gitHubAuthMethodPersonalToken {
			return errors.New("managed updater uses a personal access token; GitHub App verification is not established")
		}
		if managedGitHubAppRuntimeNeedsRefresh(diagnostic) {
			verificationRequestedAt := time.Now().UTC()
			if loaded {
				if err := managedGitHubAppSetupPreflight(home); err != nil {
					return err
				}
				if err := restartManagedSupervisor(); err != nil {
					return errors.New("saved GitHub App settings are not active; the supervisor did not accept a graceful restart request")
				}
			} else {
				entrypoint, err := installStableEntrypoint(home)
				if err != nil {
					return errors.New("saved GitHub App settings could not be activated")
				}
				if err := bootstrapManagedGitHubAppLaunchAgent(home, entrypoint); err != nil {
					return errors.New("saved GitHub App settings could not be activated")
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), gitHubAppVerificationTimeout)
			defer cancel()
			diagnostic, err = waitForManagedGitHubAppVerification(ctx, home, verificationRequestedAt)
			printGitHubAppDiagnostic(diagnostic)
			return err
		}
		if diagnostic.Updater != "verified" && diagnostic.Updater != "verified_update_in_progress" {
			return fmt.Errorf("existing managed GitHub App settings are unchanged; verification is %s", diagnostic.Updater)
		}
		return nil
	}
	if loaded {
		if err := restartManagedSupervisor(); err != nil {
			return errors.New("GitHub App settings were saved; the existing supervisor did not accept a graceful restart request")
		}
	} else {
		entrypoint, err := installStableEntrypoint(home)
		if err != nil {
			return errors.New("GitHub App settings were saved; the existing managed service could not be started")
		}
		if err := bootstrapManagedGitHubAppLaunchAgent(home, entrypoint); err != nil {
			return errors.New("GitHub App settings were saved; the existing managed service could not be started")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), gitHubAppVerificationTimeout)
	defer cancel()
	diagnostic, err := waitForManagedGitHubAppVerification(ctx, home, configuredAt)
	printGitHubAppDiagnostic(diagnostic)
	if err != nil {
		return err
	}
	return nil
}

func bootstrapManagedGitHubAppLaunchAgent(home, entrypoint string) error {
	userHome, err := os.UserHomeDir()
	if err != nil {
		return errors.New("could not resolve the managed LaunchAgent owner")
	}
	launchDirectory := filepath.Join(userHome, "Library", "LaunchAgents")
	logDirectory := filepath.Join(home, "logs")
	if err := os.MkdirAll(launchDirectory, 0o700); err != nil {
		return errors.New("could not prepare the existing managed LaunchAgent")
	}
	if err := os.MkdirAll(logDirectory, 0o700); err != nil {
		return errors.New("could not prepare the existing managed LaunchAgent")
	}
	environment, err := launchEnvironment()
	if err != nil {
		return err
	}
	plist := filepath.Join(launchDirectory, managedLaunchAgentLabel+".plist")
	if err := writeInstallFile(plist, renderLaunchAgent(entrypoint, userHome, logDirectory, environment), 0o600); err != nil {
		return errors.New("could not save the existing managed LaunchAgent settings")
	}
	current, err := user.Current()
	if err != nil {
		return errors.New("could not identify the managed LaunchAgent owner")
	}
	domain := "gui/" + current.Uid
	if _, err := exec.Command("launchctl", "bootstrap", domain, plist).CombinedOutput(); err != nil {
		return errors.New("could not start the managed LaunchAgent without stopping an already loaded service")
	}
	return nil
}

func managedLaunchAgentLoaded() (bool, error) {
	current, err := user.Current()
	if err != nil {
		return false, errors.New("could not identify the managed installation owner")
	}
	domain := "gui/" + current.Uid + "/" + managedLaunchAgentLabel
	_, err = exec.Command("launchctl", "print", domain).CombinedOutput()
	return err == nil, nil
}

func persistManagedGitHubAppEnvironment(home string, appEnvironment map[string]string) (bool, error) {
	plist, err := managedLaunchAgentPlistPath()
	if err != nil {
		return false, valueFreeGitHubAppError("managed LaunchAgent is unavailable", err)
	}
	contents, err := os.ReadFile(plist)
	if errors.Is(err, os.ErrNotExist) {
		userHome, homeErr := os.UserHomeDir()
		if homeErr != nil {
			return false, valueFreeGitHubAppError("managed LaunchAgent is unavailable", homeErr)
		}
		entrypoint, entryErr := installStableEntrypoint(home)
		if entryErr != nil {
			return false, valueFreeGitHubAppError("managed LaunchAgent is unavailable", entryErr)
		}
		logDir := filepath.Join(home, "logs")
		if err := os.MkdirAll(logDir, 0o700); err != nil {
			return false, valueFreeGitHubAppError("managed LaunchAgent is unavailable", err)
		}
		environment, envErr := launchEnvironment()
		if envErr != nil {
			return false, envErr
		}
		contents = renderLaunchAgent(entrypoint, userHome, logDir, environment)
	} else if err != nil {
		return false, valueFreeGitHubAppError("managed LaunchAgent is unavailable", err)
	}
	existing, err := launchAgentGitHubAppEnvironment(contents)
	if err != nil {
		return false, valueFreeGitHubAppError("managed LaunchAgent settings are invalid", err)
	}
	if sameGitHubAppEnvironment(existing, appEnvironment) {
		return false, nil
	}
	contents, err = withLaunchAgentEnvironmentValues(contents, appEnvironment)
	if err != nil {
		return false, valueFreeGitHubAppError("managed LaunchAgent settings could not be updated", err)
	}
	if err := writeInstallFile(plist, contents, 0o600); err != nil {
		return false, valueFreeGitHubAppError("managed LaunchAgent settings could not be saved", err)
	}
	return true, nil
}

func managedGitHubAppSetupPreflight(home string) error {
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	statusToken := localStatusCredential()
	if strings.TrimSpace(statusToken) == "" {
		return errors.New("GitHub App settings were not changed because managed work status could not be verified")
	}
	ready, err := managedControlPlaneReady(client, home)
	if err != nil || !ready {
		return errors.New("GitHub App settings were not changed because the canonical managed service could not be verified")
	}
	activeRuns, err := managedOAuthActiveRunCount(statusToken, client)
	if err != nil {
		return errors.New("GitHub App settings were not changed because active work could not be verified")
	}
	if activeRuns > 0 {
		return fmt.Errorf("GitHub App settings were not changed; configure again after %d active agent run(s) finish", activeRuns)
	}
	return nil
}

func printManagedGitHubAppStatus(home string) error {
	diagnostic, err := inspectManagedGitHubAppStatus(home)
	printGitHubAppDiagnostic(diagnostic)
	return err
}

func printGitHubAppDiagnostic(diagnostic managedGitHubAppDiagnostic) {
	fmt.Printf("GitHub App configuration: %s\nPrivate key: %s\nManaged runtime authentication: %s\nManaged updater verification: %s\n",
		diagnostic.Configuration, diagnostic.Key, diagnostic.Authentication, diagnostic.Updater)
}

func managedGitHubAppRuntimeNeedsRefresh(diagnostic managedGitHubAppDiagnostic) bool {
	if diagnostic.Authentication == gitHubAuthMethodPersonalToken {
		return false
	}
	return diagnostic.Authentication != gitHubAuthMethodApp || diagnostic.Updater == "not_verified" ||
		diagnostic.Updater == "runtime_unavailable" || diagnostic.Updater == "runtime_configuration_stale"
}

func inspectManagedGitHubAppStatus(home string) (managedGitHubAppDiagnostic, error) {
	diagnostic := managedGitHubAppDiagnostic{Configuration: "missing", Key: "missing", Authentication: gitHubAuthMethodMissing,
		Updater: "not_verified"}
	plist, err := managedLaunchAgentPlistPath()
	if err != nil {
		diagnostic.Configuration = "invalid"
		return diagnostic, nil
	}
	contents, err := os.ReadFile(plist)
	if errors.Is(err, os.ErrNotExist) {
		diagnostic.Updater = "missing_configuration"
		return diagnostic, nil
	}
	if err != nil {
		diagnostic.Configuration = "invalid"
		return diagnostic, nil
	}
	settings, err := launchAgentGitHubAppEnvironment(contents)
	if err != nil {
		diagnostic.Configuration = "invalid"
		return diagnostic, nil
	}
	configured := 0
	for _, key := range managedGitHubAppEnvironmentKeys {
		if strings.TrimSpace(settings[key]) != "" {
			configured++
		}
	}
	if configured == 0 {
		diagnostic.Updater = "missing_configuration"
		return diagnostic, nil
	}
	if configured != len(managedGitHubAppEnvironmentKeys) || !validGitHubID(settings["ZENCHRON_GITHUB_APP_ID"]) ||
		!validGitHubID(settings["ZENCHRON_GITHUB_INSTALLATION_ID"]) {
		diagnostic.Configuration, diagnostic.Key = "invalid", "unreadable"
		return diagnostic, nil
	}
	diagnostic.Configuration = "present"
	keyInfo, err := os.Stat(settings["ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH"])
	if err != nil {
		diagnostic.Key = "unreadable"
		return diagnostic, nil
	}
	if !keyInfo.Mode().IsRegular() || keyInfo.Mode().Perm()&0o077 != 0 || !managedOAuthPathOwnedByCurrentUser(keyInfo) {
		diagnostic.Key = "unreadable"
		return diagnostic, nil
	}
	if _, err := loadGitHubAppPrivateKey(settings["ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH"]); err != nil {
		diagnostic.Key = "unreadable"
		return diagnostic, nil
	}
	diagnostic.Key = "readable"
	if _, err := updater.ActiveRelease(home); err != nil {
		diagnostic.Updater = "invalid_installation"
		return diagnostic, nil
	}
	plistInfo, err := os.Stat(plist)
	if err != nil {
		diagnostic.Configuration = "invalid"
		return diagnostic, nil
	}
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	ready, err := managedControlPlaneReady(client, home)
	if err != nil || !ready {
		diagnostic.Updater = "runtime_unavailable"
		return diagnostic, nil
	}
	status, authenticationMethod, runtimeFingerprint, err := readManagedUpdaterStatus(client)
	if err != nil {
		diagnostic.Updater = "runtime_unavailable"
		return diagnostic, nil
	}
	diagnostic.Authentication = authenticationMethod
	if authenticationMethod == gitHubAuthMethodPersonalToken {
		diagnostic.Updater = "personal_token_precedence"
		return diagnostic, nil
	}
	expectedFingerprint := (&gitHubAppAuth{appID: settings["ZENCHRON_GITHUB_APP_ID"],
		installationID: settings["ZENCHRON_GITHUB_INSTALLATION_ID"],
		privateKeyPath: settings["ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH"]}).configurationFingerprint()
	if authenticationMethod != gitHubAuthMethodApp || expectedFingerprint == "" || runtimeFingerprint != expectedFingerprint {
		diagnostic.Updater = "runtime_configuration_stale"
		return diagnostic, nil
	}
	diagnostic.Updater = managedUpdaterVerification(status, plistInfo.ModTime())
	return diagnostic, nil
}

func readManagedUpdaterStatus(client *http.Client) (updater.Status, string, string, error) {
	request, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/v1/system/update", nil)
	if err != nil {
		return updater.Status{}, "", "", err
	}
	request.Header.Set(localStatusCredentialHeader, localStatusCredential())
	response, err := doLocalStatusRequest(client, request)
	if err != nil {
		return updater.Status{}, "", "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return updater.Status{}, "", "", errors.New("managed updater status is unavailable")
	}
	var status struct {
		updater.Status
		AuthenticationMethod string `json:"authentication_method"`
		AppConfigFingerprint string `json:"app_config_fingerprint"`
	}
	err = json.NewDecoder(response.Body).Decode(&status)
	return status.Status, status.AuthenticationMethod, status.AppConfigFingerprint, err
}

func managedUpdaterVerification(status updater.Status, configuredAt time.Time) string {
	if status.LastAttempt.IsZero() || status.LastAttempt.Before(configuredAt) {
		return "not_verified"
	}
	if status.State == "idle" {
		return "verified"
	}
	if status.State == "building" || status.State == "verifying" || status.State == "waiting_for_runs" || status.State == "activating" {
		return "verified_update_in_progress"
	}
	if status.State != "blocked" && status.State != "failed" {
		return "not_verified"
	}
	reason := strings.ToLower(status.BlockReason)
	switch {
	case strings.Contains(reason, "authentication is required"), strings.Contains(reason, "app authentication needs"):
		return "missing_configuration"
	case strings.Contains(reason, "installation not found"):
		return "invalid_installation"
	case strings.Contains(reason, "http 403"), strings.Contains(reason, "grant the github app"),
		strings.Contains(reason, "resource not accessible by integration"):
		return "insufficient_permissions"
	default:
		return "updater_verification_failure"
	}
}

func waitForManagedGitHubAppVerification(ctx context.Context, home string, configuredAt time.Time) (managedGitHubAppDiagnostic, error) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		diagnostic, err := inspectManagedGitHubAppStatus(home)
		if err != nil {
			return diagnostic, err
		}
		if diagnostic.Updater != "not_verified" && diagnostic.Updater != "runtime_unavailable" &&
			diagnostic.Updater != "runtime_configuration_stale" {
			if diagnostic.Updater == "verified" || diagnostic.Updater == "verified_update_in_progress" {
				return diagnostic, nil
			}
			return diagnostic, fmt.Errorf("managed GitHub App verification reported %s", diagnostic.Updater)
		}
		select {
		case <-ctx.Done():
			diagnostic.Updater = "not_verified"
			return diagnostic, errors.New("managed GitHub App verification did not complete before the diagnostic timeout")
		case <-ticker.C:
		}
	}
}
