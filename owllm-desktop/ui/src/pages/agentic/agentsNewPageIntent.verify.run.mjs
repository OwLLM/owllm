#!/usr/bin/env node
// "＋ New page" used to silently clone the previous tab's project, because a
// fresh tab with no stored binding fell through to `rawProjects[0]`. It now
// asks which of the two intents the user meant, and a "New project" tab stays
// unbound so the project hub renders.
//
// The same run also guards the Personal-agents Skills tab: it lists only
// hand-authored personal skills, so a user with dozens of installed SKILL.md
// packs saw an empty rail. The installed library is now shown there read-only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const agents = fs.readFileSync(path.join(here, "AgentsPage.tsx"), "utf8");
const personal = fs.readFileSync(path.join(here, "PersonalAgentsDialog.tsx"), "utf8");
let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

// ---- New page intent -------------------------------------------------------
check("An unbound-by-intent tab has a dedicated sentinel binding",
  agents.includes('const AGENTS_PAGE_NEW_PROJECT = "__new-project__"'));
check("＋ New page opens a choice menu instead of creating a tab immediately",
  agents.includes('data-ui="AgentsNewPageMenu"') &&
  agents.includes("setNewPageMenuOpen((v) => !v)"));
check("The menu offers a second page on the current project",
  agents.includes("newPage(activeProjectId)") &&
  agents.includes("＋ New page of "));
check("The menu offers a new project that lands on the project hub",
  agents.includes("newPage(AGENTS_PAGE_NEW_PROJECT)") &&
  agents.includes("⌁ New project"));
check("Same-project pages are pre-bound so the new tab restores that project",
  agents.includes("if (boundProject) localStorage.setItem(`owllm:agents:page:${id}:project`, boundProject)"));
check("The current-project option is disabled while the tab is still unbound",
  agents.includes("disabled={!activeProjectId}") &&
  agents.includes("bound !== AGENTS_PAGE_NEW_PROJECT ? bound : null"));
check("A 'New project' tab never auto-adopts projects[0]",
  agents.includes("rawProjects.length > 0 && stored !== AGENTS_PAGE_NEW_PROJECT"));
check("The sentinel is not treated as a recoverable conversation",
  agents.includes("if (!binding || binding === AGENTS_PAGE_NEW_PROJECT) continue"));
check("Clicking outside dismisses the menu",
  agents.includes("onClick={() => setNewPageMenuOpen(false)}"));
// The tab strip is overflowX:auto, which per CSS also clips vertically. An
// absolutely positioned menu inside it was invisible, so the button read as
// dead. The menu must be portalled out of that scroll container.
check("The menu is portalled to <body> so the scrolling tab strip cannot clip it",
  agents.includes("newPageMenuOpen && newPageMenuPos && createPortal(") &&
  /<\/>,\s*document\.body\s*\)\}/.test(agents) &&
  agents.includes('import { createPortal } from "react-dom"'));
check("The portalled menu is placed from the trigger's live rect",
  agents.includes("newPageBtnRef.current?.getBoundingClientRect()") &&
  agents.includes("setNewPageMenuPos({ top: r.bottom + 4, left: r.left })") &&
  agents.includes("position: \"fixed\", top: newPageMenuPos.top, left: newPageMenuPos.left"));

// ---- Personal-agents Skills tab -------------------------------------------
check("The Skills tab shows the installed skill library, not just personal skills",
  personal.includes("Installed skill library ({skills.length})"));
check("The library rail explains where packs are installed and equipped",
  personal.includes("Studio → Skills") &&
  personal.includes("Equip them per profile on the Profiles tab"));
check("Each installed pack is rendered with its name and context estimate",
  personal.includes("{skills.map(pack => (") &&
  personal.includes("~{pack.ctx} ctx"));
check("An empty library still says why, instead of rendering nothing",
  personal.includes("No skill packs installed yet. Install them from Studio → Skills."));

if (failed) {
  console.error(`agentsNewPageIntent: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("agentsNewPageIntent: all checks passed");
