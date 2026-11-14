package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"
)

const authSessionCookie = "zenchron_session"
const oauthStateCookie = "zenchron_oauth_state"

type authConfig struct {
	clientID     string
	clientSecret string
	sessionKey   []byte
	workerToken  string
	access       *accessPolicy
	allowedUsers []string
	publicURL    *url.URL
	https        bool
	githubURL    string
	githubAPIURL string
}

type authUser struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
	ExpiresAt int64  `json:"expires_at"`
}

func loadAuthConfig() (*authConfig, bool, error) {
	keys := []string{"ZENCHRON_GITHUB_CLIENT_ID", "ZENCHRON_GITHUB_CLIENT_SECRET", "ZENCHRON_SESSION_SECRET",
		"ZENCHRON_GITHUB_ALLOWED_USERS", "ZENCHRON_PUBLIC_URL"}
	workerKeys := []string{"ZENCHRON_WORKER_TOKEN", "ZENCHRON_ACCESS_FILE"}
	isSet := func(key string) bool { return strings.TrimSpace(os.Getenv(key)) != "" }
	if !slices.ContainsFunc(slices.Concat(keys, workerKeys), isSet) {
		return nil, false, nil
	}
	for _, key := range keys {
		if !isSet(key) {
			return nil, true, fmt.Errorf("%s is required when authentication is configured", key)
		}
	}
	if !slices.ContainsFunc(workerKeys, isSet) {
		return nil, true, fmt.Errorf("ZENCHRON_ACCESS_FILE or ZENCHRON_WORKER_TOKEN is required when authentication is configured")
	}
	access, err := loadAccessPolicy()
	if err != nil {
		return nil, true, err
	}
	publicURL, err := url.Parse(strings.TrimRight(os.Getenv("ZENCHRON_PUBLIC_URL"), "/"))
	if err != nil || (publicURL.Scheme != "https" && publicURL.Scheme != "http") || publicURL.Host == "" ||
		publicURL.User != nil || publicURL.Path != "" || publicURL.RawQuery != "" || publicURL.Fragment != "" {
		return nil, true, fmt.Errorf("ZENCHRON_PUBLIC_URL must be an http(s) origin without a path")
	}
	workerToken := strings.TrimSpace(os.Getenv("ZENCHRON_WORKER_TOKEN"))
	if access == nil && (len(workerToken) < 32 || strings.ContainsAny(workerToken, " \t\r\n")) {
		return nil, true, fmt.Errorf("ZENCHRON_WORKER_TOKEN must contain at least 32 non-whitespace bytes")
	}
	allowedUsers := strings.FieldsFunc(os.Getenv("ZENCHRON_GITHUB_ALLOWED_USERS"), func(r rune) bool { return r == ',' || r == '\n' })
	for i, user := range allowedUsers {
		allowedUsers[i] = strings.ToLower(strings.TrimSpace(user))
	}
	allowedUsers = slices.DeleteFunc(allowedUsers, func(user string) bool { return user == "" })
	if len(allowedUsers) == 0 {
		return nil, true, fmt.Errorf("ZENCHRON_GITHUB_ALLOWED_USERS must contain at least one username")
	}
	secret := []byte(os.Getenv("ZENCHRON_SESSION_SECRET"))
	if len(secret) < 32 {
		return nil, true, fmt.Errorf("ZENCHRON_SESSION_SECRET must contain at least 32 bytes")
	}
	return &authConfig{
		clientID: strings.TrimSpace(os.Getenv("ZENCHRON_GITHUB_CLIENT_ID")), clientSecret: strings.TrimSpace(os.Getenv("ZENCHRON_GITHUB_CLIENT_SECRET")),
		sessionKey: secret, workerToken: workerToken, access: access, allowedUsers: allowedUsers,
		publicURL: publicURL, https: publicURL.Scheme == "https", githubURL: "https://github.com", githubAPIURL: "https://api.github.com",
	}, true, nil
}

func authHandler(next http.Handler, config *authConfig) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/auth/github" && r.Method == http.MethodGet {
			if config == nil {
				http.Error(w, "GitHub sign-in is not configured", http.StatusNotFound)
				return
			}
			startGitHubOAuth(w, r, config)
			return
		}
		if r.URL.Path == "/auth/github/callback" && r.Method == http.MethodGet {
			completeGitHubOAuth(w, r, config)
			return
		}
		if r.URL.Path == "/api/v1/auth/session" && r.Method == http.MethodGet {
			w.Header().Set("Cache-Control", "no-store")
			if config == nil {
				writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "local": true, "login": "Local workspace"})
				return
			}
			user, ok := readSession(r, config)
			if !ok {
				http.Error(w, "authentication required", http.StatusUnauthorized)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "local": false, "login": user.Login,
				"avatar_url": user.AvatarURL, "admin": config.isAdmin(user.Login)})
			return
		}
		if r.URL.Path == "/api/v1/auth/logout" && r.Method == http.MethodPost {
			w.Header().Set("Cache-Control", "no-store")
			if config == nil {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			if !validRequestOrigin(r.Header.Get("Origin"), config) {
				http.Error(w, "invalid request origin", http.StatusForbidden)
				return
			}
			http.SetCookie(w, &http.Cookie{Name: authSessionCookie, Value: "", Path: "/", HttpOnly: true, Secure: config.https, SameSite: http.SameSiteLaxMode, MaxAge: -1})
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if config != nil && r.URL.Path == gitHubWebhookPath && r.Method == http.MethodPost {
			// GitHub has no session. The handler authenticates the delivery by its signature, and gets the
			// current policy so that it can decide on whose authority a delivery may queue work.
			access := requestAccess{}
			if config.access != nil {
				policy, err := config.access.current()
				if err != nil {
					http.Error(w, "access policy is unavailable", http.StatusServiceUnavailable)
					return
				}
				access = requestAccess{enforced: true, policy: policy}
			}
			next.ServeHTTP(w, withRequestAccess(r, access))
			return
		}
		if config != nil && strings.HasPrefix(r.URL.Path, "/api/v1/") {
			access, status, message := config.authorize(r)
			if status != 0 {
				http.Error(w, message, status)
				return
			}
			r = withRequestAccess(r, access)
			if strings.HasPrefix(r.URL.Path, "/api/v1/admin/") && config.access != nil {
				config.access.serveAdmin(w, r)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// authorize authenticates one API request and returns what its caller may touch.
func (config *authConfig) authorize(r *http.Request) (requestAccess, int, string) {
	var policy *accessFile
	if config.access != nil {
		var err error
		if policy, err = config.access.current(); err != nil {
			log.Printf("access policy is unavailable; denying request: %v", err)
			return requestAccess{}, http.StatusServiceUnavailable, "access policy is unavailable"
		}
	}
	if isWorkerAPIRequest(r.Method, r.URL.Path) {
		return config.authorizeWorker(r, policy)
	}
	user, ok := readSession(r, config)
	if !ok {
		return requestAccess{}, http.StatusUnauthorized, "authentication required"
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions &&
		!validRequestOrigin(r.Header.Get("Origin"), config) {
		return requestAccess{}, http.StatusForbidden, "invalid request origin"
	}
	if policy == nil {
		return requestAccess{}, 0, ""
	}
	login := strings.ToLower(user.Login)
	return requestAccess{enforced: true, user: login, admin: slices.Contains(policy.Admins, login),
		repositories: policy.Users[login], policy: policy}, 0, ""
}

// maySignIn reports whether a GitHub login may hold a session: the operator allowlisted it, or the
// access policy names it. Removing a user from the policy therefore ends their sessions at the next
// request unless the operator also allowlisted them.
func (config *authConfig) maySignIn(login string) bool {
	login = strings.ToLower(login)
	if slices.Contains(config.allowedUsers, login) {
		return true
	}
	if config.access == nil {
		return false
	}
	policy, err := config.access.current()
	return err == nil && policy.knows(login)
}

func (config *authConfig) isAdmin(login string) bool {
	if config.access == nil {
		return false
	}
	policy, err := config.access.current()
	return err == nil && slices.Contains(policy.Admins, strings.ToLower(login))
}

// authorizeWorker accepts the legacy shared token only when no access file is configured. With an
// access file, a token is valid for exactly the worker id it was enrolled for.
func (config *authConfig) authorizeWorker(r *http.Request, policy *accessFile) (requestAccess, int, string) {
	authorization := r.Header.Get("Authorization")
	if policy == nil {
		if !validBearer(authorization, config.workerToken) {
			return requestAccess{}, http.StatusUnauthorized, "worker authentication required"
		}
		return requestAccess{}, 0, ""
	}
	workerID := ""
	if parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/"); len(parts) > 4 {
		workerID = strings.ToLower(parts[3])
	}
	grant, ok := policy.authenticateWorker(workerID, authorization)
	if !ok {
		return requestAccess{}, http.StatusUnauthorized, "worker authentication required"
	}
	return requestAccess{enforced: true, repositories: grant.Repositories, policy: policy}, 0, ""
}

func validRequestOrigin(origin string, config *authConfig) bool {
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || !strings.EqualFold(parsed.Scheme, config.publicURL.Scheme) ||
		!strings.EqualFold(parsed.Hostname(), config.publicURL.Hostname()) || parsed.User != nil || parsed.Path != "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	return effectiveOriginPort(parsed) == effectiveOriginPort(config.publicURL)
}

func effectiveOriginPort(origin *url.URL) string {
	if port := origin.Port(); port != "" {
		return port
	}
	if strings.EqualFold(origin.Scheme, "https") {
		return "443"
	}
	return "80"
}

func isWorkerAPIRequest(method, path string) bool {
	if method == http.MethodGet && path == "/api/v1/workers/healthz" {
		return true
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 5 || parts[0] != "api" || parts[1] != "v1" || parts[2] != "workers" {
		return false
	}
	switch {
	case len(parts) == 5 && parts[4] == "heartbeat" && method == http.MethodPut:
		return true
	case len(parts) == 6 && parts[4] == "agent-runs" && parts[5] == "claim" && method == http.MethodPost:
		return true
	case len(parts) == 7 && parts[4] == "agent-runs" && parts[6] == "progress" && method == http.MethodPost:
		return true
	case len(parts) == 6 && parts[4] == "agent-runs" && method == http.MethodPut:
		return true
	default:
		return false
	}
}

func startGitHubOAuth(w http.ResponseWriter, r *http.Request, config *authConfig) {
	state, err := randomToken(32)
	if err != nil {
		http.Error(w, "could not start sign-in", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: oauthStateCookie, Value: state, Path: "/auth/github", HttpOnly: true, Secure: config.https,
		SameSite: http.SameSiteLaxMode, MaxAge: 600})
	query := url.Values{"client_id": {config.clientID}, "redirect_uri": {config.publicURL.String() + "/auth/github/callback"}, "state": {state}, "scope": {"read:user"}}
	http.Redirect(w, r, config.githubURL+"/login/oauth/authorize?"+query.Encode(), http.StatusFound)
}

func completeGitHubOAuth(w http.ResponseWriter, r *http.Request, config *authConfig) {
	if config == nil {
		http.Error(w, "GitHub sign-in is not configured", http.StatusNotFound)
		return
	}
	stateCookie, err := r.Cookie(oauthStateCookie)
	if err != nil || r.URL.Query().Get("state") == "" || !secureEqual(r.URL.Query().Get("state"), stateCookie.Value) {
		http.Error(w, "invalid sign-in state", http.StatusBadRequest)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" || len(code) > 512 {
		http.Error(w, "invalid authorization code", http.StatusBadRequest)
		return
	}
	user, err := fetchGitHubUser(r, config, code)
	if err != nil {
		log.Printf("GitHub OAuth identity lookup failed: %v", err)
		http.Error(w, "GitHub sign-in could not verify your account; check the OAuth app credentials and retry", http.StatusBadGateway)
		return
	}
	if !config.maySignIn(user.Login) {
		http.Error(w, "GitHub account is not authorized", http.StatusForbidden)
		return
	}
	user.ExpiresAt = time.Now().Add(8 * time.Hour).Unix()
	value, err := signSession(user, config.sessionKey)
	if err != nil {
		http.Error(w, "could not create session", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: authSessionCookie, Value: value, Path: "/", HttpOnly: true, Secure: config.https,
		SameSite: http.SameSiteLaxMode, MaxAge: 8 * 60 * 60})
	http.SetCookie(w, &http.Cookie{Name: oauthStateCookie, Value: "", Path: "/auth/github", HttpOnly: true, Secure: config.https,
		SameSite: http.SameSiteLaxMode, MaxAge: -1})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func fetchGitHubUser(r *http.Request, config *authConfig, code string) (authUser, error) {
	var user authUser
	form := url.Values{"client_id": {config.clientID}, "client_secret": {config.clientSecret}, "code": {code},
		"redirect_uri": {config.publicURL.String() + "/auth/github/callback"}}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, config.githubURL+"/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return user, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	response, err := client.Do(request)
	if err != nil {
		return user, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return user, fmt.Errorf("GitHub token exchange returned HTTP %d", response.StatusCode)
	}
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&token); err != nil || token.AccessToken == "" {
		return user, fmt.Errorf("GitHub token response is invalid")
	}
	request, err = http.NewRequestWithContext(r.Context(), http.MethodGet, config.githubAPIURL+"/user", nil)
	if err != nil {
		return user, err
	}
	request.Header.Set("Authorization", "Bearer "+token.AccessToken)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "Zenchron-Engineering")
	response, err = client.Do(request)
	if err != nil {
		return user, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return user, fmt.Errorf("GitHub identity lookup returned HTTP %d", response.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&user); err != nil || user.Login == "" {
		return authUser{}, fmt.Errorf("GitHub identity response is invalid")
	}
	return user, nil
}

func randomToken(size int) (string, error) {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

func signSession(user authUser, key []byte) (string, error) {
	data, err := json.Marshal(user)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(data)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func readSession(r *http.Request, config *authConfig) (authUser, bool) {
	cookie, err := r.Cookie(authSessionCookie)
	if err != nil {
		return authUser{}, false
	}
	encoded, signature, ok := strings.Cut(cookie.Value, ".")
	if !ok {
		return authUser{}, false
	}
	provided, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil {
		return authUser{}, false
	}
	mac := hmac.New(sha256.New, config.sessionKey)
	_, _ = mac.Write([]byte(encoded))
	if !hmac.Equal(provided, mac.Sum(nil)) {
		return authUser{}, false
	}
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return authUser{}, false
	}
	var user authUser
	if json.Unmarshal(data, &user) != nil || user.Login == "" || user.ExpiresAt <= time.Now().Unix() ||
		!config.maySignIn(user.Login) {
		return authUser{}, false
	}
	return user, true
}

func secureEqual(left, right string) bool {
	return hmac.Equal([]byte(left), []byte(right))
}

func validBearer(header, token string) bool {
	parts := strings.Fields(header)
	return len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") && secureEqual(parts[1], token)
}
