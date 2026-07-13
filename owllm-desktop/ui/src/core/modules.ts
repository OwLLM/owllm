// Module registry — the data behind the modular install model.
//
// The user's distribution may install only some modes (e.g. Fine
// Tuning + Advanced, or Agentic Team only). Each mode is a self-
// contained bundle of pages declared here. AppShell reads this
// manifest, intersects it with `getInstalledModes()`, and renders
// only the bits the user has chosen.
//
// Adding a new page = appending one PageDef to its mode's `pages`
// array. Adding a new mode = adding a top-level entry below.
//
// No global state lives here. This file is pure data + types.
import type { ComponentType } from "react";

// Built-in / always-on:
import HomePage from "../pages/core/HomePage";
import ServerPage from "../pages/core/ServerPage";
import InfoPage from "../pages/core/InfoPage";

// Fine-tuning mode:
import ModelsPage from "../pages/finetuning/ModelsPage";
import DatasetBuilderPage from "../pages/finetuning/DatasetBuilderPage";
import TrainPage from "../pages/finetuning/TrainPage";
import ChatPage from "../pages/finetuning/ChatPage";

// Agentic-team mode:
import CodePage from "../pages/agentic/CodePage";
import AgentsPage from "../pages/agentic/AgentsPage";
import StudioPage from "../pages/agentic/StudioPage";
import BridgesPage from "../pages/agentic/BridgesPage";
import AssetsPage from "../pages/agentic/AssetsPage";

// Gamify mode:
import GamifyPage from "../pages/gamify/GamifyPage";
import CharactersPage from "../pages/gamify/CharactersPage";
import ArenaPage from "../pages/gamify/ArenaPage";

// Advanced toggle (not a mode — independent reveal):
import MCPPage from "../pages/advanced/MCPPage";
import AccountsPage from "../pages/advanced/AccountsPage";
import SigningPage from "../pages/advanced/SigningPage";
import DevicesPage from "../pages/advanced/DevicesPage";

// ---------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------

/**
 * The four named installable modes + 'core' which is the always-on
 * base (Home / Server / Info). 'core' is never user-installable —
 * it ships with every OwLLM build.
 */
export type ModeId = "core" | "finetuning" | "agentic" | "gamify" | "advanced";

export type PageDef = {
  /** Stable internal key — used in URL routing + localStorage state. */
  key: string;
  /** Display label including emoji prefix (matches Qt button text). */
  label: string;
  /** The React component. Lazy-loaded by AppShell on first navigation. */
  component: ComponentType;
};

export type ModuleDef = {
  id: ModeId;
  /** Two-line ModeBar button label (e.g. "🛠\nFine Tuning"). */
  toggleLabel: string;
  /** owl_FineTuning.png / owl_AgenticTeam.png etc. — used by the
   *  ModeBar tile, optional. */
  toggleIconPng?: string;
  /** Pages this module contributes to SubTabs when active. */
  pages: PageDef[];
  /** Which page key the SubTabs row lands on when this mode goes
   *  active. Matches the Qt `_GROUP_FIRST_TAB` map. */
  firstTab: string;
};

// ---------------------------------------------------------------------
// Module definitions — keep these literal (no programmatic
// generation) so they're trivially auditable against the Qt source.
// ---------------------------------------------------------------------

/** Core — Home + Server + Info. Always installed; ships with every
 *  OwLLM build. (Qt: buttons NOT in `_NAVBAR_GROUPS`.) */
export const CORE: ModuleDef = {
  id: "core",
  toggleLabel: "Home",        // no actual ModeBar toggle; "Home" is the default mode
  pages: [
    { key: "home",   label: "🏠 Home",   component: HomePage   },
    { key: "server", label: "🖧 Server", component: ServerPage },
    { key: "info",   label: "ℹ️ Info",   component: InfoPage   },
  ],
  firstTab: "home",
};

/** Fine Tuning — Models + Train + Chat.
 *  Qt: `_NAVBAR_GROUPS["finetuning"] = ("download_btn", "train_btn", "test_btn")`. */
export const FINETUNING: ModuleDef = {
  id: "finetuning",
  toggleLabel: "🛠\nFine Tuning",
  toggleIconPng: "/Page_icons/owl_FineTuning.png",
  pages: [
    { key: "models",  label: "📦 Models",  component: ModelsPage         },
    { key: "dataset", label: "📚 Dataset", component: DatasetBuilderPage },
    { key: "train",   label: "🎯 Train",   component: TrainPage          },
    { key: "chat",    label: "💬 Chat",    component: ChatPage           },
  ],
  firstTab: "models",  // Qt _GROUP_FIRST_TAB["finetuning"] = "models"
};

/** Agentic Team — Code + Agents + Studio + Assets + Bridges.
 *  Qt: `_NAVBAR_GROUPS["agentic"] = ("code_btn", "agents_btn", "studio_btn", "assets_btn", "bridges_btn")`. */
export const AGENTIC: ModuleDef = {
  id: "agentic",
  toggleLabel: "🎭\nAgentic Team",
  toggleIconPng: "/Page_icons/owl_AgenticTeam.png",
  pages: [
    { key: "code",    label: "💻 Code",    component: CodePage    },
    { key: "agents",  label: "🤖 Agents",  component: AgentsPage  },
    { key: "studio",  label: "🎭 Studio",  component: StudioPage  },
    { key: "assets",  label: "🖼 Assets",  component: AssetsPage  },
    { key: "bridges", label: "📱 Bridges", component: BridgesPage },
  ],
  firstTab: "agents",  // Qt _GROUP_FIRST_TAB["agentic"] = "agents"
};

/** Gamify — Gamify + Characters + Arena.
 *  Qt: `_NAVBAR_GROUPS["gamify"] = ("gamify_btn", "characters_btn", "arena_top_btn")`. */
export const GAMIFY: ModuleDef = {
  id: "gamify",
  toggleLabel: "🎮\nGamify",
  pages: [
    { key: "gamify",     label: "🎮 Gamify",     component: GamifyPage     },
    { key: "characters", label: "🧙‍♂️ Characters", component: CharactersPage },
    { key: "arena",      label: "🏟 Arena",      component: ArenaPage      },
  ],
  firstTab: "gamify",  // Qt _GROUP_FIRST_TAB["gamify"] = "gamify"
};

/** Advanced — MCP + Accounts.
 *  Environment moved into the Train page's "🐧 Environment" card (the only
 *  place a fine-tuning env is used); Logs was a never-ported Python-era stub
 *  with nothing to show in the Rust/React app — both removed. */
export const ADVANCED: ModuleDef = {
  id: "advanced",
  toggleLabel: "⚙\nAdvanced",
  pages: [
    { key: "mcp",         label: "🧩 MCP",         component: MCPPage         },
    { key: "accounts",    label: "🔐 Accounts",    component: AccountsPage    },
    { key: "signing",     label: "🖊 Signing",     component: SigningPage     },
    { key: "devices",     label: "🖥 Devices",     component: DevicesPage     },
  ],
  firstTab: "mcp",
};

// ---------------------------------------------------------------------
// Install gate
// ---------------------------------------------------------------------

/** All modules that ship in the source tree, regardless of install
 *  state. The shell uses this as the catalogue; getInstalledModes()
 *  decides what's actually visible to this user. */
export const ALL_MODULES: ModuleDef[] = [CORE, FINETUNING, AGENTIC, GAMIFY, ADVANCED];

/**
 * Which modes are installed for THIS user. For now we return
 * everything (single dev binary). Future: read a `modules.json` via
 * a Tauri command, written by the installer; users get a Modules
 * settings page where they enable/disable.
 *
 * Core is always returned — it's the base shell that every OwLLM
 * install must have.
 */
export function getInstalledModes(): ModeId[] {
  // TODO(modular-install): read from settings_get("installed_modes")
  // once the installer writes that key. For now, dev returns all.
  return ["core", "finetuning", "agentic", "gamify", "advanced"];
}

/** Lookup helper — return a module's def by id, only if installed. */
export function moduleIfInstalled(id: ModeId): ModuleDef | undefined {
  if (!getInstalledModes().includes(id)) return undefined;
  return ALL_MODULES.find(m => m.id === id);
}
