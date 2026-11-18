package updater

import (
	"path/filepath"
	"testing"
)

func TestWriteStatusPersistsReadableUpdateState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "system-update.json")
	want := Status{RunningRevision: "0123456789abcdef0123456789abcdef01234567", State: "blocked",
		BlockReason: "activation recovery requires operator intervention"}
	if err := WriteStatus(path, want); err != nil {
		t.Fatal(err)
	}
	got, err := ReadStatus(path)
	if err != nil || got != want {
		t.Fatalf("persisted update status = %#v, %v; want %#v", got, err, want)
	}
}
