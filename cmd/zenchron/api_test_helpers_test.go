package main

import (
	"io"
	"net/http"
	"net/http/httptest"
)

func jsonRequest(method, target string, body io.Reader) *http.Request {
	request := httptest.NewRequest(method, target, body)
	request.Header.Set("Content-Type", "application/json")
	return request
}
