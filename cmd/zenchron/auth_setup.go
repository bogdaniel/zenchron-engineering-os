package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"runtime"
	"strings"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
)

const managedOAuthCallback = "http://127.0.0.1:8080/auth/github/callback"

func runAuthCommand(args []string) error {
	if len(args) != 1 || args[0] != "setup" {
		return errors.New("use `zenchron-engineering auth setup` to configure optional local GitHub sign-in")
	}
	if runtime.GOOS != "darwin" {
		return errors.New("GitHub sign-in setup requires the managed macOS installation")
	}
	home, err := managedHome()
	if err != nil {
		return err
	}
	storedConfig, err := readManagedOAuthConfig(home)
	if err != nil {
		return err
	}
	if storedConfig != nil {
		configured, err := managedOAuthAlreadyConfigured(home)
		if err != nil {
			return err
		}
		if configured {
			fmt.Println("GitHub sign-in is already configured; no credentials or files were changed.")
			return nil
		}
		return errors.New("GitHub OAuth credentials are saved but the managed runtime has not confirmed them; " +
			"wait for active work to drain or start the existing managed service if it is stopped, " +
			"then verify /auth/github")
	}
	if configured, err := managedOAuthAlreadyConfigured(home); err != nil {
		return err
	} else if configured {
		fmt.Println("GitHub sign-in is already configured for the running installation; no credentials or files were changed.")
		return nil
	}
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	statusToken := localStatusCredential()
	if err := managedOAuthSetupPreflight(home, statusToken, client); err != nil {
		return err
	}
	terminal, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return errors.New("GitHub sign-in setup requires an interactive terminal; no credentials were read")
	}
	defer terminal.Close()
	activeRunCount := func() (int, error) { return managedOAuthActiveRunCount(statusToken, client) }
	return setupManagedOAuth(home, terminal, terminal, readTerminalSecret,
		func() error { return managedOAuthSetupPreflight(home, statusToken, client) }, activeRunCount,
		restartManagedForOAuth, waitForConfiguredOAuth, waitForLocalWorkspace)
}

func managedOAuthSetupPreflight(home, statusToken string, client *http.Client) error {
	if strings.TrimSpace(statusToken) == "" {
		return errors.New("could not verify active agent runs")
	}
	ready, err := managedControlPlaneReady(client, home)
	if err != nil {
		return fmt.Errorf("could not verify the active managed installation before OAuth setup: %w", err)
	}
	if !ready {
		return errors.New("could not verify the active managed installation and work state")
	}
	active, err := managedOAuthActiveRunCount(statusToken, client)
	if err != nil {
		return fmt.Errorf("could not verify active agent runs: %w", err)
	}
	if active > 0 {
		return fmt.Errorf("OAuth setup is deferred until active work finishes (%d active agent run(s)); "+
			"credentials were not saved and the managed service was not restarted",
			active)
	}
	return nil
}

func managedOAuthActiveRunCount(statusToken string, client *http.Client) (int, error) {
	if strings.TrimSpace(statusToken) == "" {
		return 0, errors.New("local status credential is unavailable")
	}
	request, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/v1/system/status", nil)
	if err != nil {
		return 0, fmt.Errorf("create managed status request: %w", err)
	}
	request.Header.Set("X-Zenchron-Local-Status-Token", statusToken)
	response, err := client.Do(request)
	if err != nil {
		return 0, fmt.Errorf("request managed status: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("managed status returned HTTP %d", response.StatusCode)
	}
	var status struct {
		Work struct {
			ActiveAgentRuns *int `json:"active_agent_runs"`
		} `json:"work"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&status); err != nil ||
		status.Work.ActiveAgentRuns == nil || *status.Work.ActiveAgentRuns < 0 {
		return 0, errors.New("managed status did not include a valid active agent run count")
	}
	return *status.Work.ActiveAgentRuns, nil
}

func setupManagedOAuth(home string, input io.Reader, output io.Writer, readSecret func(io.Writer) (string, error),
	verifyIdle func() error, activeRunCount func() (int, error), restart func() error,
	waitConfigured, waitLocal func(string) error) error {
	if _, err := os.Stat(managedOAuthConfigPath(home)); err == nil {
		return errors.New("GitHub sign-in is already configured; existing credentials were left unchanged")
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect GitHub sign-in configuration: %w", err)
	}
	config, err := collectManagedOAuthConfig(input, output, readSecret)
	if err != nil {
		return err
	}
	if err := verifyIdle(); err != nil {
		return err
	}
	if err := writeManagedOAuthConfig(home, config); err != nil {
		return err
	}
	if err := restart(); err != nil {
		return rollbackManagedOAuthAfterFailure(home, activeRunCount, restart, waitLocal,
			fmt.Errorf("managed GitHub sign-in was not activated: %w", err))
	}
	if err := waitConfigured(home); err != nil {
		return rollbackManagedOAuthAfterFailure(home, activeRunCount, restart, waitLocal,
			fmt.Errorf("managed runtime did not activate GitHub sign-in: %w", err))
	}
	if _, err := fmt.Fprintf(output, "GitHub sign-in is configured for %s. The managed runtime restarted; local workspace data and updater credentials were left unchanged.\n",
		managedOAuthCallback); err != nil {
		return fmt.Errorf("write setup result: %w", err)
	}
	return nil
}

func rollbackManagedOAuthAfterFailure(home string, activeRunCount func() (int, error), restart func() error,
	wait func(string) error, activationErr error) error {
	active, err := activeRunCount()
	if err != nil {
		return errors.Join(activationErr, fmt.Errorf("OAuth config remains at %s because work state could not be verified; "+
			"no second restart was attempted: %w",
			managedOAuthConfigPath(home), err))
	}
	if active < 0 {
		return errors.Join(activationErr, fmt.Errorf("OAuth config remains at %s because work state is invalid; "+
			"no second restart was attempted",
			managedOAuthConfigPath(home)))
	}
	if active > 0 {
		return errors.Join(activationErr, fmt.Errorf("OAuth config remains at %s while the graceful restart drains "+
			"%d active agent run(s); "+
			"do not retry setup, and verify the managed runtime after work completes",
			managedOAuthConfigPath(home), active))
	}
	return errors.Join(activationErr, wrapRollbackError(home, rollbackManagedOAuthConfig(home, restart, wait)))
}

func rollbackManagedOAuthConfig(home string, restart func() error, wait func(string) error) error {
	if err := os.Remove(managedOAuthConfigPath(home)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return errors.Join(restart(), wait(home))
}

func collectManagedOAuthConfig(input io.Reader, output io.Writer, readSecret func(io.Writer) (string, error)) (managedOAuthConfig, error) {
	reader := bufio.NewReader(input)
	if _, err := fmt.Fprintf(output, "Create a GitHub OAuth App with callback URL:\n%s\n", managedOAuthCallback); err != nil {
		return managedOAuthConfig{}, err
	}
	clientID, err := readSetupLine(reader, output, "OAuth App client ID: ")
	if err != nil {
		return managedOAuthConfig{}, err
	}
	if strings.TrimSpace(clientID) == "" {
		return managedOAuthConfig{}, errors.New("OAuth App client ID is required")
	}
	if _, err := io.WriteString(output, "OAuth App client secret (input hidden): "); err != nil {
		return managedOAuthConfig{}, err
	}
	clientSecret, err := readSecret(output)
	if err != nil {
		return managedOAuthConfig{}, err
	}
	if strings.TrimSpace(clientSecret) == "" {
		return managedOAuthConfig{}, errors.New("OAuth App client secret is required")
	}
	allowedUsers, err := readSetupLine(reader, output, "Allowed GitHub username(s), comma separated: ")
	if err != nil {
		return managedOAuthConfig{}, err
	}
	users := strings.FieldsFunc(allowedUsers, func(char rune) bool { return char == ',' || char == '\n' })
	for index, login := range users {
		users[index] = strings.ToLower(strings.TrimSpace(login))
		if !githubLoginPattern.MatchString(users[index]) {
			return managedOAuthConfig{}, fmt.Errorf("invalid GitHub username %q", strings.TrimSpace(login))
		}
	}
	if len(users) == 0 {
		return managedOAuthConfig{}, errors.New("at least one allowed GitHub username is required")
	}
	sessionSecret, err := randomToken(32)
	if err != nil {
		return managedOAuthConfig{}, fmt.Errorf("generate session signing key: %w", err)
	}
	workerToken, err := randomToken(32)
	if err != nil {
		return managedOAuthConfig{}, fmt.Errorf("generate local worker credential: %w", err)
	}
	config := managedOAuthConfig{ClientID: strings.TrimSpace(clientID), ClientSecret: strings.TrimSpace(clientSecret),
		SessionKey: sessionSecret, AllowedUsers: users, WorkerToken: workerToken}
	values := managedOAuthEnvironmentValues(config)
	lookup := func(key string) string { return values[key] }
	if _, configured, err := loadAuthConfigFrom(lookup); err != nil || !configured {
		if err == nil {
			err = errors.New("managed GitHub sign-in configuration is incomplete")
		}
		return managedOAuthConfig{}, fmt.Errorf("validate GitHub sign-in settings; no credentials were saved: %w", err)
	}
	return config, nil
}

func managedOAuthEnvironmentValues(config managedOAuthConfig) map[string]string {
	return map[string]string{
		"ZENCHRON_GITHUB_CLIENT_ID": config.ClientID, "ZENCHRON_GITHUB_CLIENT_SECRET": config.ClientSecret,
		"ZENCHRON_SESSION_SECRET": config.SessionKey, "ZENCHRON_GITHUB_ALLOWED_USERS": strings.Join(config.AllowedUsers, ","),
		"ZENCHRON_PUBLIC_URL": "http://127.0.0.1:8080", "ZENCHRON_WORKER_TOKEN": config.WorkerToken,
	}
}

func readSetupLine(reader *bufio.Reader, output io.Writer, prompt string) (string, error) {
	if _, err := io.WriteString(output, prompt); err != nil {
		return "", err
	}
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("read setup input: %w", err)
	}
	return strings.TrimSpace(line), nil
}

func readTerminalSecret(output io.Writer) (string, error) {
	terminal, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return "", errors.New("OAuth client secret must be entered at a terminal; it was not read or saved")
	}
	defer terminal.Close()
	stateCommand := exec.Command("stty", "-g")
	stateCommand.Stdin = terminal
	state, err := stateCommand.Output()
	if err != nil {
		return "", errors.New("could not secure terminal input; no credentials were read")
	}
	stateCommand = exec.Command("stty", "-echo")
	stateCommand.Stdin, stateCommand.Stdout, stateCommand.Stderr = terminal, io.Discard, io.Discard
	if err := stateCommand.Run(); err != nil {
		return "", errors.New("could not disable terminal echo; no credentials were read")
	}
	secret, err := bufio.NewReader(terminal).ReadString('\n')
	restore := exec.Command("stty", strings.TrimSpace(string(state)))
	restore.Stdin, restore.Stdout, restore.Stderr = terminal, io.Discard, io.Discard
	if restoreErr := restore.Run(); restoreErr != nil {
		return "", fmt.Errorf("restore terminal echo after reading OAuth client secret: %w", restoreErr)
	}
	if _, writeErr := io.WriteString(output, "\n"); writeErr != nil {
		return "", fmt.Errorf("finish OAuth client secret prompt: %w", writeErr)
	}
	if err != nil {
		return "", fmt.Errorf("read OAuth client secret: %w", err)
	}
	return strings.TrimSpace(secret), nil
}

func managedOAuthAlreadyConfigured(home string) (bool, error) {
	client := &http.Client{Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	ready, err := managedControlPlaneReady(client, home)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	if !ready {
		return false, nil
	}
	response, err := client.Get("http://127.0.0.1:8080/api/v1/auth/session")
	if err != nil {
		return false, fmt.Errorf("check current managed sign-in state: %w", err)
	}
	defer response.Body.Close()
	return managedOAuthSessionIsConfigured(response.StatusCode, response.Body)
}

func managedOAuthSessionIsConfigured(status int, body io.Reader) (bool, error) {
	if status == http.StatusUnauthorized {
		return true, nil
	}
	if status != http.StatusOK {
		return false, fmt.Errorf("could not inspect current local sign-in state: HTTP %d", status)
	}
	var session struct {
		Authenticated bool `json:"authenticated"`
		Local         bool `json:"local"`
	}
	if err := json.NewDecoder(io.LimitReader(body, 4096)).Decode(&session); err != nil || !session.Authenticated {
		return false, errors.New("port 8080 did not report an authenticated managed sign-in session")
	}
	return !session.Local, nil
}

func restartManagedForOAuth() error {
	current, err := user.Current()
	if err != nil {
		return fmt.Errorf("resolve current user for managed restart: %w", err)
	}
	domain := "gui/" + current.Uid
	if _, err := exec.Command("launchctl", "print", domain+"/"+managedLaunchAgentLabel).CombinedOutput(); err != nil {
		return errors.New("the managed LaunchAgent is not loaded; no restart was attempted")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// SIGTERM enters the supervisor's existing quiesce-and-drain shutdown path.
	command := exec.CommandContext(ctx, "launchctl", "kill", "SIGTERM", domain+"/"+managedLaunchAgentLabel)
	if _, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("request a graceful restart of the existing managed LaunchAgent: %w", err)
	}
	return nil
}

func waitForConfiguredOAuth(home string) error {
	return waitForOAuthSessionStatus(home, http.StatusUnauthorized)
}

func waitForLocalWorkspace(home string) error { return waitForOAuthSessionStatus(home, http.StatusOK) }

func waitForOAuthSessionStatus(home string, want int) error {
	ctx, cancel := context.WithTimeout(context.Background(), updateHealthTimeout)
	defer cancel()
	client := &http.Client{Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for {
		ready, err := managedControlPlaneReady(client, home)
		if err == nil && ready {
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:8080/api/v1/auth/session", nil)
			if err != nil {
				return err
			}
			response, err := client.Do(request)
			if err == nil {
				status := response.StatusCode
				response.Body.Close()
				if status == want {
					return nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("authentication endpoint did not return HTTP %d", want)
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func managedControlPlaneReady(client *http.Client, home string) (bool, error) {
	expectedRevision, err := updater.ActiveRelease(home)
	if err != nil {
		return false, fmt.Errorf("read managed active revision: %w", err)
	}
	response, err := client.Get("http://127.0.0.1:8080/healthz")
	if err != nil {
		return false, nil
	}
	defer response.Body.Close()
	var health struct {
		Status   string `json:"status"`
		Revision string `json:"revision"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&health); err != nil {
		return false, fmt.Errorf("decode managed control-plane health response: %w", err)
	}
	if response.StatusCode != http.StatusOK || health.Status != "ok" || health.Revision != expectedRevision {
		return false, fmt.Errorf("port 8080 is not serving the active managed Zenchron release")
	}
	return true, nil
}

func wrapRollbackError(home string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("rollback incomplete; inspect %s and the managed LaunchAgent state: %w", managedOAuthConfigPath(home), err)
}
