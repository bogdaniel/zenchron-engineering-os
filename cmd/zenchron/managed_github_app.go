package main

import (
	"bytes"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

var managedGitHubAppEnvironmentKeys = []string{
	"ZENCHRON_GITHUB_APP_ID", "ZENCHRON_GITHUB_INSTALLATION_ID", "ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH",
}

type managedGitHubAppError struct {
	message string
	cause   error
}

func (err managedGitHubAppError) Error() string { return err.message }

func (err managedGitHubAppError) Unwrap() error { return err.cause }

func valueFreeGitHubAppError(message string, cause error) error {
	return managedGitHubAppError{message: message, cause: cause}
}

func normalizeManagedGitHubAppEnvironment(home string, environment map[string]string) (map[string]string, bool, error) {
	configured := 0
	for _, key := range managedGitHubAppEnvironmentKeys {
		if strings.TrimSpace(environment[key]) != "" {
			configured++
		}
	}
	if configured == 0 {
		return nil, false, nil
	}
	if configured != len(managedGitHubAppEnvironmentKeys) {
		return nil, false, errors.New("GitHub App setup requires the App ID, installation ID, and private-key file")
	}
	appID := strings.TrimSpace(environment["ZENCHRON_GITHUB_APP_ID"])
	installationID := strings.TrimSpace(environment["ZENCHRON_GITHUB_INSTALLATION_ID"])
	if !validGitHubID(appID) || !validGitHubID(installationID) {
		return nil, false, errors.New("GitHub App ID and installation ID must be positive integers")
	}
	keyPath, err := copyManagedGitHubAppKey(home, environment["ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH"])
	if err != nil {
		return nil, false, err
	}
	return map[string]string{
		"ZENCHRON_GITHUB_APP_ID": appID, "ZENCHRON_GITHUB_INSTALLATION_ID": installationID,
		"ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH": keyPath,
	}, true, nil
}

func copyManagedGitHubAppKey(home, sourcePath string) (string, error) {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return "", valueFreeGitHubAppError("managed GitHub App directory is unavailable", err)
	}
	if err := verifyManagedOAuthDirectory(home); err != nil {
		return "", valueFreeGitHubAppError("managed GitHub App directory is not private", err)
	}
	source, err := os.OpenFile(sourcePath, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", valueFreeGitHubAppError("source GitHub App private key is unavailable", err)
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return "", valueFreeGitHubAppError("source GitHub App private key is unavailable", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || !managedOAuthPathOwnedByCurrentUser(info) {
		return "", errors.New("source GitHub App key must be a private regular file owned by the current user")
	}
	data, err := io.ReadAll(io.LimitReader(source, maxGitHubAppPrivateKeySize+1))
	if err != nil {
		return "", valueFreeGitHubAppError("source GitHub App private key is unreadable", err)
	}
	if len(data) > maxGitHubAppPrivateKeySize {
		return "", errors.New("source GitHub App key exceeds the size limit")
	}
	key, err := parseGitHubAppPrivateKey(data)
	if err != nil {
		return "", err
	}
	fingerprint := publicKeyFingerprint(key)
	path := filepath.Join(home, "github-app-"+fingerprint+".pem")
	if existing, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		if err := writeManagedPrivateFile(home, filepath.Base(path), data); err != nil {
			return "", err
		}
	} else if err != nil {
		return "", valueFreeGitHubAppError("managed GitHub App private key is inaccessible", err)
	} else if !existing.Mode().IsRegular() || existing.Mode().Perm()&0o077 != 0 || !managedOAuthPathOwnedByCurrentUser(existing) {
		return "", errors.New("managed GitHub App key is not a private regular file owned by the current user")
	} else {
		managedKey, err := loadGitHubAppPrivateKey(path)
		if err != nil {
			return "", err
		}
		if publicKeyFingerprint(managedKey) != fingerprint {
			return "", errors.New("managed GitHub App key does not match its content fingerprint")
		}
	}
	return path, nil
}

func publicKeyFingerprint(key *rsa.PrivateKey) string {
	encoded, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return ""
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func writeManagedPrivateFile(directory, name string, contents []byte) (returnErr error) {
	temporary, err := os.CreateTemp(directory, ".github-app-*.tmp")
	if err != nil {
		return valueFreeGitHubAppError("could not create a private GitHub App file", err)
	}
	temporaryPath := temporary.Name()
	defer func() {
		if err := os.Remove(temporaryPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			returnErr = errors.Join(returnErr, valueFreeGitHubAppError("could not remove temporary GitHub App file", err))
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return valueFreeGitHubAppError("could not secure GitHub App file", err)
	}
	if _, err := io.Copy(temporary, bytes.NewReader(contents)); err != nil {
		temporary.Close()
		return valueFreeGitHubAppError("could not write GitHub App file", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return valueFreeGitHubAppError("could not sync GitHub App file", err)
	}
	if err := temporary.Close(); err != nil {
		return valueFreeGitHubAppError("could not close GitHub App file", err)
	}
	if err := os.Rename(temporaryPath, filepath.Join(directory, name)); err != nil {
		return valueFreeGitHubAppError("could not activate GitHub App file", err)
	}
	dir, err := os.Open(directory)
	if err != nil {
		return valueFreeGitHubAppError("could not open managed GitHub App directory", err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return valueFreeGitHubAppError("could not sync managed GitHub App directory", err)
	}
	return nil
}

func launchAgentGitHubAppEnvironment(contents []byte) (map[string]string, error) {
	environment, err := launchAgentEnvironmentValues(contents)
	if err != nil {
		return nil, err
	}
	settings := make(map[string]string, len(managedGitHubAppEnvironmentKeys))
	for _, key := range managedGitHubAppEnvironmentKeys {
		settings[key] = environment[key]
	}
	return settings, nil
}

func sameGitHubAppEnvironment(left, right map[string]string) bool {
	for _, key := range managedGitHubAppEnvironmentKeys {
		if left[key] != right[key] {
			return false
		}
	}
	return true
}

func valueFreeEnvironmentError(err error) error {
	return valueFreeGitHubAppError("managed GitHub App settings could not be applied", err)
}
