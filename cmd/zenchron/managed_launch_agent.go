package main

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func managedLaunchAgentPlistPath() (string, error) {
	userHome, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve user home: %w", err)
	}
	return filepath.Join(userHome, "Library", "LaunchAgents", managedLaunchAgentLabel+".plist"), nil
}

func launchAgentEnvironmentBounds(contents []byte) (int, int, error) {
	// ponytail: parse renderLaunchAgent's flat plist only; use a plist parser if external formats are supported.
	const marker = "<key>EnvironmentVariables</key><dict>"
	start := bytes.Index(contents, []byte(marker))
	if start < 0 {
		return 0, 0, errors.New("LaunchAgent environment dictionary is missing")
	}
	bodyStart := start + len(marker)
	endOffset := bytes.Index(contents[bodyStart:], []byte("</dict>"))
	if endOffset < 0 {
		return 0, 0, errors.New("LaunchAgent environment dictionary is incomplete")
	}
	return bodyStart, bodyStart + endOffset, nil
}

func launchAgentStatusCredential(contents []byte) (string, bool, error) {
	start, end, err := launchAgentEnvironmentBounds(contents)
	if err != nil {
		return "", false, err
	}
	const key = "<key>ZENCHRON_LOCAL_STATUS_TOKEN</key>"
	keyOffset := bytes.Index(contents[start:end], []byte(key))
	if keyOffset < 0 {
		return "", false, nil
	}
	valueStart := start + keyOffset + len(key)
	const stringStart = "<string>"
	if !bytes.HasPrefix(contents[valueStart:end], []byte(stringStart)) {
		return "", false, errors.New("LaunchAgent status credential is not a string")
	}
	valueStart += len(stringStart)
	valueEndOffset := bytes.Index(contents[valueStart:end], []byte("</string>"))
	if valueEndOffset < 0 {
		return "", false, errors.New("LaunchAgent status credential is incomplete")
	}
	return string(contents[valueStart : valueStart+valueEndOffset]), true, nil
}

func withLaunchAgentStatusCredential(contents []byte, token string) ([]byte, error) {
	start, end, err := launchAgentEnvironmentBounds(contents)
	if err != nil {
		return nil, err
	}
	const tokenKey = "<key>ZENCHRON_LOCAL_STATUS_TOKEN</key>"
	if keyOffset := bytes.Index(contents[start:end], []byte(tokenKey)); keyOffset >= 0 {
		valueStart := start + keyOffset + len(tokenKey)
		stringStartOffset := bytes.Index(contents[valueStart:end], []byte("<string>"))
		if stringStartOffset < 0 {
			return nil, errors.New("LaunchAgent status credential is not a string")
		}
		stringStart := valueStart + stringStartOffset + len("<string>")
		stringEndOffset := bytes.Index(contents[stringStart:end], []byte("</string>"))
		if stringEndOffset < 0 {
			return nil, errors.New("LaunchAgent status credential is incomplete")
		}
		stringEnd := stringStart + stringEndOffset
		var escaped strings.Builder
		if err := xml.EscapeText(&escaped, []byte(token)); err != nil {
			return nil, err
		}
		updated := make([]byte, 0, len(contents)+escaped.Len())
		updated = append(updated, contents[:stringStart]...)
		updated = append(updated, escaped.String()...)
		updated = append(updated, contents[stringEnd:]...)
		return updated, nil
	}
	var entry strings.Builder
	writePlistString(&entry, "ZENCHRON_LOCAL_STATUS_TOKEN", token)
	updated := make([]byte, 0, len(contents)+entry.Len())
	updated = append(updated, contents[:end]...)
	updated = append(updated, entry.String()...)
	updated = append(updated, contents[end:]...)
	return updated, nil
}
