package main

import "testing"

// seedOriginMain publishes the checkout's main to a bare origin and makes it the default branch, as GitHub
// always has one; runs refuse to start unless the local base equals it.
func seedOriginMain(t *testing.T, repository, bare string) {
	t.Helper()
	runGit(t, repository, "push", "--quiet", bare, "main:refs/heads/main")
	runGit(t, bare, "symbolic-ref", "HEAD", "refs/heads/main")
}
