package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const managedOAuthConfigFile = "github-oauth.json"

type managedOAuthConfig struct {
	ClientID     string   `json:"client_id"`
	ClientSecret string   `json:"client_secret"`
	SessionKey   string   `json:"session_secret"`
	AllowedUsers []string `json:"allowed_users"`
	WorkerToken  string   `json:"worker_token"`
}

func managedOAuthConfigPath(home string) string {
	return filepath.Join(home, managedOAuthConfigFile)
}

func verifyManagedOAuthDirectory(home string) error {
	info, err := os.Lstat(home)
	if err != nil {
		return fmt.Errorf("inspect managed installation directory: %w", err)
	}
	if !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return errors.New("managed installation directory must be a private real directory")
	}
	return nil
}

func readManagedOAuthConfig(home string) (*managedOAuthConfig, error) {
	if err := verifyManagedOAuthDirectory(home); err != nil {
		return nil, err
	}
	path := managedOAuthConfigPath(home)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("inspect managed GitHub sign-in configuration: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("managed GitHub sign-in configuration must be a private regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open managed GitHub sign-in configuration: %w", err)
	}
	defer file.Close()
	var config managedOAuthConfig
	decoder := json.NewDecoder(io.LimitReader(file, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return nil, fmt.Errorf("decode managed GitHub sign-in configuration: %w", err)
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return nil, errors.New("managed GitHub sign-in configuration must contain one JSON value")
	}
	return &config, nil
}

func writeManagedOAuthConfig(home string, config managedOAuthConfig) (returnErr error) {
	if err := verifyManagedOAuthDirectory(home); err != nil {
		return fmt.Errorf("save GitHub credentials: %w", err)
	}
	data, err := json.Marshal(config)
	if err != nil {
		return fmt.Errorf("encode managed GitHub sign-in configuration: %w", err)
	}
	temporary, err := os.CreateTemp(home, ".github-oauth-*.tmp")
	if err != nil {
		return fmt.Errorf("create private GitHub sign-in configuration: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() {
		if err := os.Remove(temporaryPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			returnErr = errors.Join(returnErr, fmt.Errorf("remove temporary OAuth config file %s: %w", temporaryPath, err))
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("secure GitHub sign-in configuration: %w", err)
	}
	if _, err := io.Copy(temporary, bytes.NewReader(data)); err != nil {
		temporary.Close()
		return fmt.Errorf("write GitHub sign-in configuration: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync GitHub sign-in configuration: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close GitHub sign-in configuration: %w", err)
	}
	path := managedOAuthConfigPath(home)
	if err := os.Link(temporaryPath, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return errors.New("GitHub sign-in is already configured; existing credentials were left unchanged")
		}
		return fmt.Errorf("activate GitHub sign-in configuration: %w", err)
	}
	if err := os.Remove(temporaryPath); err != nil {
		rollbackErr := os.Remove(path)
		return errors.Join(fmt.Errorf("remove temporary OAuth config file %s: %w", temporaryPath, err),
			wrapRollbackError(home, rollbackErr))
	}
	directory, err := os.Open(home)
	if err != nil {
		removeErr := os.Remove(path)
		return errors.Join(fmt.Errorf("open managed installation directory for sync: %w", err),
			wrapRollbackError(home, removeErr))
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		removeErr := os.Remove(path)
		return errors.Join(fmt.Errorf("sync managed GitHub sign-in configuration: %w", err),
			wrapRollbackError(home, removeErr))
	}
	return nil
}

func managedOAuthEnvironment(home string, environment []string) ([]string, error) {
	config, err := readManagedOAuthConfig(home)
	if err != nil || config == nil {
		return environment, err
	}
	for _, key := range []string{"ZENCHRON_GITHUB_CLIENT_ID", "ZENCHRON_GITHUB_CLIENT_SECRET", "ZENCHRON_SESSION_SECRET",
		"ZENCHRON_GITHUB_ALLOWED_USERS", "ZENCHRON_PUBLIC_URL"} {
		if environmentHas(environment, key) {
			return environment, nil
		}
	}
	values := managedOAuthEnvironmentValues(*config)
	for key := range values {
		if environmentHas(environment, key) {
			delete(values, key)
		}
	}
	if strings.TrimSpace(environmentValue(environment, "ZENCHRON_ACCESS_FILE")) != "" &&
		!environmentHas(environment, "ZENCHRON_WORKER_TOKEN") {
		return nil, errors.New("managed GitHub sign-in cannot restart an access-file installation without its existing enrolled worker token")
	}
	merged := withEnvironment(environment, values)
	lookup := func(key string) string {
		prefix := key + "="
		for _, item := range merged {
			if strings.HasPrefix(item, prefix) {
				return strings.TrimPrefix(item, prefix)
			}
		}
		return ""
	}
	if _, configured, err := loadAuthConfigFrom(lookup); err != nil || !configured {
		if err == nil {
			err = errors.New("managed GitHub sign-in configuration is incomplete")
		}
		return nil, fmt.Errorf("validate managed GitHub sign-in configuration: %w", err)
	}
	return merged, nil
}

func environmentHas(environment []string, key string) bool {
	for _, item := range environment {
		if strings.HasPrefix(item, key+"=") {
			return true
		}
	}
	return false
}

func environmentValue(environment []string, key string) string {
	for _, item := range environment {
		if value, ok := strings.CutPrefix(item, key+"="); ok {
			return value
		}
	}
	return ""
}
