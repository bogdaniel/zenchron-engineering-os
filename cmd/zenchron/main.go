package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	if len(os.Args) == 1 {
		return startManaged()
	}
	switch os.Args[1] {
	case "build-info":
		return json.NewEncoder(os.Stdout).Encode(map[string]int{
			"state_schema_version": updater.StateSchemaVersion, "protocol_version": workerapi.ProtocolVersion,
		})
	case "install":
		return installManaged()
	case "start":
		return startManaged()
	case "managed":
		return runManaged()
	case "serve":
		return runControlPlane()
	case "status":
		return showManagedStatus()
	case "doctor":
		return showManagedDoctor()
	default:
		return fmt.Errorf("unknown command %q; use install, start, status, or doctor", os.Args[1])
	}
}

func runControlPlane() error {
	addr := os.Getenv("ZENCHRON_LISTEN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid listen address %q: %w", addr, err)
	}
	auth, configured, err := loadAuthConfig()
	if err != nil {
		return err
	}
	if !isLoopbackHost(host) && !configured {
		return fmt.Errorf("non-loopback listen address requires GitHub authentication and worker credentials")
	}
	if !isLoopbackHost(host) && auth.access == nil {
		return fmt.Errorf("non-loopback listen address requires ZENCHRON_ACCESS_FILE; the shared worker token is for loopback use only")
	}
	if !isLoopbackHost(host) && !auth.https {
		return fmt.Errorf("ZENCHRON_PUBLIC_URL must use https for a non-loopback control plane")
	}
	if _, err := loadWebhookSecret(); err != nil {
		return err
	}
	dataDir, err := controlPlaneDataDirectory()
	if err != nil {
		return err
	}
	lock, err := acquireControlPlaneLock(dataDir)
	if err != nil {
		return err
	}
	defer lock.Close()
	handler, err := newPersistentMux(dataDir)
	if err != nil {
		return fmt.Errorf("initialize control-plane state: %w", err)
	}
	handler = authHandler(handler, auth)

	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", addr, err)
	}
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- server.Serve(listener)
	}()
	log.Printf("Zenchron control plane listening on %s", listener.Addr())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve HTTP: %w", err)
		}
		return nil
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shut down HTTP server: %w", err)
		}
		if err := <-serveErr; !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve HTTP: %w", err)
		}
		return nil
	}
}

func isLoopbackHost(host string) bool {
	return strings.EqualFold(host, "localhost") || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback())
}
