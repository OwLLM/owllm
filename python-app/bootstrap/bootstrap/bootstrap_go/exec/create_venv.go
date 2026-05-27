// create_venv: build a Python venv at the configured target path.
//
// Args (model-provided):
//   path:           filesystem path for the venv (default: <bootstrap>/venv)
//   python_version: cosmetic only -- the bootstrap doesn't carry multiple
//                   pythons. We log the requested version and use whichever
//                   `python` we can find. Future: cross-reference with
//                   bundled python_runtime/.
//
// Idempotent: if the target already contains a working venv (pyvenv.cfg
// present and the interpreter file exists), this is a no-op success.
//
// Failure modes:
//   - python not on PATH and no bundled runtime  -> abort with hint
//   - target exists but isn't a venv             -> abort, don't clobber
package exec

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

// CreateVenvOpts captures everything needed to run create_venv. Tests
// inject a fake `runner` to verify the command line without spawning.
type CreateVenvOpts struct {
	BootDir string
	Runner  CmdRunner // optional; nil -> real os/exec
}

// PythonExePath returns the in-venv python executable path for `venv`.
// Public so the install_pkg executor can reuse it.
func PythonExePath(venv string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(venv, "Scripts", "python.exe")
	}
	return filepath.Join(venv, "bin", "python")
}

// IsExistingVenv returns true if `path` looks like an already-built venv.
func IsExistingVenv(path string) bool {
	if path == "" {
		return false
	}
	if _, err := os.Stat(filepath.Join(path, "pyvenv.cfg")); err != nil {
		return false
	}
	if _, err := os.Stat(PythonExePath(path)); err != nil {
		return false
	}
	return true
}

// CreateVenv runs `python -m venv <path>`. Returns the path created.
func CreateVenv(opts CreateVenvOpts, s plan.Step) (string, error) {
	target, _ := argString(s.Args, "path")
	if target == "" {
		target = filepath.Join(opts.BootDir, "venv")
	}
	pythonVer, _ := argString(s.Args, "python_version")

	// Idempotence: bail out cleanly if already a venv.
	if IsExistingVenv(target) {
		log.Printf("  create_venv: %s already a venv -- skipping", target)
		return target, nil
	}

	// Refuse to clobber a non-venv directory.
	if _, err := os.Stat(target); err == nil {
		entries, _ := os.ReadDir(target)
		if len(entries) > 0 {
			return "", fmt.Errorf(
				"create_venv: %s exists and is not a venv "+
					"(refusing to clobber non-venv content)", target,
			)
		}
	}

	// Discover a python interpreter. Prefer the bundled one if present.
	pyExe, err := findHostPython(opts.BootDir)
	if err != nil {
		return "", fmt.Errorf("create_venv: %w", err)
	}
	log.Printf("  create_venv: using %s (requested version=%q) -> %s",
		pyExe, pythonVer, target)

	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", fmt.Errorf("create_venv: mkdir parent: %w", err)
	}

	runner := opts.Runner
	if runner == nil {
		runner = realRunner
	}
	if err := runner(context.Background(), 120*time.Second,
		pyExe, "-m", "venv", target); err != nil {
		return "", fmt.Errorf("create_venv: python -m venv failed: %w", err)
	}
	if !IsExistingVenv(target) {
		return "", fmt.Errorf("create_venv: post-creation check failed at %s", target)
	}
	return target, nil
}

// findHostPython picks the python interpreter to use for venv creation.
//   - $LOCALLLM_HOST_PYTHON env override                    (highest priority)
//   - bundled <bootDir>/../python_runtime/python3.11/python(.exe)
//   - "python" or "python3" on PATH                         (last resort)
func findHostPython(bootDir string) (string, error) {
	if v := os.Getenv("LOCALLLM_HOST_PYTHON"); v != "" {
		if _, err := os.Stat(v); err == nil {
			return v, nil
		}
	}
	// Bundled runtime ships next to the bootstrap, parallel with bootstrap_go/.
	bundled := filepath.Join(filepath.Dir(bootDir), "python_runtime", "python3.11")
	candidates := []string{filepath.Join(bundled, "python.exe"), filepath.Join(bundled, "python")}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c, nil
		}
	}
	for _, name := range []string{"python", "python3"} {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("no python interpreter found (set LOCALLLM_HOST_PYTHON)")
}
