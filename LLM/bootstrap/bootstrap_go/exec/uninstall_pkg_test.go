package exec

import (
	"reflect"
	"testing"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

func TestUninstallPkg_BuildsExpectedPipCommand(t *testing.T) {
	calls, runner := newFakeRunner(nil)
	step := plan.Step{
		Action: "uninstall_pkg",
		Args:   map[string]any{"name": "torch==2.5.1+cu121"},
	}
	if err := UninstallPkg(UninstallPkgOpts{VenvDir: "/tmp/v", Runner: runner}, step); err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(*calls) != 1 {
		t.Fatalf("got %d calls, want 1", len(*calls))
	}
	wantArgs := []string{
		"-m", "pip", "uninstall", "--yes",
		"--disable-pip-version-check",
		"torch", // version stripped
	}
	if !reflect.DeepEqual((*calls)[0].args, wantArgs) {
		t.Errorf("args = %v\nwant %v", (*calls)[0].args, wantArgs)
	}
}

func TestUninstallPkg_NoVenvFails(t *testing.T) {
	step := plan.Step{Action: "uninstall_pkg", Args: map[string]any{"name": "torch"}}
	if err := UninstallPkg(UninstallPkgOpts{VenvDir: ""}, step); err == nil {
		t.Fatal("expected error when VenvDir is empty")
	}
}

func TestUninstallPkg_MissingNameFails(t *testing.T) {
	_, runner := newFakeRunner(nil)
	err := UninstallPkg(UninstallPkgOpts{VenvDir: "/tmp/v", Runner: runner},
		plan.Step{Action: "uninstall_pkg", Args: map[string]any{}})
	if err == nil {
		t.Fatal("expected error when name missing")
	}
}
