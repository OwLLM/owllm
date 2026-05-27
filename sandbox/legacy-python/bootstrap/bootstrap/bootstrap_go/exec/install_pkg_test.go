package exec

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

func TestBuildPipSpec(t *testing.T) {
	cases := []struct {
		name, version string
		extras        []string
		want          string
	}{
		{"torch", "", nil, "torch"},
		{"torch", "2.5.1", nil, "torch==2.5.1"},
		{"torch", "2.5.1+cu121", nil, "torch==2.5.1+cu121"},
		{"foo", "", []string{"a", "b"}, "foo[a,b]"},
		{"foo", "1.0", []string{"a"}, "foo[a]==1.0"},
		// Inline version markers passthrough -- model already encoded them.
		{"torch>=2.4", "", nil, "torch>=2.4"},
		{"torch==2.5.1", "ignored", nil, "torch==2.5.1"},
	}
	for _, c := range cases {
		got := buildPipSpec(c.name, c.version, c.extras)
		if got != c.want {
			t.Errorf("buildPipSpec(%q,%q,%v) = %q, want %q",
				c.name, c.version, c.extras, got, c.want)
		}
	}
}

// fakeRunner records the (bin, args) it was called with.
type capturedCall struct {
	bin  string
	args []string
}

func newFakeRunner(err error) (*[]capturedCall, CmdRunner) {
	calls := []capturedCall{}
	runner := func(_ context.Context, _ time.Duration, bin string, args ...string) error {
		calls = append(calls, capturedCall{bin: bin, args: append([]string{}, args...)})
		return err
	}
	return &calls, runner
}

func TestInstallPkg_BuildsExpectedPipCommand(t *testing.T) {
	calls, runner := newFakeRunner(nil)
	step := plan.Step{
		Action: "install_pkg",
		Args: map[string]any{
			"name":    "torch",
			"version": "2.5.1+cu121",
			"index":   "https://download.pytorch.org/whl/cu121",
		},
	}
	err := InstallPkg(InstallPkgOpts{VenvDir: "/tmp/venv", Runner: runner}, step)
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(*calls) != 1 {
		t.Fatalf("got %d calls, want 1", len(*calls))
	}
	got := (*calls)[0]
	wantArgs := []string{
		"-m", "pip", "install",
		"--no-input", "--disable-pip-version-check",
		"torch==2.5.1+cu121",
		"--index-url", "https://download.pytorch.org/whl/cu121",
	}
	if !reflect.DeepEqual(got.args, wantArgs) {
		t.Errorf("args = %v\nwant %v", got.args, wantArgs)
	}
}

func TestInstallPkg_NoVenvFails(t *testing.T) {
	step := plan.Step{Action: "install_pkg", Args: map[string]any{"name": "torch"}}
	err := InstallPkg(InstallPkgOpts{VenvDir: ""}, step)
	if err == nil {
		t.Fatal("expected error when VenvDir is empty")
	}
}

func TestInstallPkg_MissingNameFails(t *testing.T) {
	_, runner := newFakeRunner(nil)
	step := plan.Step{Action: "install_pkg", Args: map[string]any{}}
	err := InstallPkg(InstallPkgOpts{VenvDir: "/tmp/v", Runner: runner}, step)
	if err == nil {
		t.Fatal("expected error when name missing")
	}
}
