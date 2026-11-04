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
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxGitHubAppPrivateKeySize = 64 << 10

type gitHubAppAuth struct {
	// shortcut: one installation per control plane; select an installation per repository for multi-org support.
	appID          string
	installationID string
	privateKeyPath string

	mu         sync.Mutex
	privateKey *rsa.PrivateKey
	token      string
	expiresAt  time.Time
}

func newGitHubAppAuthFromEnv() *gitHubAppAuth {
	appID := strings.TrimSpace(os.Getenv("ZENCHRON_GITHUB_APP_ID"))
	installationID := strings.TrimSpace(os.Getenv("ZENCHRON_GITHUB_INSTALLATION_ID"))
	privateKeyPath := strings.TrimSpace(os.Getenv("ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH"))
	if appID == "" && installationID == "" && privateKeyPath == "" {
		return nil
	}
	return &gitHubAppAuth{appID: appID, installationID: installationID, privateKeyPath: privateKeyPath}
}

func (auth *gitHubAppAuth) configured() bool {
	return auth.appID != "" && auth.installationID != "" && auth.privateKeyPath != ""
}

func (auth *gitHubAppAuth) accessToken(ctx context.Context, client gitHubClient) (string, error) {
	auth.mu.Lock()
	defer auth.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if !auth.configured() {
		return "", fmt.Errorf("GitHub App authentication needs app ID, installation ID, and private-key path")
	}
	if time.Now().Before(auth.expiresAt) {
		return auth.token, nil
	}
	if !validGitHubID(auth.appID) || !validGitHubID(auth.installationID) {
		return "", fmt.Errorf("GitHub App ID and installation ID must be positive integers")
	}
	if auth.privateKey == nil {
		key, err := loadGitHubAppPrivateKey(auth.privateKeyPath)
		if err != nil {
			return "", err
		}
		auth.privateKey = key
	}
	jwt, err := auth.jwt(time.Now())
	if err != nil {
		return "", err
	}
	path := "/app/installations/" + auth.installationID + "/access_tokens"
	body, err := client.requestBytesWithToken(ctx, http.MethodPost, path, "application/vnd.github+json", nil,
		[]byte("{}"), jwt)
	if err != nil {
		return "", fmt.Errorf("create GitHub installation token: %w", err)
	}
	var response struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return "", fmt.Errorf("decode GitHub installation token: %w", err)
	}
	if response.Token == "" || len(response.Token) > 4096 || strings.ContainsAny(response.Token, "\r\n") ||
		!response.ExpiresAt.After(time.Now().Add(time.Minute)) {
		return "", fmt.Errorf("GitHub returned an invalid or near-expired installation token")
	}
	auth.token = response.Token
	auth.expiresAt = response.ExpiresAt.Add(-time.Minute)
	return auth.token, nil
}

func (auth *gitHubAppAuth) jwt(now time.Time) (string, error) {
	encode := base64.RawURLEncoding.EncodeToString
	header := encode([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, err := json.Marshal(struct {
		IssuedAt int64  `json:"iat"`
		Expires  int64  `json:"exp"`
		Issuer   string `json:"iss"`
	}{IssuedAt: now.Add(-time.Minute).Unix(), Expires: now.Add(9 * time.Minute).Unix(), Issuer: auth.appID})
	if err != nil {
		return "", err
	}
	unsigned := header + "." + encode(claims)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, auth.privateKey, crypto.SHA256, digest[:])
	if err != nil {
		return "", fmt.Errorf("sign GitHub App JWT: %w", err)
	}
	return unsigned + "." + encode(signature), nil
}

func loadGitHubAppPrivateKey(path string) (*rsa.PrivateKey, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open GitHub App private key: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect GitHub App private key: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > maxGitHubAppPrivateKeySize {
		return nil, fmt.Errorf("GitHub App private key must be a regular file no larger than %d bytes", maxGitHubAppPrivateKeySize)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("GitHub App private key must not be readable or writable by group or other users")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxGitHubAppPrivateKeySize+1))
	if err != nil {
		return nil, fmt.Errorf("read GitHub App private key: %w", err)
	}
	if len(data) > maxGitHubAppPrivateKeySize {
		return nil, fmt.Errorf("GitHub App private key must be a regular file no larger than %d bytes", maxGitHubAppPrivateKeySize)
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("GitHub App private key is not PEM encoded")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		if key.N.BitLen() < 2048 {
			return nil, fmt.Errorf("GitHub App RSA private key must be at least 2048 bits")
		}
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse GitHub App private key: %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("GitHub App private key must use RSA")
	}
	if key.N.BitLen() < 2048 {
		return nil, fmt.Errorf("GitHub App RSA private key must be at least 2048 bits")
	}
	return key, nil
}

func validGitHubID(value string) bool {
	parsed, err := strconv.ParseUint(value, 10, 64)
	return err == nil && parsed > 0
}
