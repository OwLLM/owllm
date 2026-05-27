// Package plan defines the request/response wire types and the
// tolerant JSON parser for the supervisor's structured output.
//
// Mirrors LLM/core/supervisor/brain.py + bootstrap/recipes/plan.gbnf.
package plan

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/hardware"
	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/server"
)

// Request is what the bootstrap sends to the model on the first plan call.
type Request struct {
	Hardware    hardware.Spec `json:"hardware"`
	InstallGoal string        `json:"install_goal"`
	Recipes     string        `json:"recipes"`
}

// Step is one action the model proposes. Args is intentionally a generic
// JSON object -- each action's executor knows how to interpret its own args.
type Step struct {
	Action   string                 `json:"action"`
	Args     map[string]any         `json:"args"`
	Reason   string                 `json:"reason,omitempty"`
	Fallback *Step                  `json:"fallback,omitempty"`
}

// Response is the envelope llama-server returns from /completion.
type Response struct {
	Content string `json:"content"`
}

// Diagnose POSTs the request to llama-server and parses the resulting
// plan. Bounded by `timeout`. Returns a non-empty []Step on success.
//
// The request body shape:
//   {
//     "prompt":      <Gemma chat-formatted system+user>,
//     "n_predict":   1024,
//     "temperature": 0.1,
//     "stop":        ["<end_of_turn>", "</s>"],
//     "grammar":     <GBNF source>,
//   }
func Diagnose(srv *server.Server, systemPrompt, grammar []byte, req Request, timeout time.Duration) ([]Step, error) {
	userJSON, _ := json.MarshalIndent(req, "", "  ")
	prompt := fmt.Sprintf(
		"<start_of_turn>user\n%s\n\n%s\n<end_of_turn>\n<start_of_turn>model\n",
		string(systemPrompt), string(userJSON),
	)
	body := map[string]any{
		"prompt":      prompt,
		"n_predict":   1024,
		"temperature": 0.1,
		"stop":        []string{"<end_of_turn>", "</s>"},
	}
	if len(grammar) > 0 {
		body["grammar"] = string(grammar)
	}
	bodyJSON, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := srv.Post(ctx, "/completion", bodyJSON)
	if err != nil {
		return nil, fmt.Errorf("/completion failed: %w", err)
	}

	var env Response
	if err := json.Unmarshal(out, &env); err != nil {
		return nil, fmt.Errorf("envelope not JSON: %w", err)
	}
	steps, err := ParseSteps(env.Content)
	if err != nil {
		return nil, err
	}
	if len(steps) == 0 {
		return nil, fmt.Errorf("model returned no steps")
	}
	return steps, nil
}

// ParseSteps tries the strict JSON shape first ({"steps": [...]} or a
// bare array), falls back to extracting the first balanced { ... }
// when the model wraps the JSON in markdown fences or trailing prose.
func ParseSteps(text string) ([]Step, error) {
	cleaned := stripFences(text)

	// Shape 1: { "steps": [...] }
	var withSteps struct {
		Steps []Step `json:"steps"`
	}
	if err := json.Unmarshal([]byte(cleaned), &withSteps); err == nil && len(withSteps.Steps) > 0 {
		return withSteps.Steps, nil
	}

	// Shape 2: bare array
	var arr []Step
	if err := json.Unmarshal([]byte(cleaned), &arr); err == nil && len(arr) > 0 {
		return arr, nil
	}

	// Shape 3: single step (the runtime supervisor's diagnose() shape)
	var single Step
	if err := json.Unmarshal([]byte(cleaned), &single); err == nil && single.Action != "" {
		return []Step{single}, nil
	}

	// Shape 4: balanced-brace recovery
	if obj := extractFirstObject(cleaned); obj != "" {
		if err := json.Unmarshal([]byte(obj), &withSteps); err == nil && len(withSteps.Steps) > 0 {
			return withSteps.Steps, nil
		}
		if err := json.Unmarshal([]byte(obj), &single); err == nil && single.Action != "" {
			return []Step{single}, nil
		}
	}
	return nil, fmt.Errorf("could not parse plan from model output")
}

func stripFences(s string) string {
	s = trimSpace(s)
	if len(s) >= 3 && s[:3] == "```" {
		// Drop everything up to first newline (```json header)
		for i := 3; i < len(s); i++ {
			if s[i] == '\n' {
				s = s[i+1:]
				break
			}
		}
		// Drop trailing fence
		if len(s) >= 3 && s[len(s)-3:] == "```" {
			s = s[:len(s)-3]
		}
	}
	return trimSpace(s)
}

func trimSpace(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\n' || s[start] == '\r' || s[start] == '\t') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\n' || s[end-1] == '\r' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}

func extractFirstObject(s string) string {
	start := -1
	depth := 0
	for i, ch := range s {
		if ch == '{' {
			if start == -1 {
				start = i
			}
			depth++
		} else if ch == '}' {
			depth--
			if depth == 0 && start != -1 {
				return s[start : i+1]
			}
		}
	}
	return ""
}
