package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

const StateSchemaVersion = 1

var (
	fullSHA   = regexp.MustCompile(`^[0-9a-f]{40}$`)
	digestSHA = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type Candidate struct {
	Repository string
	Commit     string
	Tree       string
}

type Manifest struct {
	Repository                  string            `json:"repository"`
	Commit                      string            `json:"commit"`
	Tree                        string            `json:"tree"`
	StateSchemaVersion          int               `json:"state_schema_version"`
	ControlPlaneProtocolVersion int               `json:"control_plane_protocol_version"`
	WorkerProtocolVersion       int               `json:"worker_protocol_version"`
	Artifacts                   map[string]string `json:"artifacts"`
}

func (candidate Candidate) Validate() error {
	if err := ValidateRepository(candidate.Repository); err != nil {
		return err
	}
	if !fullSHA.MatchString(candidate.Commit) || !fullSHA.MatchString(candidate.Tree) {
		return errors.New("update commit and tree must be full lowercase Git SHAs")
	}
	return nil
}

func ValidateRepository(repository string) error {
	parts := strings.Split(repository, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || strings.ContainsAny(repository, "\\\x00 \t\n") {
		return fmt.Errorf("invalid update repository %q", repository)
	}
	for _, part := range parts {
		if part == "." || part == ".." || strings.ContainsAny(part, "\\:?#") {
			return fmt.Errorf("invalid update repository %q", repository)
		}
	}
	return nil
}

// BuildRelease is called only after the caller has verified that the candidate is the trusted main revision.
func BuildRelease(ctx context.Context, root string, candidate Candidate, gitCredential string) (Manifest, error) {
	return buildReleaseFrom(ctx, root, candidate, "https://github.com/"+candidate.Repository+".git", gitCredential)
}

func buildReleaseFrom(ctx context.Context, root string, candidate Candidate, remote, gitCredential string) (manifest Manifest, returnErr error) {
	if err := candidate.Validate(); err != nil {
		return Manifest{}, err
	}
	releaseDir := filepath.Join(root, "releases", candidate.Commit)
	if _, err := os.Stat(releaseDir); err == nil {
		manifest, err := VerifyRelease(releaseDir, candidate)
		return manifest, err
	} else if !errors.Is(err, os.ErrNotExist) {
		return Manifest{}, fmt.Errorf("inspect existing release: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "staging"), 0o700); err != nil {
		return Manifest{}, fmt.Errorf("create release staging directory: %w", err)
	}
	stage, err := os.MkdirTemp(filepath.Join(root, "staging"), candidate.Commit+"-")
	if err != nil {
		return Manifest{}, fmt.Errorf("create staged release: %w", err)
	}
	defer func() {
		if _, err := os.Lstat(stage); errors.Is(err, os.ErrNotExist) {
			return
		} else if err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("inspect failed release staging tree: %w", err))
			return
		}
		if err := makeWritableDirectories(stage); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("prepare failed release staging tree for cleanup: %w", err))
			return
		}
		if err := os.RemoveAll(stage); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("remove failed release staging tree: %w", err))
		}
	}()
	source := filepath.Join(stage, "source")
	if err := os.Mkdir(source, 0o700); err != nil {
		return Manifest{}, fmt.Errorf("create source directory: %w", err)
	}
	buildHome := filepath.Join(stage, "build-home")
	if err := os.Mkdir(buildHome, 0o700); err != nil {
		return Manifest{}, fmt.Errorf("create isolated build home: %w", err)
	}
	buildEnvironment := setEnvironment(safeBuildEnvironment(os.Environ()), map[string]string{
		"HOME": buildHome, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": filepath.Join(buildHome, ".gitconfig"),
	})
	if err := run(ctx, source, "git", buildEnvironment, "init", "--quiet"); err != nil {
		return Manifest{}, err
	}
	if err := run(ctx, source, "git", buildEnvironment, "remote", "add", "origin", remote); err != nil {
		return Manifest{}, err
	}
	if err := fetch(ctx, source, candidate.Commit, gitCredential, stage, buildEnvironment); err != nil {
		return Manifest{}, err
	}
	commit, err := gitOutput(ctx, source, buildEnvironment, "rev-parse", "FETCH_HEAD^{commit}")
	if err != nil || commit != candidate.Commit {
		return Manifest{}, fmt.Errorf("fetched source commit does not match trusted candidate %s", candidate.Commit)
	}
	tree, err := gitOutput(ctx, source, buildEnvironment, "rev-parse", "FETCH_HEAD^{tree}")
	if err != nil || tree != candidate.Tree {
		return Manifest{}, fmt.Errorf("fetched source tree does not match trusted candidate %s", candidate.Tree)
	}
	if err := run(ctx, source, "git", buildEnvironment, "checkout", "--quiet", "--detach", candidate.Commit); err != nil {
		return Manifest{}, err
	}
	if err := os.Mkdir(filepath.Join(stage, "bin"), 0o700); err != nil {
		return Manifest{}, fmt.Errorf("create release binary directory: %w", err)
	}
	if err := run(ctx, source, "go", buildEnvironment, "build", "-trimpath", "-o", filepath.Join(stage, "bin", "zenchron"), "./cmd/zenchron"); err != nil {
		return Manifest{}, err
	}
	if err := run(ctx, source, "go", buildEnvironment, "build", "-trimpath", "-o", filepath.Join(stage, "bin", "zenchron-worker"), "./cmd/zenchron-worker"); err != nil {
		return Manifest{}, err
	}
	controlPlaneInfo, err := binaryBuildInfo(ctx, filepath.Join(stage, "bin", "zenchron"), buildEnvironment)
	if err != nil {
		return Manifest{}, fmt.Errorf("read candidate control-plane compatibility: %w", err)
	}
	workerInfo, err := binaryBuildInfo(ctx, filepath.Join(stage, "bin", "zenchron-worker"), buildEnvironment)
	if err != nil {
		return Manifest{}, fmt.Errorf("read candidate worker compatibility: %w", err)
	}
	if controlPlaneInfo.StateSchemaVersion < 1 || controlPlaneInfo.ProtocolVersion < 1 || workerInfo.ProtocolVersion < 1 {
		return Manifest{}, errors.New("candidate binaries reported invalid compatibility versions")
	}
	dashboard := filepath.Join(source, "dashboard")
	if err := run(ctx, dashboard, "npm", buildEnvironment, "ci"); err != nil {
		return Manifest{}, err
	}
	if err := run(ctx, dashboard, "npm", buildEnvironment, "run", "build"); err != nil {
		return Manifest{}, err
	}
	if err := os.Rename(filepath.Join(dashboard, "dist"), filepath.Join(stage, "dashboard")); err != nil {
		return Manifest{}, fmt.Errorf("place dashboard release assets: %w", err)
	}
	if err := makeWritableDirectories(buildHome); err != nil {
		return Manifest{}, fmt.Errorf("prepare isolated build home for cleanup: %w", err)
	}
	if err := os.RemoveAll(buildHome); err != nil {
		return Manifest{}, fmt.Errorf("remove isolated build home: %w", err)
	}
	if err := os.RemoveAll(source); err != nil {
		return Manifest{}, fmt.Errorf("remove build checkout: %w", err)
	}
	manifest = Manifest{Repository: candidate.Repository, Commit: candidate.Commit, Tree: candidate.Tree,
		StateSchemaVersion:          controlPlaneInfo.StateSchemaVersion,
		ControlPlaneProtocolVersion: controlPlaneInfo.ProtocolVersion, WorkerProtocolVersion: workerInfo.ProtocolVersion,
		Artifacts: make(map[string]string)}
	for _, relative := range []string{"bin/zenchron", "bin/zenchron-worker"} {
		digest, err := fileDigest(filepath.Join(stage, relative))
		if err != nil {
			return Manifest{}, err
		}
		manifest.Artifacts[relative] = digest
	}
	if err := addTreeDigests(filepath.Join(stage, "dashboard"), "dashboard", manifest.Artifacts); err != nil {
		return Manifest{}, err
	}
	if err := writeManifest(filepath.Join(stage, "release.json"), manifest); err != nil {
		return Manifest{}, err
	}
	if err := syncReleaseTree(stage); err != nil {
		return Manifest{}, fmt.Errorf("sync staged release before publication: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(releaseDir), 0o700); err != nil {
		return Manifest{}, fmt.Errorf("create release directory: %w", err)
	}
	if err := os.Rename(stage, releaseDir); err != nil {
		return Manifest{}, fmt.Errorf("publish immutable release: %w", err)
	}
	if err := syncDirectory(filepath.Dir(releaseDir)); err != nil {
		return Manifest{}, fmt.Errorf("sync published releases directory: %w", err)
	}
	if err := makeReadOnly(releaseDir); err != nil {
		return Manifest{}, fmt.Errorf("make release immutable: %w", err)
	}
	if err := syncReleaseTree(releaseDir); err != nil {
		return Manifest{}, fmt.Errorf("sync immutable release: %w", err)
	}
	return VerifyRelease(releaseDir, candidate)
}

func syncReleaseTree(root string) error {
	var directories []string
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			directories = append(directories, path)
			return nil
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		syncErr := file.Sync()
		closeErr := file.Close()
		return errors.Join(syncErr, closeErr)
	}); err != nil {
		return err
	}
	for index := len(directories) - 1; index >= 0; index-- {
		if err := syncDirectory(directories[index]); err != nil {
			return err
		}
	}
	return nil
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	syncErr := directory.Sync()
	closeErr := directory.Close()
	return errors.Join(syncErr, closeErr)
}

func binaryBuildInfo(ctx context.Context, path string, environment []string) (struct {
	StateSchemaVersion int `json:"state_schema_version"`
	ProtocolVersion    int `json:"protocol_version"`
}, error) {
	var info struct {
		StateSchemaVersion int `json:"state_schema_version"`
		ProtocolVersion    int `json:"protocol_version"`
	}
	command := exec.CommandContext(ctx, path, "build-info")
	command.Env = environment
	output, err := command.Output()
	if err != nil {
		return info, fmt.Errorf("run %s build-info: %w", filepath.Base(path), err)
	}
	if err := json.Unmarshal(output, &info); err != nil {
		return info, fmt.Errorf("decode %s build-info: %w", filepath.Base(path), err)
	}
	return info, nil
}

func fetch(ctx context.Context, directory, commit, credential, stage string, environment []string) error {
	command := exec.CommandContext(ctx, "git", "fetch", "--no-tags", "--depth=1", "origin", commit)
	command.Dir = directory
	command.Env = setEnvironment(environment, map[string]string{"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "Never"})
	if credential != "" {
		if len(credential) > 4096 || strings.ContainsAny(credential, "\r\n") {
			return errors.New("GitHub fetch credential is invalid")
		}
		askpass := filepath.Join(stage, "git-askpass")
		if err := os.WriteFile(askpass, []byte("#!/bin/sh\ncase \"$1\" in *Username*) echo x-access-token ;; *Password*) echo \"$ZENCHRON_GIT_FETCH_TOKEN\" ;; *) exit 1 ;; esac\n"), 0o700); err != nil {
			return fmt.Errorf("write temporary Git credential helper: %w", err)
		}
		command.Env = setEnvironment(command.Env, map[string]string{"GIT_ASKPASS": askpass, "ZENCHRON_GIT_FETCH_TOKEN": credential})
		defer os.Remove(askpass)
	}
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git fetch failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func setEnvironment(environment []string, values map[string]string) []string {
	result := make([]string, 0, len(environment)+len(values))
	for _, item := range environment {
		key, _, _ := strings.Cut(item, "=")
		if _, replaced := values[key]; !replaced {
			result = append(result, item)
		}
	}
	for key, value := range values {
		result = append(result, key+"="+value)
	}
	return result
}

func safeBuildEnvironment(environment []string) []string {
	result := make([]string, 0, len(environment))
	for _, item := range environment {
		key, _, _ := strings.Cut(item, "=")
		upper := strings.ToUpper(key)
		if strings.HasPrefix(upper, "ZENCHRON_") || strings.HasPrefix(upper, "GITHUB_") ||
			strings.HasPrefix(upper, "GH_") || strings.Contains(upper, "API_KEY") ||
			strings.Contains(upper, "TOKEN") || strings.Contains(upper, "PRIVATE_KEY") ||
			strings.Contains(upper, "SECRET") || strings.Contains(upper, "PASSWORD") ||
			strings.Contains(upper, "CREDENTIAL") {
			continue
		}
		result = append(result, item)
	}
	return result
}

func VerifyRelease(releaseDir string, candidate Candidate) (Manifest, error) {
	if err := candidate.Validate(); err != nil {
		return Manifest{}, err
	}
	manifestPath := filepath.Join(releaseDir, "release.json")
	info, err := os.Lstat(manifestPath)
	if err != nil || !info.Mode().IsRegular() {
		return Manifest{}, errors.New("release manifest is missing or not a regular file")
	}
	file, err := os.Open(manifestPath)
	if err != nil {
		return Manifest{}, fmt.Errorf("open release manifest: %w", err)
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 1<<20))
	decoder.DisallowUnknownFields()
	var manifest Manifest
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode release manifest: %w", err)
	}
	if manifest.Repository != candidate.Repository || manifest.Commit != candidate.Commit || manifest.Tree != candidate.Tree {
		return Manifest{}, errors.New("release manifest does not match the trusted candidate")
	}
	if manifest.StateSchemaVersion < 1 || manifest.ControlPlaneProtocolVersion < 1 || manifest.WorkerProtocolVersion < 1 {
		return Manifest{}, errors.New("release manifest has invalid compatibility versions")
	}
	if len(manifest.Artifacts) < 3 {
		return Manifest{}, errors.New("release manifest is missing required artifacts")
	}
	for relative, expected := range manifest.Artifacts {
		if filepath.IsAbs(relative) || filepath.Clean(relative) != relative || strings.HasPrefix(relative, "..") ||
			strings.ContainsAny(relative, "\\\x00") || !digestSHA.MatchString(expected) ||
			(relative != "bin/zenchron" && relative != "bin/zenchron-worker" && !strings.HasPrefix(relative, "dashboard/")) {
			return Manifest{}, fmt.Errorf("invalid release artifact entry %q", relative)
		}
		artifact, err := regularArtifact(releaseDir, relative)
		if err != nil {
			return Manifest{}, fmt.Errorf("verify release artifact %s: %w", relative, err)
		}
		actual, err := fileDigest(artifact)
		if err != nil {
			return Manifest{}, fmt.Errorf("verify release artifact %s: %w", relative, err)
		}
		if actual != expected {
			return Manifest{}, fmt.Errorf("release artifact digest mismatch for %s", relative)
		}
	}
	for _, required := range []string{"bin/zenchron", "bin/zenchron-worker", "dashboard/index.html"} {
		if _, ok := manifest.Artifacts[required]; !ok {
			return Manifest{}, fmt.Errorf("release manifest omits %s", required)
		}
	}
	if err := filepath.WalkDir(filepath.Join(releaseDir, "dashboard"), func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("dashboard contains unsupported artifact %s", path)
		}
		relative, err := filepath.Rel(releaseDir, path)
		if err != nil {
			return err
		}
		if _, ok := manifest.Artifacts[filepath.ToSlash(relative)]; !ok {
			return fmt.Errorf("release manifest omits dashboard artifact %s", relative)
		}
		return nil
	}); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func regularArtifact(root, relative string) (string, error) {
	current := root
	for _, component := range strings.Split(filepath.FromSlash(relative), string(os.PathSeparator)) {
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("release artifacts may not contain symbolic links")
		}
		if current != filepath.Join(root, relative) && !info.IsDir() {
			return "", errors.New("release artifact path contains a non-directory component")
		}
		if current == filepath.Join(root, relative) && !info.Mode().IsRegular() {
			return "", errors.New("release artifact is not a regular file")
		}
	}
	return current, nil
}

func SetActiveRelease(root, commit string) error {
	if !fullSHA.MatchString(commit) {
		return errors.New("active release must use a full commit SHA")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return fmt.Errorf("create managed installation directory: %w", err)
	}
	temporary := filepath.Join(root, ".active-release.tmp")
	if err := os.WriteFile(temporary, []byte(commit+"\n"), 0o600); err != nil {
		return fmt.Errorf("write active release pointer: %w", err)
	}
	file, err := os.OpenFile(temporary, os.O_RDWR, 0)
	if err != nil {
		os.Remove(temporary)
		return fmt.Errorf("open active release pointer: %w", err)
	}
	if err := file.Sync(); err != nil {
		file.Close()
		os.Remove(temporary)
		return fmt.Errorf("sync active release pointer: %w", err)
	}
	if err := file.Close(); err != nil {
		os.Remove(temporary)
		return fmt.Errorf("close active release pointer: %w", err)
	}
	if err := os.Rename(temporary, filepath.Join(root, "active-release")); err != nil {
		os.Remove(temporary)
		return fmt.Errorf("activate release pointer: %w", err)
	}
	directory, err := os.Open(root)
	if err != nil {
		return fmt.Errorf("open installation directory: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync installation directory: %w", err)
	}
	return nil
}

func ActiveRelease(root string) (string, error) {
	contents, err := os.ReadFile(filepath.Join(root, "active-release"))
	if err != nil {
		return "", err
	}
	commit := strings.TrimSpace(string(contents))
	if !fullSHA.MatchString(commit) {
		return "", errors.New("active release pointer is invalid")
	}
	return commit, nil
}

func RetainReleases(root string, keep ...string) error {
	releases := filepath.Join(root, "releases")
	entries, err := os.ReadDir(releases)
	if err != nil {
		return fmt.Errorf("list managed releases: %w", err)
	}
	active, err := ActiveRelease(root)
	if err != nil {
		return fmt.Errorf("read active release before cleanup: %w", err)
	}
	retained := map[string]bool{active: true}
	for _, revision := range keep {
		if revision != "" {
			if !fullSHA.MatchString(revision) {
				return fmt.Errorf("cannot retain invalid release revision %q", revision)
			}
			retained[revision] = true
		}
	}
	for _, entry := range entries {
		if retained[entry.Name()] || !fullSHA.MatchString(entry.Name()) {
			continue
		}
		path := filepath.Join(releases, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			return fmt.Errorf("inspect old release %s: %w", entry.Name(), err)
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing to prune non-directory release %s", entry.Name())
		}
		if err := makeWritableDirectories(path); err != nil {
			return fmt.Errorf("prepare old release %s for cleanup: %w", entry.Name(), err)
		}
		if err := os.RemoveAll(path); err != nil {
			return fmt.Errorf("remove old release %s: %w", entry.Name(), err)
		}
	}
	return nil
}

func makeWritableDirectories(root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return os.Chmod(path, 0o700)
		}
		return nil
	})
}

func run(ctx context.Context, directory, name string, environment []string, args ...string) error {
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = directory
	command.Env = environment
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s failed: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}

func gitOutput(ctx context.Context, directory string, environment []string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, "git", args...)
	command.Dir = directory
	command.Env = environment
	output, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(string(output)), nil
}

func fileDigest(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open artifact %s: %w", path, err)
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", fmt.Errorf("hash artifact %s: %w", path, err)
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func addTreeDigests(root, prefix string, artifacts map[string]string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("release contains unsupported dashboard artifact %s", path)
		}
		relative, err := filepath.Rel(filepath.Dir(root), path)
		if err != nil {
			return err
		}
		digest, err := fileDigest(path)
		if err != nil {
			return err
		}
		artifacts[filepath.ToSlash(filepath.Join(prefix, strings.TrimPrefix(relative, filepath.Base(root)+string(os.PathSeparator))))] = digest
		return nil
	})
}

func writeManifest(path string, manifest Manifest) error {
	contents, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode release manifest: %w", err)
	}
	if err := os.WriteFile(path, append(contents, '\n'), 0o444); err != nil {
		return fmt.Errorf("write release manifest: %w", err)
	}
	return nil
}

func makeReadOnly(root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		mode := os.FileMode(0o444)
		if entry.IsDir() {
			mode = 0o555
		} else if strings.HasPrefix(filepath.ToSlash(path), filepath.ToSlash(filepath.Join(root, "bin"))+"/") {
			mode = 0o555
		}
		if err := os.Chmod(path, mode); err != nil {
			return fmt.Errorf("make %s read-only: %w", path, err)
		}
		return nil
	})
}
