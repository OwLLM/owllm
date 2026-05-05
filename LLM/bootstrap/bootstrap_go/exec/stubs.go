// Package exec dispatches Plan steps to action executors.
//
// Phase 0 -> Phase 1 cutover: actions that have a real executor go
// through the typed path; the rest stay as stubs that log "would
// execute X" so we can iterate on the model + grammar without
// committing to install-changing behavior in unfinished areas.
//
// Real executors:
//   - create_venv   (exec/create_venv.go)
//   - install_pkg   (exec/install_pkg.go)
//   - download_file (exec/download_file.go)
//
// Still stubbed:
//   - swap_wheel, set_env, pick_profile, ask_user, uninstall_pkg, ...
//
// `abort` short-circuits the plan loop so the user sees the model's
// reason and can take over.
package exec

import (
	"fmt"
	"log"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/server"
)

// Executor walks a plan and dispatches each step. State that survives
// across steps -- currently just the active venv path -- lives here so
// `install_pkg` can find what `create_venv` produced earlier in the
// same run.
type Executor struct {
	dryRun       bool
	srv          *server.Server
	systemPrompt []byte
	grammar      []byte
	bootDir      string

	// State carried across steps in a single plan run.
	activeVenv string
}

func New(dryRun bool, srv *server.Server, systemPrompt, grammar []byte) *Executor {
	return &Executor{
		dryRun:       dryRun,
		srv:          srv,
		systemPrompt: systemPrompt,
		grammar:      grammar,
	}
}

// SetBootDir lets main.go thread the bootstrap directory through to
// the executor without exporting an opts struct. Optional -- defaults
// to the current working directory if not set.
func (e *Executor) SetBootDir(dir string) { e.bootDir = dir }

// RunPlan walks `steps` sequentially. Returns the first executor
// error, with the step index pinned to the message so the caller can
// match it back to the model's plan.
func (e *Executor) RunPlan(steps []plan.Step, maxSteps, maxRetries int) error {
	if len(steps) > maxSteps {
		return fmt.Errorf("plan has %d steps; cap is %d -- refusing", len(steps), maxSteps)
	}
	for i, step := range steps {
		log.Printf("[%d/%d] %s %v", i+1, len(steps), step.Action, step.Args)
		if e.dryRun {
			log.Printf("  (dry-run) skipping execution")
			continue
		}
		if err := e.dispatch(step); err != nil {
			return fmt.Errorf("step %d (%s) failed: %w", i+1, step.Action, err)
		}
	}
	return nil
}

func (e *Executor) dispatch(s plan.Step) error {
	switch s.Action {
	case "create_venv":
		path, err := CreateVenv(CreateVenvOpts{BootDir: e.bootDir}, s)
		if err == nil {
			e.activeVenv = path
		}
		return err
	case "install_pkg":
		return InstallPkg(InstallPkgOpts{VenvDir: e.activeVenv}, s)
	case "download_file":
		return DownloadFile(DownloadFileOpts{}, s)
	case "swap_wheel":
		return e.stub("swap_wheel", s)
	case "set_env":
		return e.stub("set_env", s)
	case "pick_profile":
		return e.stub("pick_profile", s)
	case "ask_user":
		return e.stub("ask_user", s)
	case "uninstall_pkg":
		return e.stub("uninstall_pkg", s)
	case "abort":
		return fmt.Errorf("model requested abort: %s", s.Reason)
	default:
		return fmt.Errorf("unknown action %q", s.Action)
	}
}

func (e *Executor) stub(name string, s plan.Step) error {
	log.Printf("  [STUB] would execute %s with args=%v reason=%q",
		name, s.Args, s.Reason)
	return nil
}
