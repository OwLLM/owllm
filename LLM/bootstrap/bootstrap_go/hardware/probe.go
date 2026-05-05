// Package hardware probes the user's machine for hardware spec.
//
// Output schema must match the Python runtime probe at
// LLM/core/supervisor/hardware_probe.py so the model sees a consistent
// shape regardless of which mode (bootstrap-time or runtime) it's
// being asked from.
//
// On Windows the probe shells out to wmic + nvidia-smi + dxdiag.
// Failures degrade gracefully -- a missing nvidia-smi means "no NVIDIA
// GPU detected", not "abort the install". The model decides what to do
// with partial information.
package hardware

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Spec mirrors the JSON the Python supervisor consumes.
type Spec struct {
	OS   OSInfo  `json:"os"`
	CPU  CPUInfo `json:"cpu"`
	RAM  uint64  `json:"ram_gb"`
	Disk uint64  `json:"disk_free_gb"`
	GPUs []GPU   `json:"gpu"`
}

type OSInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Arch    string `json:"arch"`
}

type CPUInfo struct {
	Model   string `json:"model"`
	Cores   int    `json:"cores"`
	Threads int    `json:"threads"`
}

type GPU struct {
	Vendor             string `json:"vendor"`
	Model              string `json:"model"`
	VRAMGB             uint64 `json:"vram_gb"`
	Driver             string `json:"driver"`
	CUDARuntime        string `json:"cuda_runtime"`
	ComputeCapability  string `json:"compute_capability"`
}

// Probe assembles a Spec. Never errors -- partial info is better than
// none, and the model is trained to handle missing fields. The error
// return is reserved for "we couldn't even build the basic skeleton".
func Probe(ctx context.Context) (Spec, error) {
	s := Spec{
		OS: OSInfo{
			Name: runtime.GOOS,
			Arch: runtime.GOARCH,
		},
		CPU: CPUInfo{
			Cores:   runtime.NumCPU(),
			Threads: runtime.NumCPU(),
		},
	}
	if runtime.GOOS == "windows" {
		probeWindows(ctx, &s)
	}
	probeNvidia(ctx, &s)
	return s, nil
}

func probeWindows(ctx context.Context, s *Spec) {
	// CPU model
	if out, err := runCmd(ctx, 5*time.Second, "wmic", "cpu", "get", "Name", "/value"); err == nil {
		for _, line := range strings.Split(out, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "Name=") {
				s.CPU.Model = strings.TrimPrefix(line, "Name=")
				break
			}
		}
	}
	// OS version (Windows release / build)
	if out, err := runCmd(ctx, 5*time.Second, "cmd", "/c", "ver"); err == nil {
		s.OS.Version = strings.TrimSpace(out)
	}
	// Total physical memory
	if out, err := runCmd(ctx, 5*time.Second, "wmic", "ComputerSystem", "get", "TotalPhysicalMemory", "/value"); err == nil {
		for _, line := range strings.Split(out, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "TotalPhysicalMemory=") {
				if n, err := strconv.ParseUint(strings.TrimPrefix(line, "TotalPhysicalMemory="), 10, 64); err == nil {
					s.RAM = n / (1024 * 1024 * 1024)
				}
				break
			}
		}
	}
}

// probeNvidia runs nvidia-smi --query-gpu=... and parses the CSV. If
// nvidia-smi isn't on PATH (no NVIDIA driver installed), this is a
// no-op -- the user just has no NVIDIA GPU.
func probeNvidia(ctx context.Context, s *Spec) {
	out, err := runCmd(ctx, 5*time.Second, "nvidia-smi",
		"--query-gpu=name,memory.total,driver_version,compute_cap",
		"--format=csv,noheader,nounits",
	)
	if err != nil {
		return
	}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		fields := strings.Split(line, ", ")
		if len(fields) < 4 {
			continue
		}
		vram, _ := strconv.ParseUint(strings.TrimSpace(fields[1]), 10, 64)
		s.GPUs = append(s.GPUs, GPU{
			Vendor:            "nvidia",
			Model:             strings.TrimSpace(fields[0]),
			VRAMGB:            vram / 1024, // nvidia-smi reports MiB
			Driver:            strings.TrimSpace(fields[2]),
			ComputeCapability: strings.TrimSpace(fields[3]),
		})
	}
}

// runCmd is a thin wrapper to enforce a per-call timeout and capture
// stdout. stderr is silenced -- we don't want wmic chatter breaking
// the parse.
func runCmd(ctx context.Context, d time.Duration, name string, args ...string) (string, error) {
	if _, err := exec.LookPath(name); err != nil {
		return "", errors.New(name + " not found")
	}
	cctx, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	cmd := exec.CommandContext(cctx, name, args...)
	out, err := cmd.Output()
	return string(out), err
}

// MarshalJSON keeps unset GPU slice as [] not null in the wire format,
// which the Python brain prefers (json.loads handles either, but the
// model sees [] as "no gpu" more cleanly).
func (s Spec) MarshalJSON() ([]byte, error) {
	type alias Spec
	a := alias(s)
	if a.GPUs == nil {
		a.GPUs = []GPU{}
	}
	return json.Marshal(a)
}
