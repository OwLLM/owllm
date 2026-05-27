// ask_user: persist a question for the human and abort the run.
//
// During install-time bootstrap there is no UI to render a prompt --
// the desktop app hasn't started yet. Instead of trying to spawn a
// native dialog (adds a dependency, fights Windows console weirdness),
// we write the question to a file the stub installer can show:
//
//   <bootDir>/runtime/pending_question.json
//
// The bootstrap then aborts the plan loop with a clear message. The
// stub installer / OWLLM launcher checks for this file on next run
// and surfaces the question via the toast widget already built at
// LLM/desktop_app/widgets/supervisor_toast.py. The user's answer
// rewrites feature_flags.json or re-runs bootstrap with the picked
// option encoded in env.
//
// Args:
//   question  required -- prompt text
//   options   optional -- list of strings; defaults to ["continue", "abort"]
package exec

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

const _pendingQuestionFile = "pending_question.json"

type AskUserOpts struct {
	BootDir string
}

type pendingQuestion struct {
	TS       string   `json:"ts"`
	Question string   `json:"question"`
	Options  []string `json:"options"`
	Reason   string   `json:"reason,omitempty"`
}

// AskUser writes the prompt and returns an error so the plan loop
// halts. The error message is descriptive enough for the dev to see
// what the model wanted; the installer GUI uses the JSON file for
// the structured prompt.
func AskUser(opts AskUserOpts, s plan.Step) error {
	question, err := argRequired(s.Args, "question")
	if err != nil {
		return fmt.Errorf("ask_user: %w", err)
	}
	options, _ := argStringSlice(s.Args, "options")
	if len(options) == 0 {
		options = []string{"continue", "abort"}
	}

	q := pendingQuestion{
		TS:       time.Now().UTC().Format(time.RFC3339),
		Question: question,
		Options:  options,
		Reason:   s.Reason,
	}
	dir := filepath.Join(opts.BootDir, "runtime")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("ask_user: mkdir: %w", err)
	}
	out, _ := json.MarshalIndent(q, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, _pendingQuestionFile), out, 0o644); err != nil {
		return fmt.Errorf("ask_user: write: %w", err)
	}
	log.Printf("  ask_user: %q  options=%v", question, options)
	return fmt.Errorf("ask_user: %s (options: %v) -- pending in %s",
		question, options, _pendingQuestionFile)
}
