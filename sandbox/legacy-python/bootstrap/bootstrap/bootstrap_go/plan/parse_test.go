package plan

import "testing"

func TestParseSteps_BareArray(t *testing.T) {
	steps, err := ParseSteps(`[{"action":"create_venv","args":{"python_version":"3.11"}}]`)
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(steps) != 1 || steps[0].Action != "create_venv" {
		t.Fatalf("got %+v", steps)
	}
}

func TestParseSteps_StepsEnvelope(t *testing.T) {
	steps, err := ParseSteps(`{"profile":"cuda121","steps":[{"action":"install_pkg","args":{"name":"torch"}}]}`)
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(steps) != 1 || steps[0].Args["name"] != "torch" {
		t.Fatalf("got %+v", steps)
	}
}

func TestParseSteps_SingleStep(t *testing.T) {
	steps, err := ParseSteps(`{"action":"abort","args":{"reason":"x"}}`)
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(steps) != 1 || steps[0].Action != "abort" {
		t.Fatalf("got %+v", steps)
	}
}

func TestParseSteps_StripsMarkdownFence(t *testing.T) {
	steps, err := ParseSteps("```json\n{\"action\":\"install_pkg\",\"args\":{}}\n```")
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(steps) != 1 || steps[0].Action != "install_pkg" {
		t.Fatalf("got %+v", steps)
	}
}

func TestParseSteps_TrailingProseRecovered(t *testing.T) {
	in := `{"action":"abort","args":{}}` + "\n\nThis was hard to map."
	steps, err := ParseSteps(in)
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(steps) != 1 || steps[0].Action != "abort" {
		t.Fatalf("got %+v", steps)
	}
}

func TestParseSteps_GarbageReturnsError(t *testing.T) {
	if _, err := ParseSteps("not json at all"); err == nil {
		t.Fatal("expected error")
	}
}

func TestParseSteps_EmptyStepsReturnsError(t *testing.T) {
	if _, err := ParseSteps(`{"steps": []}`); err == nil {
		t.Fatal("expected error on empty steps")
	}
}
