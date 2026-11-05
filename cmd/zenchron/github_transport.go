package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

func (client gitHubClient) authConfigured() bool {
	return client.token != "" || client.appAuth != nil && client.appAuth.configured()
}

func (client gitHubClient) requestBytes(
	ctx context.Context, method, path, accept string, query url.Values, payload []byte,
) ([]byte, error) {
	token := client.token
	if token == "" && client.appAuth != nil {
		var err error
		token, err = client.appAuth.accessToken(ctx, client)
		if err != nil {
			return nil, err
		}
	}
	return client.requestBytesWithToken(ctx, method, path, accept, query, payload, token)
}

func (client gitHubClient) requestBytesWithToken(
	ctx context.Context, method, path, accept string, query url.Values, payload []byte, token string,
) ([]byte, error) {
	base, err := url.Parse(client.apiURL)
	if err != nil || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" ||
		(base.Scheme != "https" && !(base.Scheme == "http" && isLoopbackHost(base.Hostname()))) {
		return nil, fmt.Errorf("GitHub API URL must be HTTPS or loopback HTTP")
	}
	if strings.ContainsAny(token, "\r\n") || len(token) > 4096 {
		return nil, fmt.Errorf("GitHub credential is invalid")
	}
	base.Path = strings.TrimRight(base.Path, "/") + path
	if query != nil {
		base.RawQuery = query.Encode()
	}
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, base.String(), body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", accept)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "Zenchron-Engineering-Control-Plane")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("GitHub returned HTTP %d", response.StatusCode)
	}
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxGitHubResponseSize+1))
	if err != nil {
		return nil, err
	}
	if len(responseBody) > maxGitHubResponseSize {
		return nil, fmt.Errorf("GitHub response exceeded the size limit")
	}
	return responseBody, nil
}
