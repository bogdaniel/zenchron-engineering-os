package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

const (
	maxWorkerConfigSize     = 1 << 20
	maxVerificationCommands = 20
	verificationOutputTail  = 1500
)

// workerConfig is owned by the workstation operator. It is the only source of commands the worker runs
// on its own behalf, so a control-plane request can never choose what executes on this machine. When it
// is present it is also the allowlist of repositories this worker serves.
type workerConfig struct {
	Repositories map[string]repositoryConfig `json:"repositories"`
}

type repositoryConfig struct {
	Verify [][]string `json:"verify"`
	// Environment is added to provider and verification processes, for example a build cache location
	// that a sandboxed agent can write to.
	Environment map[string]string `json:"environment"`
	// ReadPaths are absolute paths a sandboxed provider may read in addition to the worktree, for
	// example a dependency cache in the home directory.
	ReadPaths []string `json:"read_paths"`
}

var environmentNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

type runLimits struct {
	wallClock    time.Duration
	inactivity   time.Duration
	toolActivity time.Duration
	verification time.Duration
	// gitStage bounds diff, commit, and push after the provider stops. It is not operator-configurable.
	gitStage time.Duration
}

func loadWorkerConfig() (*workerConfig, error) {
	path := strings.TrimSpace(os.Getenv("ZENCHRON_WORKER_CONFIG"))
	if path == "" {
		return nil, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open ZENCHRON_WORKER_CONFIG: %w", err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxWorkerConfigSize+1))
	if err != nil || len(data) > maxWorkerConfigSize {
		return nil, errors.New("ZENCHRON_WORKER_CONFIG is unreadable or too large")
	}
	var config workerConfig
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return nil, fmt.Errorf("decode ZENCHRON_WORKER_CONFIG: %w", err)
	}
	for repository, settings := range config.Repositories {
		if repositoryLocator("https://"+repository) != repository || len(settings.Verify) > maxVerificationCommands {
			return nil, fmt.Errorf("ZENCHRON_WORKER_CONFIG repository %q is invalid", repository)
		}
		for name, value := range settings.Environment {
			if !environmentNamePattern.MatchString(name) || strings.ContainsRune(value, 0) || reservedEnvironmentName(name) {
				return nil, fmt.Errorf("ZENCHRON_WORKER_CONFIG repository %q sets an invalid or reserved variable %q", repository, name)
			}
		}
		for _, path := range settings.ReadPaths {
			if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
				return nil, fmt.Errorf("ZENCHRON_WORKER_CONFIG repository %q lists read path %q, which must be absolute and clean", repository, path)
			}
		}
		for _, command := range settings.Verify {
			if len(command) == 0 || strings.TrimSpace(command[0]) == "" {
				return nil, fmt.Errorf("ZENCHRON_WORKER_CONFIG repository %q has an empty verification command", repository)
			}
		}
	}
	return &config, nil
}

// serves reports whether this worker may advertise and execute work for a repository.
func (config *workerConfig) serves(repository string) bool {
	if config == nil {
		return true
	}
	_, listed := config.Repositories[repository]
	return listed
}

func (config *workerConfig) verificationCommands(repository string) [][]string {
	if config == nil {
		return nil
	}
	return config.Repositories[repository].Verify
}

// processEnvironment is what provider and verification processes for a repository run with.
func (config *workerConfig) processEnvironment(repository string) []string {
	environment := providerEnvironment(os.Environ())
	if config == nil {
		return environment
	}
	for name, value := range config.Repositories[repository].Environment {
		environment = append(environment, name+"="+value)
	}
	return environment
}

func (config *workerConfig) readPaths(repository string) []string {
	if config == nil {
		return nil
	}
	return slices.Clone(config.Repositories[repository].ReadPaths)
}

func loadRunLimits() (runLimits, error) {
	limits := runLimits{wallClock: 2 * time.Hour, inactivity: 15 * time.Minute, toolActivity: 45 * time.Minute,
		verification: 30 * time.Minute, gitStage: 2 * time.Minute}
	for name, target := range map[string]*time.Duration{
		"ZENCHRON_RUN_TIMEOUT": &limits.wallClock, "ZENCHRON_RUN_INACTIVITY_TIMEOUT": &limits.inactivity,
		"ZENCHRON_RUN_TOOL_TIMEOUT": &limits.toolActivity, "ZENCHRON_VERIFY_TIMEOUT": &limits.verification,
	} {
		value := strings.TrimSpace(os.Getenv(name))
		if value == "" {
			continue
		}
		duration, err := time.ParseDuration(value)
		if err != nil || duration <= 0 {
			return runLimits{}, fmt.Errorf("%s must be a positive duration such as 30m", name)
		}
		*target = duration
	}
	return limits, nil
}

// runVerification executes the operator's commands in the worktree, under the attempt's ownership so
// they stop with the worker like the provider does. Every command must exit zero.
func runVerification(
	ctx context.Context, workspace runWorkspace, commands [][]string, timeout time.Duration,
	emit func(kind, message string),
) string {
	if len(commands) == 0 {
		emit("verification", "No verification commands are configured for this repository on the worker.")
		return workerapi.VerificationNotConfigured
	}
	verifyCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for _, arguments := range commands {
		label := strings.Join(arguments, " ")
		output := &tailBuffer{limit: verificationOutputTail}
		command := workspace.owner.command(verifyCtx, arguments)
		command.Dir, command.Env = workspace.path, workspace.environment
		command.Stdout, command.Stderr = output, output
		sweep, err := workspace.owner.start(command)
		if err == nil {
			err = command.Wait()
			sweep()
		}
		if errors.Is(verifyCtx.Err(), context.DeadlineExceeded) {
			emit("verification", fmt.Sprintf("timed out after %s: %s", timeout, label))
			return workerapi.VerificationFailed
		}
		if err != nil {
			emit("verification", fmt.Sprintf("failed: %s\n%s", label, output.String()))
			return workerapi.VerificationFailed
		}
		emit("verification", "passed: "+label)
	}
	return workerapi.VerificationPassed
}
