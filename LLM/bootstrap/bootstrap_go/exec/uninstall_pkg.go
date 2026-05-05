// uninstall_pkg: remove a package from the active venv.
//
// Args:
//   name  required -- package distribution name
//
// Idempotent: pip uninstall --yes exits 0 even when the package
// isn't installed.
package exec

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

type UninstallPkgOpts struct {
	VenvDir string
	Runner  CmdRunner
}

func UninstallPkg(opts UninstallPkgOpts, s plan.Step) error {
	if opts.VenvDir == "" {
		return fmt.Errorf("uninstall_pkg: no venv configured (run create_venv first)")
	}
	name, err := argRequired(s.Args, "name")
	if err != nil {
		return fmt.Errorf("uninstall_pkg: %w", err)
	}
	bare := strippedPackageName(name)
	pyExe := PythonExePath(opts.VenvDir)
	runner := opts.Runner
	if runner == nil {
		runner = realRunner
	}
	log.Printf("  uninstall_pkg: %s", bare)
	args := []string{
		"-m", "pip", "uninstall", "--yes",
		"--disable-pip-version-check",
		bare,
	}
	if err := runner(context.Background(), 120*time.Second, pyExe, args...); err != nil {
		return fmt.Errorf("uninstall_pkg: %s failed: %w", bare, err)
	}
	return nil
}
