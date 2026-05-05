// swap_wheel: replace an installed package with a different version.
//
// This is the action the model emits when the rule-based path picked
// the wrong wheel for the user's hardware -- e.g. profile shipped
// torch==2.5.1+cu121 but the GPU/driver only supports CUDA 11.8, so
// the model proposes:
//
//   { "action": "swap_wheel",
//     "args": { "name": "torch",
//               "from_version": "2.5.1+cu121",
//               "to_version":   "2.4.1+cu118",
//               "index": "https://download.pytorch.org/whl/cu118" } }
//
// Args:
//   name           required -- package name
//   to_version     required -- the version we want
//   from_version   optional -- only used in the log line; pip's
//                  resolver doesn't need it. Keeping it in the schema
//                  because the model's reasoning is more grounded
//                  when it has to name the version it's replacing.
//   index          optional -- --index-url for the install half
//   extras         optional -- forwarded to install_pkg's spec builder
//
// Implementation: uninstall (idempotent, --yes), then install at the
// target version. Two pip invocations, both running in the active
// venv. If uninstall reports "package not installed" we proceed anyway
// -- that's the same end state we wanted.
//
// Idempotence: if the package is already at to_version, both pip
// commands run but pip will no-op the install. Net cost is one
// uninstall+reinstall round-trip; acceptable for an action that
// fires only when the model's already decided a swap is needed.
package exec

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

type SwapWheelOpts struct {
	VenvDir string
	Runner  CmdRunner
}

func SwapWheel(opts SwapWheelOpts, s plan.Step) error {
	if opts.VenvDir == "" {
		return fmt.Errorf("swap_wheel: no venv configured (run create_venv first)")
	}
	name, err := argRequired(s.Args, "name")
	if err != nil {
		return fmt.Errorf("swap_wheel: %w", err)
	}
	toVersion, err := argRequired(s.Args, "to_version")
	if err != nil {
		return fmt.Errorf("swap_wheel: %w", err)
	}
	fromVersion, _ := argString(s.Args, "from_version")
	index, _ := argString(s.Args, "index")
	extras, _ := argStringSlice(s.Args, "extras")

	pyExe := PythonExePath(opts.VenvDir)
	runner := opts.Runner
	if runner == nil {
		runner = realRunner
	}

	if fromVersion != "" {
		log.Printf("  swap_wheel: %s %s -> %s", name, fromVersion, toVersion)
	} else {
		log.Printf("  swap_wheel: %s -> %s", name, toVersion)
	}

	// 1. Uninstall. --yes skips the confirmation prompt; pip exits 0
	// when the package isn't installed AND --yes is set, so we don't
	// need to special-case "not installed".
	uninstallArgs := []string{
		"-m", "pip", "uninstall", "--yes",
		"--disable-pip-version-check",
		strippedPackageName(name),
	}
	if err := runner(context.Background(), 120*time.Second, pyExe, uninstallArgs...); err != nil {
		return fmt.Errorf("swap_wheel: uninstall %s failed: %w",
			strippedPackageName(name), err)
	}

	// 2. Install at the target version. Reuse install_pkg's spec
	// builder so the wire format stays consistent with install_pkg.
	spec := buildPipSpec(name, toVersion, extras)
	installArgs := []string{
		"-m", "pip", "install",
		"--no-input", "--disable-pip-version-check",
		spec,
	}
	if index != "" {
		installArgs = append(installArgs, "--index-url", index)
	}
	if err := runner(context.Background(), 600*time.Second, pyExe, installArgs...); err != nil {
		return fmt.Errorf("swap_wheel: install %s failed: %w", spec, err)
	}
	return nil
}

// strippedPackageName returns just the distribution name, stripping any
// version markers or extras that the model may have inlined into `name`.
// pip uninstall takes a bare distribution name.
//
//   torch==2.5.1+cu121  -> torch
//   torch>=2.4          -> torch
//   foo[a,b]            -> foo
//   torch               -> torch
func strippedPackageName(name string) string {
	// Strip extras first ("foo[a,b]==1" -> "foo==1" -> later "foo").
	if i := strings.IndexByte(name, '['); i >= 0 {
		// Find the closing ']' and drop the bracket section entirely.
		if j := strings.IndexByte(name[i:], ']'); j >= 0 {
			name = name[:i] + name[i+j+1:]
		}
	}
	// Strip everything from the first version marker onward.
	for _, m := range []string{"==", ">=", "<=", "~=", "!=", ">", "<"} {
		if i := strings.Index(name, m); i >= 0 {
			name = name[:i]
			break
		}
	}
	return strings.TrimSpace(name)
}
