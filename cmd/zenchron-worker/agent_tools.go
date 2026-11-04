package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	maxAgentToolOutput = 20_000
	maxAgentReadSize   = 256 << 10
)

func executeAgentTool(ctx context.Context, repository string, allowed []string, name, arguments string) (string, error) {
	if !contains(allowed, name) {
		return "", errors.New("tool is not allowed by this profile")
	}
	switch name {
	case "code.search":
		return searchRepository(ctx, repository, ".", arguments)
	case "code.write":
		return writeRepositoryFile(repository, arguments)
	case "docs.search":
		return searchRepository(ctx, repository, "docs", arguments)
	case "git.diff":
		return repositoryDiff(ctx, repository, arguments)
	case "git.read":
		return readRepositoryFile(repository, arguments)
	default:
		return "", errors.New("tool is not supported by this worker runtime")
	}
}

func searchRepository(ctx context.Context, repository, directory, arguments string) (string, error) {
	var input struct {
		Query string `json:"query"`
	}
	if err := decodeToolArguments(arguments, &input); err != nil || strings.TrimSpace(input.Query) == "" || len(input.Query) > 500 {
		return "", errors.New("search query is invalid")
	}
	searchPath := filepath.Join(repository, directory)
	if directory == "docs" {
		if info, err := os.Stat(searchPath); err != nil || !info.IsDir() {
			return "No documentation directory exists.", nil
		}
	}
	commandCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	output := &boundedToolOutput{limit: maxAgentToolOutput}
	command := exec.CommandContext(commandCtx, "rg", "--line-number", "--no-heading", "--color", "never",
		"--fixed-strings", "--", input.Query, directory)
	command.Dir = repository
	command.Stdout, command.Stderr = output, io.Discard
	err := command.Run()
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) && exitError.ExitCode() == 1 && output.Len() == 0 {
			return "No matches.", nil
		}
		return "", fmt.Errorf("repository search failed: %w", err)
	}
	return output.result(), nil
}

func repositoryDiff(ctx context.Context, repository, arguments string) (string, error) {
	var input struct{}
	if err := decodeToolArguments(arguments, &input); err != nil {
		return "", errors.New("diff arguments are invalid")
	}
	commandCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	output := &boundedToolOutput{limit: maxAgentToolOutput}
	command := exec.CommandContext(commandCtx, "git", "-C", repository, "diff", "--no-ext-diff", "--no-color", "--")
	command.Stdout, command.Stderr = output, io.Discard
	if err := command.Run(); err != nil {
		return "", fmt.Errorf("read repository diff: %w", err)
	}
	if output.Len() == 0 {
		return "No tracked changes.", nil
	}
	return output.result(), nil
}

func readRepositoryFile(repository, arguments string) (string, error) {
	var input struct {
		Path string `json:"path"`
	}
	if err := decodeToolArguments(arguments, &input); err != nil {
		return "", errors.New("file path is invalid")
	}
	path, err := safeRepositoryPath(repository, input.Path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("read repository file: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > maxAgentReadSize {
		return "", errors.New("file is not a regular file or exceeds the read limit")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read repository file: %w", err)
	}
	return string(data), nil
}

func writeRepositoryFile(repository, arguments string) (string, error) {
	var input struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := decodeToolArguments(arguments, &input); err != nil || len(input.Content) > maxAgentReadSize {
		return "", errors.New("file content is invalid or exceeds the write limit")
	}
	path, err := safeRepositoryWritePath(repository, input.Path)
	if err != nil {
		return "", err
	}
	mode := os.FileMode(0o600)
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() || info.Size() > maxAgentReadSize {
			return "", errors.New("file is not a regular file or exceeds the write limit")
		}
		mode = info.Mode().Perm()
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("inspect repository file: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".zenchron-write-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create temporary repository file: %w", err)
	}
	temporaryPath := temporary.Name()
	closed, renamed := false, false
	defer func() {
		if !closed {
			_ = temporary.Close()
		}
		if !renamed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(mode); err != nil {
		return "", fmt.Errorf("set repository file permissions: %w", err)
	}
	if _, err := io.WriteString(temporary, input.Content); err != nil {
		return "", fmt.Errorf("write repository file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return "", fmt.Errorf("sync repository file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		closed = true
		return "", fmt.Errorf("close repository file: %w", err)
	}
	closed = true
	if err := os.Rename(temporaryPath, path); err != nil {
		return "", fmt.Errorf("replace repository file: %w", err)
	}
	renamed = true
	return "Updated " + filepath.ToSlash(input.Path) + ".", nil
}

func safeRepositoryPath(repository, requested string) (string, error) {
	relative, err := safeRepositoryRelativePath(requested)
	if err != nil {
		return "", err
	}
	root, err := filepath.EvalSymlinks(repository)
	if err != nil {
		return "", fmt.Errorf("resolve repository: %w", err)
	}
	path, err := filepath.EvalSymlinks(filepath.Join(root, relative))
	if err != nil {
		return "", fmt.Errorf("resolve repository file: %w", err)
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("file path resolves outside the repository")
	}
	return path, nil
}

// shortcut: code.write needs an existing parent directory; add safe directory creation if tasks require nested new files.
func safeRepositoryWritePath(repository, requested string) (string, error) {
	relative, err := safeRepositoryRelativePath(requested)
	if err != nil {
		return "", err
	}
	root, err := filepath.EvalSymlinks(repository)
	if err != nil {
		return "", fmt.Errorf("resolve repository: %w", err)
	}
	path := filepath.Join(root, relative)
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return "", fmt.Errorf("resolve repository directory: %w", err)
	}
	if !repositoryPathIsInside(root, parent) {
		return "", errors.New("file directory resolves outside the repository")
	}
	path = filepath.Join(parent, filepath.Base(path))
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("repository file is a symlink")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("inspect repository file: %w", err)
	}
	return path, nil
}

func safeRepositoryRelativePath(requested string) (string, error) {
	if requested == "" || filepath.IsAbs(requested) || strings.ContainsRune(requested, '\\') {
		return "", errors.New("file path must be relative to the repository")
	}
	relative := filepath.Clean(filepath.FromSlash(requested))
	if relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("file path must stay inside the repository")
	}
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		if part == ".git" {
			return "", errors.New("Git metadata cannot be accessed")
		}
	}
	return relative, nil
}

func repositoryPathIsInside(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func decodeToolArguments(arguments string, target any) error {
	decoder := json.NewDecoder(strings.NewReader(arguments))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("tool arguments contain trailing data")
	}
	return nil
}

func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

type boundedToolOutput struct {
	bytes.Buffer
	limit     int
	truncated bool
}

func (output *boundedToolOutput) Write(data []byte) (int, error) {
	length := len(data)
	remaining := output.limit - output.Len()
	if remaining < length {
		output.truncated = true
	}
	if remaining > 0 {
		if remaining < length {
			data = data[:remaining]
		}
		_, _ = output.Buffer.Write(data)
	}
	return length, nil
}

func (output *boundedToolOutput) result() string {
	if !output.truncated {
		return output.String()
	}
	return output.String() + "\n[Output truncated at the worker limit.]"
}
