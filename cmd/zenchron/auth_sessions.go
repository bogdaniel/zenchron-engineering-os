package main

import (
	"fmt"
	"strings"
	"sync"
)

type sessionRevocationState struct {
	Version       int              `json:"version"`
	RevokedBefore map[string]int64 `json:"revoked_before"`
}

type sessionRevocations struct {
	mu            sync.RWMutex
	path          string
	revokedBefore map[string]int64
}

func loadSessionRevocations(path string) (*sessionRevocations, error) {
	state := sessionRevocationState{}
	found, err := loadStateFile(path, &state)
	if err != nil {
		return nil, fmt.Errorf("load session revocations: %w", err)
	}
	if found && state.Version != stateFileVersion {
		return nil, fmt.Errorf("load session revocations: unsupported state version %d", state.Version)
	}
	if state.RevokedBefore == nil {
		state.RevokedBefore = make(map[string]int64)
	}
	return &sessionRevocations{path: path, revokedBefore: state.RevokedBefore}, nil
}

func (revocations *sessionRevocations) revoke(login string, issuedBefore int64) error {
	login = strings.ToLower(login)
	revocations.mu.Lock()
	defer revocations.mu.Unlock()
	previous, existed := revocations.revokedBefore[login]
	if !existed || issuedBefore > previous {
		revocations.revokedBefore[login] = issuedBefore
	}
	if revocations.path == "" {
		return nil
	}
	err := writeStateFile(revocations.path, sessionRevocationState{Version: stateFileVersion, RevokedBefore: revocations.revokedBefore})
	if err == nil {
		return nil
	}
	if existed {
		revocations.revokedBefore[login] = previous
	} else {
		delete(revocations.revokedBefore, login)
	}
	return fmt.Errorf("persist session revocation: %w", err)
}

func (revocations *sessionRevocations) isRevoked(login string, issuedAt int64) bool {
	if revocations == nil {
		return false
	}
	revocations.mu.RLock()
	defer revocations.mu.RUnlock()
	cutoff, ok := revocations.revokedBefore[strings.ToLower(login)]
	return ok && issuedAt <= cutoff
}
