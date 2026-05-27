// install_pkg: pip-install one package into the venv.
//
// Args (model-provided):
//   name:    package name (required, e.g. "torch")
//   version: optional version pin (e.g. "2.5.1+cu121")
//   index:   optional --index-url (e.g. "https://download.pytorch.org/whl/cu121")
//   extras:  optional list of extras (e.g. ["dev", "test"])
//
// Idempotence:
//   - If the package is already installed at the requested version, no-op.
//   - If installed at a different version and `version` was specified,
//     pip's resolver will upgrade/downgrade as part of the install.
//
// We intentionally use --no-input to avoid pip prompting for credentials
// or anything else (the bootstrap runs unattended).
package exec

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

// InstallPkgOpts ties install_pkg to a specific venv. The dispatcher
// owns "what venv are we using right now" -- it threads VenvDir down
// to each executor that needs a Python interpreter.
type InstallPkgOpts struct {
	VenvDir string    // required
	Runner  CmdRunner // optional; nil -> real os/exec
}

// InstallPkg builds a `python -m pip install` invocation from the args
// and runs it in the venv. Returns nil on success.
func InstallPkg(opts InstallPkgOpts, s plan.Step) error {
	if opts.VenvDir == "" {
		return fmt.Errorf("install_pkg: no venv configured (run create_venv first)")
	}
	name, err := argRequired(s.Args, "name")
	if err != nil {
		return fmt.Errorf("install_pkg: %w", err)
	}
	version, _ := argString(s.Args, "version")
	index, _ := argString(s.Args, "index")
	extras, _ := argStringSlice(s.Args, "extras")

	spec := buildPipSpec(name, version, extras)
	args := []string{"-m", "pip", "install", "--no-input", "--disable-pip-version-check", spec}
	if index != "" {
		args = append(args, "--index-url", index)
	}

	pyExe := PythonExePath(opts.VenvDir)
	log.Printf("  install_pkg: %s -> %s", spec, pyExe)

	runner := opts.Runner
	if runner == nil {
		runner = realRunner
	}
	if err := runner(context.Background(), 600*time.Second, pyExe, args...); err != nil {
		return fmt.Errorf("install_pkg: pip install %s failed: %w", spec, err)
	}
	return nil
}

// buildPipSpec composes a pip requirement string. Public for unit tests.
//
// Examples:
//   ("torch", "",         nil)        -> "torch"
//   ("torch", "2.5.1",    nil)        -> "torch==2.5.1"
//   ("torch", "2.5.1+cu121", nil)     -> "torch==2.5.1+cu121"
//   ("foo",   "",         []{"a","b"})-> "foo[a,b]"
//   ("foo",   "1.0",      []{"a"})    -> "foo[a]==1.0"
//
// The model occasionally encodes the version in the name itself
// ("torch==2.5.1+cu121"). We detect that and don't double-suffix.
func buildPipSpec(name, version string, extras []string) string {
	hasInlineVersion := strings.ContainsAny(name, "=<>~!")
	if hasInlineVersion {
		return name
	}
	out := name
	if len(extras) > 0 {
		out += "[" + strings.Join(extras, ",") + "]"
	}
	if version != "" {
		out += "==" + version
	}
	return out
}
