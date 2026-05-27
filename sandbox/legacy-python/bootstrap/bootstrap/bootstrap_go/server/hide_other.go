//go:build !windows

package server

import "os/exec"

// hideConsolePlatform is a no-op on non-Windows -- terminals on
// macOS/Linux don't pop transient consoles per spawned subprocess.
func hideConsolePlatform(cmd *exec.Cmd) {}
