package exec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

func TestSetEnv_WritesSessionBucket(t *testing.T) {
	tmp := t.TempDir()
	step := plan.Step{
		Action: "set_env",
		Args:   map[string]any{"name": "CUDA_HOME", "value": "/opt/cuda-12.1"},
	}
	if err := SetEnv(SetEnvOpts{BootDir: tmp}, step); err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(tmp, "runtime", _envFileName))
	if err != nil {
		t.Fatalf("env file: %v", err)
	}
	var got map[string]map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got["session"]["CUDA_HOME"] != "/opt/cuda-12.1" {
		t.Errorf("session bucket = %+v", got["session"])
	}
}

func TestSetEnv_AppendsToExistingFile(t *testing.T) {
	tmp := t.TempDir()
	first := plan.Step{
		Action: "set_env",
		Args:   map[string]any{"name": "A", "value": "1"},
	}
	second := plan.Step{
		Action: "set_env",
		Args:   map[string]any{"name": "B", "value": "2"},
	}
	if err := SetEnv(SetEnvOpts{BootDir: tmp}, first); err != nil {
		t.Fatal(err)
	}
	if err := SetEnv(SetEnvOpts{BootDir: tmp}, second); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(tmp, "runtime", _envFileName))
	var got map[string]map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got["session"]["A"] != "1" || got["session"]["B"] != "2" {
		t.Errorf("session bucket = %+v", got["session"])
	}
}

func TestSetEnv_RejectsUnknownScope(t *testing.T) {
	tmp := t.TempDir()
	step := plan.Step{
		Action: "set_env",
		Args:   map[string]any{"name": "X", "value": "y", "scope": "bogus"},
	}
	if err := SetEnv(SetEnvOpts{BootDir: tmp}, step); err == nil {
		t.Fatal("expected error for unknown scope")
	}
}

func TestSetEnv_MissingArgsFail(t *testing.T) {
	tmp := t.TempDir()
	for label, args := range map[string]map[string]any{
		"missing name":  {"value": "x"},
		"missing value": {"name": "x"},
	} {
		t.Run(label, func(t *testing.T) {
			err := SetEnv(SetEnvOpts{BootDir: tmp},
				plan.Step{Action: "set_env", Args: args})
			if err == nil {
				t.Fatalf("%s: expected error", label)
			}
		})
	}
}
