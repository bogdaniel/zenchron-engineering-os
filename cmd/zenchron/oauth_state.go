package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/url"
	"strings"
)

func isDashboardReturnPath(value string) bool {
	if value == "" || len(value) > 2048 || !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") ||
		strings.ContainsAny(value, "\\\r\n") {
		return false
	}
	target, err := url.Parse(value)
	if err != nil || target.Scheme != "" || target.Host != "" || target.User != nil || target.Opaque != "" ||
		target.Path != "/" ||
		(target.Fragment != "" && target.Fragment != "objectives") {
		return false
	}
	query, err := url.ParseQuery(target.RawQuery)
	if err != nil {
		return false
	}
	for key, values := range query {
		switch key {
		case "mode", "objective", "tab", "graph_id", "decision":
		default:
			return false
		}
		if len(values) != 1 || len(values[0]) > 256 || strings.ContainsAny(values[0], "\x00\r\n") {
			return false
		}
	}
	return true
}

func encodeOAuthStateCookie(state, returnTo string, key []byte) string {
	payload := state + "." + base64.RawURLEncoding.EncodeToString([]byte(returnTo))
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func decodeOAuthStateCookie(value, state string, key []byte) (string, bool) {
	parts := strings.Split(value, ".")
	if len(parts) != 3 || state == "" || !secureEqual(parts[0], state) {
		return "", false
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", false
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return "", false
	}
	returnTo, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !isDashboardReturnPath(string(returnTo)) {
		return "", false
	}
	return string(returnTo), true
}
