package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

type discoveredProject struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Branch string `json:"branch"`
	Remote string `json:"git_remote,omitempty"`
	Path   string `json:"-"`
}

// ponytail: Git metadata is capped at 1 KiB; raise the bound if Git expands the HEAD format.
const maxGitMetadataSize = 1024

func stableID(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:16])
}

func discoverProjects(root, workerID string) ([]discoveredProject, error) {
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if isGitCheckout(absoluteRoot) {
		return []discoveredProject{projectAt(absoluteRoot, workerID)}, nil
	}
	entries, err := os.ReadDir(absoluteRoot)
	if err != nil {
		return nil, fmt.Errorf("read projects root: %w", err)
	}
	projects := make([]discoveredProject, 0)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(absoluteRoot, entry.Name())
		if isGitCheckout(path) {
			projects = append(projects, projectAt(path, workerID))
		}
	}
	return projects, nil
}

func isGitCheckout(path string) bool {
	_, err := os.Stat(filepath.Join(path, ".git"))
	return err == nil
}

func projectAt(path, workerID string) discoveredProject {
	return discoveredProject{
		ID: stableID(workerID + "\x00" + path), Name: filepath.Base(path),
		Branch: currentBranch(path), Remote: gitRemote(path), Path: path,
	}
}

func gitRemote(path string) string {
	remote, err := gitOutput(context.Background(), "-C", path, "remote", "get-url", "origin")
	if err != nil {
		return ""
	}
	return repositoryLocator(remote)
}

func repositoryLocator(remote string) string {
	remote = strings.TrimSpace(remote)
	var host, path string
	if strings.Contains(remote, "://") {
		parsed, err := url.Parse(remote)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http" && parsed.Scheme != "ssh") {
			return ""
		}
		host = parsed.Hostname()
		if host == "" {
			return ""
		}
		if port := parsed.Port(); port != "" {
			host = net.JoinHostPort(host, port)
		}
		path = parsed.Path
	} else {
		remoteHost, remotePath, ok := strings.Cut(remote, ":")
		if !ok {
			return ""
		}
		if userAt := strings.LastIndex(remoteHost, "@"); userAt >= 0 {
			remoteHost = remoteHost[userAt+1:]
		}
		host, path = remoteHost, remotePath
	}
	host = strings.ToLower(host)
	if host == "" || strings.ContainsAny(host, "@/?#\\\r\n ") {
		return ""
	}
	if parsedHost, err := url.Parse("https://" + host); err != nil || parsedHost.Hostname() == "" {
		return ""
	}
	path = strings.TrimSuffix(strings.Trim(path, "/"), ".git")
	parts := strings.Split(path, "/")
	if len(parts) < 2 {
		return ""
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "@?#\\\r\n \t") {
			return ""
		}
	}
	locator := host + "/" + strings.Join(parts, "/")
	if len(locator) > 512 {
		return ""
	}
	return locator
}

func currentBranch(path string) string {
	metadata := filepath.Join(path, ".git")
	info, err := os.Lstat(metadata)
	if err != nil {
		return "Unknown"
	}
	gitDir := metadata
	if !info.IsDir() {
		if !info.Mode().IsRegular() {
			return "Unknown"
		}
		pointer, err := readGitMetadata(metadata, info.Size())
		if err != nil {
			return "Unknown"
		}
		directive, target, ok := strings.Cut(strings.TrimSpace(string(pointer)), "gitdir: ")
		if !ok || directive != "" || target == "" {
			return "Unknown"
		}
		gitDir = target
		if !filepath.IsAbs(gitDir) {
			gitDir = filepath.Join(path, gitDir)
		}
		gitDir = filepath.Clean(gitDir)
		if filepath.Base(filepath.Dir(gitDir)) != "worktrees" ||
			filepath.Base(filepath.Dir(filepath.Dir(gitDir))) != ".git" {
			return "Unknown"
		}
	}
	gitInfo, err := os.Lstat(gitDir)
	if err != nil || !gitInfo.IsDir() {
		return "Unknown"
	}
	headPath := filepath.Join(gitDir, "HEAD")
	headInfo, err := os.Lstat(headPath)
	if err != nil || !headInfo.Mode().IsRegular() {
		return "Unknown"
	}
	head, err := readGitMetadata(headPath, headInfo.Size())
	if err != nil {
		return "Unknown"
	}
	value := strings.TrimSpace(string(head))
	if branch, ok := strings.CutPrefix(value, "ref: refs/heads/"); ok && validBranchName(branch) {
		return branch
	}
	if revision, err := hex.DecodeString(value); err == nil && len(revision) >= 20 {
		return "Detached HEAD"
	}
	return "Unknown"
}

func readGitMetadata(path string, size int64) ([]byte, error) {
	if size < 0 || size > maxGitMetadataSize {
		return nil, fmt.Errorf("git metadata is too large")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, maxGitMetadataSize+1))
}

func validBranchName(branch string) bool {
	if branch == "" || len(branch) > 255 || strings.Contains(branch, "..") || strings.Contains(branch, "//") ||
		strings.HasPrefix(branch, ".") || strings.HasSuffix(branch, ".") || strings.Contains(branch, "@{") {
		return false
	}
	for _, character := range branch {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}
