// Shared subprocess runner type. Production wires `realRunner`; tests
// inject a fake to assert "what command would have been run" without
// spawning anything.
package exec

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// CmdRunner runs `bin args...` with a per-call timeout. Returns nil
// on success, or an error wrapping the exit status / stderr.
type CmdRunner func(ctx context.Context, timeout time.Duration, bin string, args ...string) error

// realRunner uses os/exec. Captures stderr into the returned error
// so the model gets meaningful feedback on failure.
func realRunner(ctx context.Context, timeout time.Duration, bin string, args ...string) error {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, bin, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		// Truncate combined output so log lines don't blow up.
		text := strings.TrimSpace(string(out))
		if len(text) > 2000 {
			text = text[len(text)-2000:]
		}
		return fmt.Errorf("%w (output tail: %s)", err, text)
	}
	return nil
}
