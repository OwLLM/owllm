package exec

import "testing"

func TestArgString(t *testing.T) {
	args := map[string]any{"name": "torch", "empty": "", "n": 7}
	if s, ok := argString(args, "name"); !ok || s != "torch" {
		t.Fatalf("got %q ok=%v", s, ok)
	}
	if _, ok := argString(args, "empty"); ok {
		t.Fatal("empty string should be reported as missing")
	}
	if _, ok := argString(args, "n"); ok {
		t.Fatal("non-string should be reported as missing")
	}
	if _, ok := argString(args, "absent"); ok {
		t.Fatal("absent key should be missing")
	}
	if _, ok := argString(nil, "x"); ok {
		t.Fatal("nil args should be missing")
	}
}

func TestArgInt(t *testing.T) {
	args := map[string]any{"a": 5, "b": float64(7), "c": "9", "d": "x"}
	if n, ok := argInt(args, "a"); !ok || n != 5 {
		t.Fatalf("a=%d ok=%v", n, ok)
	}
	if n, ok := argInt(args, "b"); !ok || n != 7 {
		t.Fatalf("b=%d ok=%v", n, ok)
	}
	if n, ok := argInt(args, "c"); !ok || n != 9 {
		t.Fatalf("c=%d ok=%v", n, ok)
	}
	if _, ok := argInt(args, "d"); ok {
		t.Fatal("non-numeric string should be missing")
	}
}

func TestArgStringSlice(t *testing.T) {
	args := map[string]any{
		"raw":    []any{"a", "b", "c"},
		"direct": []string{"x", "y"},
		"mixed":  []any{"ok", 1, "still_ok"},
		"empty":  []any{1, 2},
	}
	if v, ok := argStringSlice(args, "raw"); !ok || len(v) != 3 || v[0] != "a" {
		t.Fatalf("raw=%v ok=%v", v, ok)
	}
	if v, ok := argStringSlice(args, "direct"); !ok || len(v) != 2 || v[1] != "y" {
		t.Fatalf("direct=%v ok=%v", v, ok)
	}
	if v, ok := argStringSlice(args, "mixed"); !ok || len(v) != 2 {
		t.Fatalf("mixed=%v ok=%v", v, ok)
	}
	if _, ok := argStringSlice(args, "empty"); ok {
		t.Fatal("slice of non-strings should be missing")
	}
}

func TestArgRequired(t *testing.T) {
	args := map[string]any{"name": "torch"}
	if v, err := argRequired(args, "name"); err != nil || v != "torch" {
		t.Fatalf("got %q err=%v", v, err)
	}
	if _, err := argRequired(args, "absent"); err == nil {
		t.Fatal("expected error for absent")
	}
}
