// Package exec -- typed accessors for action arguments.
//
// The model emits arbitrary JSON in `args`; executors need typed
// fields. Centralizing the extraction here keeps individual action
// implementations from re-implementing "is this thing actually a
// string?" defensive checks.
//
// Every getter returns ("", false) on missing/wrong-type so the
// executor can decide whether the action can proceed without it
// (warn + fall back) or must abort. We never log arg names that
// might leak secrets -- the model's args travel with the trace, but
// individual calls don't echo them by default.
package exec

import (
	"fmt"
	"strconv"
)

// argString returns args[key] as a non-empty string, or "" + false.
func argString(args map[string]any, key string) (string, bool) {
	if args == nil {
		return "", false
	}
	v, ok := args[key]
	if !ok {
		return "", false
	}
	s, ok := v.(string)
	if !ok || s == "" {
		return "", false
	}
	return s, true
}

// argStringSlice returns args[key] as []string. Accepts both []any of
// strings and []string directly, since the JSON unmarshal path may
// produce either depending on whether decoding into a typed struct.
func argStringSlice(args map[string]any, key string) ([]string, bool) {
	if args == nil {
		return nil, false
	}
	v, ok := args[key]
	if !ok {
		return nil, false
	}
	if direct, ok := v.([]string); ok {
		return direct, true
	}
	raw, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out, len(out) > 0
}

// argInt returns args[key] as an int. JSON numbers come back as
// float64 from encoding/json, so we tolerate that and explicit ints,
// plus numeric strings (the model sometimes quotes its numbers).
func argInt(args map[string]any, key string) (int, bool) {
	if args == nil {
		return 0, false
	}
	v, ok := args[key]
	if !ok {
		return 0, false
	}
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	case string:
		if x, err := strconv.Atoi(n); err == nil {
			return x, true
		}
	}
	return 0, false
}

// argRequired wraps argString for cases where missing => fatal.
func argRequired(args map[string]any, key string) (string, error) {
	s, ok := argString(args, key)
	if !ok {
		return "", fmt.Errorf("missing required arg %q", key)
	}
	return s, nil
}
