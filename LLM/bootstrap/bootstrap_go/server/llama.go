// Package server owns the lifecycle of llama-server.exe.
//
// Mirrors the Python supervisor brain (LLM/core/supervisor/brain.py)
// but for the install-time process. Spawn -> /health poll -> graceful
// shutdown. Hidden console on Windows so the user doesn't see a flash.
package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"
)

type Config struct {
	Binary      string        // path to llama-server[.exe]
	Model       string        // path to .gguf
	Grammar     string        // path to plan.gbnf (optional; pass to /completion at request time)
	Port        int
	BootTimeout time.Duration
}

type Server struct {
	cfg  Config
	cmd  *exec.Cmd
	base string
}

func Start(cfg Config) (*Server, error) {
	if _, err := os.Stat(cfg.Binary); err != nil {
		return nil, fmt.Errorf("llama-server binary missing: %s", cfg.Binary)
	}
	if _, err := os.Stat(cfg.Model); err != nil {
		return nil, fmt.Errorf("gguf model missing: %s", cfg.Model)
	}

	args := []string{
		"--model", cfg.Model,
		"--port", strconv.Itoa(cfg.Port),
		"--ctx-size", "16384",
		"-ngl", "0", // CPU-only at install time; bootstrap is conservative.
	}
	cmd := exec.Command(cfg.Binary, args...)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	hideConsole(cmd) // Windows-only no-op elsewhere.

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("spawn failed: %w", err)
	}

	srv := &Server{
		cfg:  cfg,
		cmd:  cmd,
		base: fmt.Sprintf("http://127.0.0.1:%d", cfg.Port),
	}

	if err := srv.waitHealthy(cfg.BootTimeout); err != nil {
		_ = srv.kill()
		return nil, err
	}
	return srv, nil
}

func (s *Server) BaseURL() string {
	return s.base
}

// Post sends a JSON body to a path on the server. Caller is responsible
// for the timeout context.
func (s *Server) Post(ctx context.Context, path string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", s.base+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return data, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(data))
	}
	return data, nil
}

func (s *Server) Healthy() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", s.base+"/health", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == 200
}

func (s *Server) Shutdown(timeout time.Duration) error {
	// Try graceful shutdown first.
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_, _ = s.Post(ctx, "/shutdown", []byte("{}"))
	// Give it a moment, then force-kill if still alive.
	done := make(chan error, 1)
	go func() { done <- s.cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(timeout):
		return s.kill()
	}
}

func (s *Server) kill() error {
	if s.cmd == nil || s.cmd.Process == nil {
		return nil
	}
	if err := s.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}

func (s *Server) waitHealthy(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if s.Healthy() {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("llama-server did not become healthy within %s", timeout)
}

// hideConsole on Windows sets CREATE_NO_WINDOW so launching from
// bootstrap.exe (-H=windowsgui) doesn't pop a transient cmd. POSIX no-op.
//
//goland:noinspection GoBoolExpressions
func hideConsole(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	hideConsolePlatform(cmd)
}
