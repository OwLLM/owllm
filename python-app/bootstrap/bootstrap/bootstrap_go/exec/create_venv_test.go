package exec

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

func TestIsExistingVenv_Detects(t *testing.T) {
	tmp := t.TempDir()
	v := filepath.Join(tmp, "v")
	if IsExistingVenv(v) {
		t.Fatal("empty dir should not look like a venv")
	}

	// Build the minimal layout the detector recognizes.
	if err := os.MkdirAll(filepath.Join(v, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(v, "Scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(v, "pyvenv.cfg"), []byte("home=...\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Touch the platform-appropriate python file the detector looks for.
	pyExe := PythonExePath(v)
	if err := os.MkdirAll(filepath.Dir(pyExe), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pyExe, []byte{}, 0o755); err != nil {
		t.Fatal(err)
	}

	if !IsExistingVenv(v) {
		t.Errorf("layout with pyvenv.cfg + python should be detected as venv")
	}
}

func TestCreateVenv_IdempotentSkipsExisting(t *testing.T) {
	tmp := t.TempDir()
	target := filepath.Join(tmp, "v")
	if err := os.MkdirAll(filepath.Dir(PythonExePath(target)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "pyvenv.cfg"), []byte("home=...\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(PythonExePath(target), []byte{}, 0o755); err != nil {
		t.Fatal(err)
	}

	// Runner that always errors -- if CreateVenv reaches it, the
	// idempotence check failed.
	runnerInvoked := false
	runner := func(_ context.Context, _ time.Duration, _ string, _ ...string) error {
		runnerInvoked = true
		return nil
	}

	step := plan.Step{Action: "create_venv", Args: map[string]any{"path": target}}
	got, err := CreateVenv(CreateVenvOpts{BootDir: tmp, Runner: runner}, step)
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if got != target {
		t.Errorf("got %q want %q", got, target)
	}
	if runnerInvoked {
		t.Error("runner should not be called when venv already exists")
	}
}

func TestCreateVenv_RefusesToClobberNonVenvDir(t *testing.T) {
	tmp := t.TempDir()
	target := filepath.Join(tmp, "occupied")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "important.txt"), []byte("don't lose me"), 0o644); err != nil {
		t.Fatal(err)
	}

	step := plan.Step{Action: "create_venv", Args: map[string]any{"path": target}}
	_, err := CreateVenv(CreateVenvOpts{BootDir: tmp}, step)
	if err == nil {
		t.Fatal("expected refuse-to-clobber error")
	}
}
