// Package exec dispatches Plan steps to action executors.
//
// At Phase 0 every action is a stub that logs "would execute X" and
// returns success -- enough to drive the model end-to-end through the
// plan loop and validate the wire format. Real executors land per
// ROLLOUT.md Phase 6 milestones, one at a time, each behind its own
// unit + E2E test.
//
// The stub layer is intentional: it lets us ship and iterate on the
// model + prompt + grammar without committing to install-changing
// behavior on a user's machine. A bug in the model can't break a real
// install while every executor is a no-op.
package exec

import (
	"fmt"
	"log"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/server"
)

type Executor struct {
	dryRun       bool
	srv          *server.Server
	systemPrompt []byte
	grammar      []byte
}

func New(dryRun bool, srv *server.Server, systemPrompt, grammar []byte) *Executor {
	return &Executor{
		dryRun:       dryRun,
		srv:          srv,
		systemPrompt: systemPrompt,
		grammar:      grammar,
	}
}

// RunPlan walks `steps` sequentially. Each step is dispatched via
// `dispatch`, which returns nil on success or an error on failure. On
// failure we'd ideally feed stderr back to the model and ask for a
// next-best action, but Phase 0 just aborts so the dev sees what the
// model proposed.
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

// dispatch routes a step to its executor. New actions get added here
// as their unit tests land; unknown actions return an error so a model
// hallucination can't silently no-op an install.
func (e *Executor) dispatch(s plan.Step) error {
	switch s.Action {
	case "create_venv":
		return e.stub("create_venv", s)
	case "install_pkg":
		return e.stub("install_pkg", s)
	case "swap_wheel":
		return e.stub("swap_wheel", s)
	case "download_file":
		return e.stub("download_file", s)
	case "set_env":
		return e.stub("set_env", s)
	case "pick_profile":
		return e.stub("pick_profile", s)
	case "ask_user":
		return e.stub("ask_user", s)
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
