//go:build windows

package server

import (
	"os/exec"
	"syscall"
)

// CREATE_NO_WINDOW = 0x08000000
const createNoWindow = 0x08000000

func hideConsolePlatform(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= createNoWindow
	cmd.SysProcAttr.HideWindow = true
}
