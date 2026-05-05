package exec

import (
	"reflect"
	"testing"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

func TestStrippedPackageName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"torch", "torch"},
		{"torch==2.5.1", "torch"},
		{"torch==2.5.1+cu121", "torch"},
		{"torch>=2.4", "torch"},
		{"foo[a,b]", "foo"},
		{"foo[a,b]==1.0", "foo"},
		{"foo[a]", "foo"},
		{"  spaced  ", "spaced"},
	}
	for _, c := range cases {
		if got := strippedPackageName(c.in); got != c.want {
			t.Errorf("strippedPackageName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSwapWheel_RunsUninstallThenInstall(t *testing.T) {
	calls, runner := newFakeRunner(nil)
	step := plan.Step{
		Action: "swap_wheel",
		Args: map[string]any{
			"name":         "torch",
			"from_version": "2.5.1+cu121",
			"to_version":   "2.4.1+cu118",
			"index":        "https://download.pytorch.org/whl/cu118",
		},
	}
	if err := SwapWheel(SwapWheelOpts{VenvDir: "/tmp/v", Runner: runner}, step); err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(*calls) != 2 {
		t.Fatalf("got %d calls, want 2 (uninstall + install)", len(*calls))
	}

	// First call: uninstall <name-without-version> --yes
	wantUninstall := []string{
		"-m", "pip", "uninstall", "--yes",
		"--disable-pip-version-check",
		"torch",
	}
	if !reflect.DeepEqual((*calls)[0].args, wantUninstall) {
		t.Errorf("uninstall args = %v\nwant %v", (*calls)[0].args, wantUninstall)
	}

	// Second call: install with target version + custom index.
	wantInstall := []string{
		"-m", "pip", "install",
		"--no-input", "--disable-pip-version-check",
		"torch==2.4.1+cu118",
		"--index-url", "https://download.pytorch.org/whl/cu118",
	}
	if !reflect.DeepEqual((*calls)[1].args, wantInstall) {
		t.Errorf("install args = %v\nwant %v", (*calls)[1].args, wantInstall)
	}
}

func TestSwapWheel_StripsVersionFromUninstallTarget(t *testing.T) {
	// If the model emits a name like "torch==2.5.1" we should still
	// pass bare "torch" to pip uninstall.
	calls, runner := newFakeRunner(nil)
	step := plan.Step{
		Action: "swap_wheel",
		Args: map[string]any{
			"name":       "torch==2.5.1+cu121",
			"to_version": "2.4.1+cu118",
		},
	}
	if err := SwapWheel(SwapWheelOpts{VenvDir: "/tmp/v", Runner: runner}, step); err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(*calls) != 2 {
		t.Fatalf("got %d calls", len(*calls))
	}
	if got := (*calls)[0].args[len((*calls)[0].args)-1]; got != "torch" {
		t.Errorf("uninstall target = %q, want \"torch\"", got)
	}
}

func TestSwapWheel_NoVenvFails(t *testing.T) {
	step := plan.Step{
		Action: "swap_wheel",
		Args:   map[string]any{"name": "x", "to_version": "1"},
	}
	if err := SwapWheel(SwapWheelOpts{VenvDir: ""}, step); err == nil {
		t.Fatal("expected error when venv is empty")
	}
}

func TestSwapWheel_MissingArgsFail(t *testing.T) {
	_, runner := newFakeRunner(nil)
	cases := map[string]map[string]any{
		"missing name":       {"to_version": "1"},
		"missing to_version": {"name": "torch"},
	}
	for label, args := range cases {
		t.Run(label, func(t *testing.T) {
			err := SwapWheel(SwapWheelOpts{VenvDir: "/tmp/v", Runner: runner},
				plan.Step{Action: "swap_wheel", Args: args})
			if err == nil {
				t.Fatalf("%s: expected error", label)
			}
		})
	}
}
