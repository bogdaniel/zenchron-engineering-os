package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestGitHubAppAuthenticationMintsAndCachesInstallationToken(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(t.TempDir(), "github-app.pem")
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(privateKey)})
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	var tokenRequests int
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations/456/access_tokens" {
			tokenRequests++
			if r.Method != http.MethodPost || r.Header.Get("Authorization") == "" {
				t.Errorf("installation-token request = %s, authorization %q", r.Method, r.Header.Get("Authorization"))
			}
			if err := verifyGitHubAppJWT(r.Header.Get("Authorization"), privateKey, "123"); err != nil {
				t.Error(err)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"token":"ghs-installation-test","expires_at":"` +
				time.Now().Add(time.Hour).UTC().Format(time.RFC3339) + `"}`))
			return
		}
		if r.Header.Get("Authorization") != "Bearer ghs-installation-test" {
			t.Errorf("resource request authorization = %q", r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer provider.Close()

	t.Setenv("ZENCHRON_GITHUB_TOKEN", "")
	t.Setenv("ZENCHRON_GITHUB_APP_ID", "123")
	t.Setenv("ZENCHRON_GITHUB_INSTALLATION_ID", "456")
	t.Setenv("ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH", keyPath)
	client := newGitHubClient()
	client.apiURL = provider.URL
	var requests sync.WaitGroup
	requestErrors := make(chan error, 8)
	for range 8 {
		requests.Add(1)
		go func() {
			defer requests.Done()
			_, err := client.requestBytes(context.Background(), http.MethodGet, "/repos/acme/platform", "application/vnd.github+json", nil, nil)
			requestErrors <- err
		}()
	}
	requests.Wait()
	close(requestErrors)
	for err := range requestErrors {
		if err != nil {
			t.Fatal(err)
		}
	}
	if tokenRequests != 1 {
		t.Fatalf("installation-token requests = %d, want cached single request", tokenRequests)
	}
	client.appAuth.expiresAt = time.Now().Add(-time.Second)
	if _, err := client.requestBytes(context.Background(), http.MethodGet, "/repos/acme/platform", "application/vnd.github+json", nil, nil); err != nil {
		t.Fatal(err)
	}
	if tokenRequests != 2 {
		t.Fatalf("installation-token requests after expiry = %d, want refresh", tokenRequests)
	}
}

func TestGitHubAppAuthenticationRejectsIncompleteOrInvalidConfiguration(t *testing.T) {
	t.Setenv("ZENCHRON_GITHUB_TOKEN", "")
	t.Setenv("ZENCHRON_GITHUB_APP_ID", "123")
	t.Setenv("ZENCHRON_GITHUB_INSTALLATION_ID", "")
	t.Setenv("ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH", "")
	client := newGitHubClient()
	if client.authConfigured() {
		t.Fatal("partial app configuration unexpectedly enabled write actions")
	}
	if _, err := client.requestBytes(context.Background(), http.MethodGet, "/repos/acme/platform", "application/vnd.github+json", nil, nil); err == nil ||
		!strings.Contains(err.Error(), "needs app ID, installation ID, and private-key path") {
		t.Fatalf("request with partial app config error = %v", err)
	}
	if validGitHubID("0") || validGitHubID("1/path") || !validGitHubID("456") {
		t.Fatal("GitHub numeric ID validation is incorrect")
	}
}

func TestGitHubPersonalTokenTakesPrecedenceOverAppConfiguration(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer personal-token" {
			t.Errorf("GitHub authorization = %q, want personal-token fallback", r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer provider.Close()
	t.Setenv("ZENCHRON_GITHUB_TOKEN", "personal-token")
	t.Setenv("ZENCHRON_GITHUB_APP_ID", "123")
	t.Setenv("ZENCHRON_GITHUB_INSTALLATION_ID", "456")
	t.Setenv("ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH", filepath.Join(t.TempDir(), "missing.pem"))
	client := newGitHubClient()
	client.apiURL = provider.URL
	if _, err := client.requestBytes(context.Background(), http.MethodGet, "/repos/acme/platform", "application/vnd.github+json", nil, nil); err != nil {
		t.Fatal(err)
	}
}

func TestGitHubAppPrivateKeyRejectsSharedPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows ACLs are not represented by Go file mode bits")
	}
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "shared.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{
		Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(privateKey),
	}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadGitHubAppPrivateKey(path); err == nil || !strings.Contains(err.Error(), "group or other users") {
		t.Fatalf("shared private key error = %v", err)
	}
}

func verifyGitHubAppJWT(header string, key *rsa.PrivateKey, appID string) error {
	if !strings.HasPrefix(header, "Bearer ") {
		return errors.New("GitHub installation-token request did not use a bearer JWT")
	}
	parts := strings.Split(strings.TrimPrefix(header, "Bearer "), ".")
	if len(parts) != 3 {
		return errors.New("GitHub App JWT must have three components")
	}
	decode := base64.RawURLEncoding.DecodeString
	var jwtHeader struct {
		Algorithm string `json:"alg"`
	}
	encodedHeader, err := decode(parts[0])
	if err != nil || json.Unmarshal(encodedHeader, &jwtHeader) != nil || jwtHeader.Algorithm != "RS256" {
		return errors.New("GitHub App JWT header or issuer is invalid")
	}
	var claims struct {
		IssuedAt int64  `json:"iat"`
		Expires  int64  `json:"exp"`
		Issuer   string `json:"iss"`
	}
	encodedClaims, err := decode(parts[1])
	if err != nil || json.Unmarshal(encodedClaims, &claims) != nil || claims.Issuer != appID {
		return errors.New("GitHub App JWT claims are invalid")
	}
	now := time.Now().Unix()
	if claims.IssuedAt > now || claims.Expires <= now || claims.Expires-now > 10*60 {
		return os.ErrInvalid
	}
	signature, err := decode(parts[2])
	if err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	return rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], signature)
}
