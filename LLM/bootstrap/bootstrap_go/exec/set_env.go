// set_env: persist an environment variable that the desktop app reads
// on startup.
//
// Why not os.Setenv: we want the variable to survive past
// bootstrap.exe -- the desktop app launches as a separate process.
// Modifying machine-wide PATH/env is invasive and error-prone, so we
// instead write to a per-app config file at:
//
//   <bootDir>/runtime/bootstrap_env.json
//
// The desktop app reads this file at startup (via a tiny loader in
// core/supervisor or similar -- TBD on the Python side) and applies
// the values to its own os.environ. This keeps env mutation strictly
// inside OWLLM, with no side effects on the rest of the system.
//
// Args:
//   name   required -- env var name (e.g. "CUDA_HOME")
//   value  required -- string value
//   scope  optional -- "session" (default) or "user" or "machine".
//          Phase 0 only honors "session" (the JSON file). "user" and
//          "machine" are recorded but a follow-up will wire them
//          through to setx / HKCU registry entries.
package exec

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

const _envFileName = "bootstrap_env.json"

type SetEnvOpts struct {
	BootDir string
}

// SetEnv merges {name: value} into bootstrap_env.json under BootDir.
func SetEnv(opts SetEnvOpts, s plan.Step) error {
	name, err := argRequired(s.Args, "name")
	if err != nil {
		return fmt.Errorf("set_env: %w", err)
	}
	value, err := argRequired(s.Args, "value")
	if err != nil {
		return fmt.Errorf("set_env: %w", err)
	}
	scope, _ := argString(s.Args, "scope")
	if scope == "" {
		scope = "session"
	}
	if scope != "session" && scope != "user" && scope != "machine" {
		return fmt.Errorf("set_env: unknown scope %q", scope)
	}
	if scope != "session" {
		// Recorded but not yet applied -- fail loudly so the model
		// learns this avenue isn't ready, rather than silently
		// pretending to set machine-wide env.
		log.Printf("  set_env: scope=%q recorded only; "+
			"machine/user scope wiring not yet implemented", scope)
	}

	envPath := filepath.Join(opts.BootDir, "runtime", _envFileName)

	current := map[string]any{}
	if data, err := os.ReadFile(envPath); err == nil {
		_ = json.Unmarshal(data, &current)
	}

	// Stash under "session" / "user" / "machine" keys so the desktop
	// app can decide which buckets it honors.
	bucket, _ := current[scope].(map[string]any)
	if bucket == nil {
		bucket = map[string]any{}
	}
	bucket[name] = value
	current[scope] = bucket

	if err := os.MkdirAll(filepath.Dir(envPath), 0o755); err != nil {
		return fmt.Errorf("set_env: mkdir: %w", err)
	}
	out, err := json.MarshalIndent(current, "", "  ")
	if err != nil {
		return fmt.Errorf("set_env: marshal: %w", err)
	}
	if err := os.WriteFile(envPath, out, 0o644); err != nil {
		return fmt.Errorf("set_env: write: %w", err)
	}
	log.Printf("  set_env: %s=%q (scope=%s)", name, value, scope)
	return nil
}
