package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestControlPlaneHTTPServerBoundsRequestReads(t *testing.T) {
	readErrors := make(chan error, 1)
	server := newControlPlaneHTTPServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, err := io.Copy(io.Discard, r.Body)
		readErrors <- err
	}))
	if server.ReadHeaderTimeout != 5*time.Second || server.ReadTimeout != 30*time.Second || server.IdleTimeout != 2*time.Minute {
		t.Fatalf("server timeouts = (%s, %s, %s), want (5s, 30s, 2m)", server.ReadHeaderTimeout, server.ReadTimeout, server.IdleTimeout)
	}

	server.ReadTimeout = 100 * time.Millisecond
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- server.Serve(listener) }()
	t.Cleanup(func() {
		_ = server.Close()
		if err := <-serveErrors; !errors.Is(err, http.ErrServerClosed) {
			t.Errorf("Serve() error = %v, want ErrServerClosed", err)
		}
	})

	connection, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	if _, err := fmt.Fprint(connection, "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\na"); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-readErrors:
		var netErr net.Error
		if !errors.As(err, &netErr) || !netErr.Timeout() {
			t.Fatalf("body read error = %v, want timeout", err)
		}
	case <-time.After(time.Second):
		t.Fatal("server did not time out the incomplete request body")
	}
}
