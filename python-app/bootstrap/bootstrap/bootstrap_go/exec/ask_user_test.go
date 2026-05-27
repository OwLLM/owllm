package exec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

func TestAskUser_WritesPendingFileAndErrors(t *testing.T) {
	tmp := t.TempDir()
	step := plan.Step{
		Action: "ask_user",
		Args: map[string]any{
			"question": "No GPU detected. Continue with CPU-only?",
			"options":  []any{"continue", "abort"},
		},
		Reason: "fall through profile",
	}
	err := AskUser(AskUserOpts{BootDir: tmp}, step)
	if err == nil {
		t.Fatal("ask_user must return an error so the plan loop halts")
	}
	if !strings.Contains(err.Error(), "No GPU detected") {
		t.Errorf("error should echo question: %v", err)
	}

	data, readErr := os.ReadFile(filepath.Join(tmp, "runtime", _pendingQuestionFile))
	if readErr != nil {
		t.Fatalf("pending file: %v", readErr)
	}
	var q pendingQuestion
	if err := json.Unmarshal(data, &q); err != nil {
		t.Fatal(err)
	}
	if q.Question != "No GPU detected. Continue with CPU-only?" {
		t.Errorf("question = %q", q.Question)
	}
	if len(q.Options) != 2 || q.Options[0] != "continue" {
		t.Errorf("options = %v", q.Options)
	}
}

func TestAskUser_DefaultsOptions(t *testing.T) {
	tmp := t.TempDir()
	step := plan.Step{
		Action: "ask_user",
		Args:   map[string]any{"question": "proceed?"},
	}
	_ = AskUser(AskUserOpts{BootDir: tmp}, step)

	data, _ := os.ReadFile(filepath.Join(tmp, "runtime", _pendingQuestionFile))
	var q pendingQuestion
	_ = json.Unmarshal(data, &q)
	if !(len(q.Options) == 2 && q.Options[0] == "continue" && q.Options[1] == "abort") {
		t.Errorf("default options = %v", q.Options)
	}
}

func TestAskUser_MissingQuestionFails(t *testing.T) {
	err := AskUser(AskUserOpts{BootDir: t.TempDir()},
		plan.Step{Action: "ask_user", Args: map[string]any{}})
	if err == nil {
		t.Fatal("expected error for missing question")
	}
}
