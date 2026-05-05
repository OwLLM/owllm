// Package main is the OWLLM install-time bootstrap.
//
// Pipeline:
//   1. Probe hardware (nvidia-smi, wmic, dxdiag).
//   2. Spawn the bundled llama-server.exe with the bundled Gemma 4 E2B
//      GGUF. Wait for /health to return 200.
//   3. Send a structured request to the model: { hardware, install_goal }.
//      The model responds with a JSON Plan: a list of Steps, each one a
//      named action plus args.
//   4. Execute steps sequentially. On failure, feed stderr back into the
//      model and ask for the next-best action. Bounded retry per step.
//   5. Shut down llama-server. Exit. The desktop app respawns the
//      server later if a runtime failure event needs supervisor advice.
//
// Production safety: bootstrap MUST NOT corrupt a half-installed system.
// Every action executor is idempotent (or no-op when its goal is already
// satisfied). Catastrophic failures abort the run with a clear message
// rather than rolling back -- the user can re-run bootstrap and the
// model picks up where it left off.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/exec"
	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/hardware"
	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/server"
)

const (
	defaultPort       = 8765
	bootTimeout       = 30 * time.Second
	requestTimeout    = 60 * time.Second
	maxStepsPerRun    = 50
	maxRetriesPerStep = 5
)

func main() {
	var (
		dryRun  = flag.Bool("dry-run", false, "skip action execution; print plan only")
		port    = flag.Int("port", defaultPort, "llama-server HTTP port")
		verbose = flag.Bool("v", false, "verbose logging")
	)
	flag.Parse()

	if *verbose {
		log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	}

	bootDir := bootstrapDir()
	log.Printf("OWLLM bootstrap starting (dir=%s)", bootDir)

	hw, err := hardware.Probe(context.Background())
	if err != nil {
		log.Printf("hardware probe failed: %v -- continuing with empty spec", err)
	}
	if data, _ := json.MarshalIndent(hw, "", "  "); data != nil {
		log.Printf("hardware spec:\n%s", string(data))
	}

	// Spawn llama-server.
	cfg := server.Config{
		Binary:      filepath.Join(bootDir, "runtime", llamaServerName()),
		Model:       filepath.Join(bootDir, "runtime", "gemma-4-E2B-it-Q4_K_M.gguf"),
		Grammar:     filepath.Join(bootDir, "recipes", "plan.gbnf"),
		Port:        *port,
		BootTimeout: bootTimeout,
	}
	srv, err := server.Start(cfg)
	if err != nil {
		fatal("could not start llama-server: %v", err)
	}
	defer func() {
		if err := srv.Shutdown(2 * time.Second); err != nil {
			log.Printf("llama-server shutdown error: %v", err)
		}
	}()

	// Trap SIGINT/SIGTERM so we don't leave a zombie llama-server behind.
	sigC := make(chan os.Signal, 1)
	signal.Notify(sigC, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigC
		log.Println("interrupted -- shutting down")
		_ = srv.Shutdown(2 * time.Second)
		os.Exit(130)
	}()

	// Initial plan request.
	systemPrompt, _ := os.ReadFile(filepath.Join(bootDir, "recipes", "system_prompt.txt"))
	grammar, _ := os.ReadFile(filepath.Join(bootDir, "recipes", "plan.gbnf"))

	req := plan.Request{
		Hardware:    hw,
		InstallGoal: "owllm-3.0",
		Recipes:     loadRecipeSummary(bootDir),
	}

	steps, err := plan.Diagnose(srv, systemPrompt, grammar, req, requestTimeout)
	if err != nil {
		fatal("model returned no plan: %v", err)
	}

	log.Printf("model returned %d steps", len(steps))

	executor := exec.New(*dryRun, srv, systemPrompt, grammar)
	executor.SetBootDir(bootDir)
	if err := executor.RunPlan(steps, maxStepsPerRun, maxRetriesPerStep); err != nil {
		fatal("plan execution failed: %v", err)
	}

	log.Println("OWLLM bootstrap complete.")
}

// bootstrapDir returns the directory containing this binary (the
// bootstrap root that holds runtime/ and recipes/). Prefers
// $LOCALLLM_BOOTSTRAP_DIR for testing.
func bootstrapDir() string {
	if v := os.Getenv("LOCALLLM_BOOTSTRAP_DIR"); v != "" {
		return v
	}
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

func llamaServerName() string {
	if isWindows() {
		return "llama-server.exe"
	}
	return "llama-server"
}

func isWindows() bool {
	return os.PathSeparator == '\\'
}

func loadRecipeSummary(bootDir string) string {
	p := filepath.Join(bootDir, "recipes", "hardware_profiles.json")
	data, err := os.ReadFile(p)
	if err != nil {
		return "{}"
	}
	return string(data)
}

func fatal(format string, args ...any) {
	log.Printf("FATAL: "+format, args...)
	os.Exit(1)
}

// Compile-time guard: ensure json import is used (via plan.Request marshalling
// in plan package). Avoids a "json imported but not used" diagnostic during
// development if the body of main shifts.
var _ = json.Marshal
var _ = fmt.Sprintf
