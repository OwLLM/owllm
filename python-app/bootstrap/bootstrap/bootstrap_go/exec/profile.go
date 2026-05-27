// pick_profile: short-circuit the plan with a known-good install
// recipe from bootstrap/recipes/hardware_profiles.json.
//
// Args (model-provided):
//   profile_id: id of a profile to expand (required)
//
// Why this exists: the cold-start recipe table covers the 80% case
// (NVIDIA Ampere/Ada/Hopper with CUDA 12.1, NVIDIA Turing with CUDA
// 11.8, CPU-only). When the model recognizes that a user's hardware
// matches one of those, emitting a single `pick_profile` step is
// cheaper than enumerating create_venv + install_pkg + install_pkg.
// It also cuts the model out of decisions that are deterministic.
//
// Execution model: pick_profile *expands* into multiple steps. The
// executor runs them inline -- the dispatcher needs a pointer back
// into the plan loop so the profile's steps go through the same
// dispatch as top-level steps. RunProfile is exported for that hook.
package exec

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

// ProfileSpec mirrors one entry under "profiles" in hardware_profiles.json.
type ProfileSpec struct {
	ID          string         `json:"id"`
	Description string         `json:"description"`
	Match       map[string]any `json:"match"`
	Steps       []plan.Step    `json:"steps"`
}

// ProfileTable is the parsed file.
type ProfileTable struct {
	Version  int           `json:"version"`
	Profiles []ProfileSpec `json:"profiles"`
}

// LoadProfileTable reads hardware_profiles.json from `bootDir`.
// Returns an empty table (no profiles) when the file is missing --
// that's not an error, the model can still emit ad-hoc steps.
func LoadProfileTable(bootDir string) (ProfileTable, error) {
	path := filepath.Join(bootDir, "recipes", "hardware_profiles.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return ProfileTable{}, nil
		}
		return ProfileTable{}, fmt.Errorf("load profiles: %w", err)
	}
	var t ProfileTable
	if err := json.Unmarshal(data, &t); err != nil {
		return ProfileTable{}, fmt.Errorf("parse profiles: %w", err)
	}
	return t, nil
}

// FindProfile returns the profile matching `id`, or false.
func (t ProfileTable) FindProfile(id string) (ProfileSpec, bool) {
	for _, p := range t.Profiles {
		if p.ID == id {
			return p, true
		}
	}
	return ProfileSpec{}, false
}
