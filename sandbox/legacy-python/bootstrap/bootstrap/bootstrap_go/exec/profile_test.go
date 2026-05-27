package exec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

const _sampleProfileTable = `{
  "version": 1,
  "profiles": [
    {
      "id": "cuda121-torch25",
      "description": "NVIDIA Ampere/Ada/Hopper",
      "match": {"gpu.0.vendor": "nvidia"},
      "steps": [
        {"action": "create_venv", "args": {"python_version": "3.11"}},
        {"action": "install_pkg", "args": {"name": "torch==2.5.1+cu121"}}
      ]
    },
    {
      "id": "cpu-only",
      "description": "fallback",
      "match": {"gpu.0.vendor": "none"},
      "steps": [
        {"action": "create_venv", "args": {"python_version": "3.11"}}
      ]
    }
  ]
}`

func writeProfiles(t *testing.T, dir, body string) {
	t.Helper()
	recipes := filepath.Join(dir, "recipes")
	if err := os.MkdirAll(recipes, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(recipes, "hardware_profiles.json"),
		[]byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadProfileTable_Parses(t *testing.T) {
	tmp := t.TempDir()
	writeProfiles(t, tmp, _sampleProfileTable)
	tbl, err := LoadProfileTable(tmp)
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if tbl.Version != 1 {
		t.Errorf("version=%d", tbl.Version)
	}
	if len(tbl.Profiles) != 2 {
		t.Fatalf("got %d profiles", len(tbl.Profiles))
	}
}

func TestLoadProfileTable_MissingFileNotAnError(t *testing.T) {
	tbl, err := LoadProfileTable(t.TempDir())
	if err != nil {
		t.Fatalf("missing file should not error: %v", err)
	}
	if len(tbl.Profiles) != 0 {
		t.Errorf("expected empty table, got %d", len(tbl.Profiles))
	}
}

func TestLoadProfileTable_InvalidJSONErrors(t *testing.T) {
	tmp := t.TempDir()
	writeProfiles(t, tmp, "{ not json")
	if _, err := LoadProfileTable(tmp); err == nil {
		t.Fatal("expected parse error")
	}
}

func TestFindProfile(t *testing.T) {
	var tbl ProfileTable
	if err := json.Unmarshal([]byte(_sampleProfileTable), &tbl); err != nil {
		t.Fatal(err)
	}
	if p, ok := tbl.FindProfile("cpu-only"); !ok || p.ID != "cpu-only" {
		t.Errorf("got %+v ok=%v", p, ok)
	}
	if _, ok := tbl.FindProfile("does-not-exist"); ok {
		t.Errorf("unknown id should not match")
	}
}

// ---- pick_profile via the Executor ----

func TestPickProfile_DryRunWalksSubSteps(t *testing.T) {
	tmp := t.TempDir()
	writeProfiles(t, tmp, _sampleProfileTable)

	e := New(true /* dryRun */, nil, nil, nil)
	e.SetBootDir(tmp)

	step := newStep("pick_profile", map[string]any{"profile_id": "cuda121-torch25"})
	if err := e.dispatch(step); err != nil {
		t.Fatalf("unexpected: %v", err)
	}
}

func TestPickProfile_UnknownProfileFails(t *testing.T) {
	tmp := t.TempDir()
	writeProfiles(t, tmp, _sampleProfileTable)

	e := New(true, nil, nil, nil)
	e.SetBootDir(tmp)

	err := e.dispatch(newStep("pick_profile", map[string]any{"profile_id": "nope"}))
	if err == nil {
		t.Fatal("expected error for unknown profile id")
	}
}

func TestPickProfile_MissingProfileIdFails(t *testing.T) {
	tmp := t.TempDir()
	writeProfiles(t, tmp, _sampleProfileTable)

	e := New(true, nil, nil, nil)
	e.SetBootDir(tmp)

	err := e.dispatch(newStep("pick_profile", map[string]any{}))
	if err == nil {
		t.Fatal("expected error for missing profile_id")
	}
}

func TestPickProfile_RecursionGuardRefusesNested(t *testing.T) {
	// A profile whose steps include another pick_profile should fail
	// with the recursion-guard error.
	tmp := t.TempDir()
	writeProfiles(t, tmp, `{
      "version": 1,
      "profiles": [
        {"id": "outer", "description": "x", "match": {},
         "steps": [{"action": "pick_profile", "args": {"profile_id": "inner"}}]},
        {"id": "inner", "description": "y", "match": {},
         "steps": [{"action": "create_venv", "args": {"python_version": "3.11"}}]}
      ]
    }`)
	e := New(false /* not dry-run, so the inner dispatch executes */, nil, nil, nil)
	e.SetBootDir(tmp)

	err := e.dispatch(newStep("pick_profile", map[string]any{"profile_id": "outer"}))
	if err == nil {
		t.Fatal("expected nested-profile error")
	}
}

// ---- helper ----

func newStep(action string, args map[string]any) plan.Step {
	return plan.Step{Action: action, Args: args}
}
