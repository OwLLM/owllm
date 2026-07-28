#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, "CodePage.tsx"), "utf8");
const mem = fs.readFileSync(path.join(HERE, "localTools.ts"), "utf8");
const modal = fs.readFileSync(path.join(HERE, "TeamMemoryModal.tsx"), "utf8");
const vaultSync = fs.readFileSync(path.resolve(HERE, "../../runtime/vaultSync.ts"), "utf8");

let failed = 0;
function check(name, ok) {
  if (!ok) {
    failed++;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`PASS ${name}`);
  }
}

check(
  "Code page pins the shared team-memory scope before RAG reads/tools",
  /resolveMemoryScope\(\)[\s\S]*setTeamMemoryScope\(scope\)[\s\S]*setTeamMemoryGoal\(user\)[\s\S]*refreshTeamMemorySnapshot\(\)[\s\S]*retrieveScopedTeamMemoryPack\(scope, user/.test(src),
);
check(
  "Code page resolves folders to the durable agent project id before memory use",
  src.includes('invoke<ProjectScopeRow>("resolve_project_for_location"')
    && /const memoryScope = \(\) => ruleScopeRef\.current\.id \|\| \(\(projectRoot \|\| workspace\) \? fallbackProjectScope\(projectRoot \|\| workspace\) : ""\)/.test(src)
    && /const scope = await resolveMemoryScope\(\);[\s\S]*await harvestMemoryWrites\(result\)/.test(src),
);
check(
  "Code page persists replies through the same durable-memory harvester agents use",
  /harvestMemoryWrites\(result\)[\s\S]*logScopedTeamWork\(scope, agent, instruction, stripMemoryDirectives\(result\)\)/.test(src),
);
check(
  "Primary, secondary, chat, and planned Code turns write shared work-state",
  /logCodeWork\("code", text \|\| "\([^"]*attached (?:image|file)[^"]*\)", reply\)/.test(src)
    && /logCodeWork\("code_second", text, replyText\)/.test(src)
    && /logCodeWork\("code_chat", text \|\| "\([^"]*attached image[^"]*\)", reply, chatScope\)/.test(src)
    && /logCodeWork\("code", plan\[i\]\.title, stepReply\)/.test(src),
);
check(
  "Folderless chats get their own durable memory scope instead of the silent no-op",
  // resolveMemoryScope() returns "" with no folder, which made every enrich/log
  // call on the just-chat surface do nothing. Each thread now owns a chat: scope
  // in the SAME team_memory store — reused, not reimplemented.
  /function chatMemoryScope\([\s\S]*return id \? `chat:\$\{id\}` : "";/.test(src)
    && /const chatScope = chatMemoryScope\(tid\);/.test(src)
    && /enrichCodePromptWithMemory\(appendDocumentAttachmentText\(text, attachments\), chatScope\)/.test(src)
    // The scope is PINNED before the await, never re-resolved after it, so a
    // reply landing after the user navigated away still writes to its own chat.
    && /enrichCodePromptWithMemory = async \(user: string, scopeOverride\?: string\)[\s\S]*const scope = scopeOverride \?\? await resolveMemoryScope\(\)/.test(src)
    && /logCodeWork = async \(agent: string, instruction: string, result: string, scopeOverride\?: string\)[\s\S]*const scope = scopeOverride \?\? await resolveMemoryScope\(\)/.test(src),
);
check(
  "A chat's memory is reachable and is removed with the chat",
  src.includes('data-ui="ChatThreadMemory"')
    // Same shared viewer the project memory uses, opened on the thread's scope.
    && /openChatMemory[\s\S]*chatMemoryScope\(chatId\)[\s\S]*CustomEvent\("owllm:open-code-memory", \{ detail: \{ projectId: scope \} \}\)/.test(src)
    // Deleting a thread must not strand rows nothing can ever address again.
    && /const deleteThread[\s\S]*void purgeChatMemory\(id\)/.test(src)
    && /purgeChatMemory[\s\S]*"team_memory_search"[\s\S]*"team_memory_delete"/.test(src),
);
check(
  "The Coding hub surfaces the everyday chat and its threads as one reused store",
  src.includes('data-ui="NormalChatCard"')
    && src.includes('data-ui="RecentChatList"')
    // The hub list is a second VIEW of the persisted thread list, not a copy.
    && /data-ui="RecentChatList"[\s\S]*chats\.map\(\(c\) => \([\s\S]*openThread\(c\.id\)/.test(src)
    // "New conversation" must open an empty thread, not resume the last one.
    && /const startNewChat = \(\) => \{ newChat\(\); setChatMode\(true\); \};/.test(src)
    && /onClick=\{startNewChat\}/.test(src),
);
check(
  "Memory tools and Code page both hit team_memory_search, not a page-local store",
  /case "memory_search"[\s\S]*team_memory_search/.test(mem)
    && /retrieveScopedTeamMemoryPack[\s\S]*team_memory_search/.test(mem),
);
check(
  "Ordinary run summaries stay in the bounded worklog instead of polluting durable RAG facts",
  !mem.includes("autoCurateScopedTeamFact")
    && !mem.includes('tags: "auto-curated,implementation"')
    && /logScopedTeamWork[\s\S]*team_memory_log/.test(mem),
);
check(
  "Coding resolves the durable project id before opening Project Memory",
  src.includes('data-ui="CodeProjectMemory"')
    && /openProjectMemory[\s\S]*await resolveMemoryScope\(\)[\s\S]*CustomEvent\("owllm:open-code-memory",[\s\S]*detail: \{ projectId: scope \}/.test(src)
    && /<TeamMemoryModal[\s\S]*projectId=\{ruleScope\.id \|\| null\}/.test(src)
    && !src.includes("projectId={ruleScope.id || projectRoot || workspace || null}"),
);
check(
  "Shared memory modal pins the opener's project id and clears stale filters",
  /const requested = typeof detail\?\.projectId === "string"/.test(modal)
    && modal.includes("setOpenedScope(requested || propScopeRef.current)")
    && modal.includes('setQuery("")')
    && modal.includes("setTagFilter(null)"),
);
check(
  "Fact writes trigger project-vault sync with a periodic SQLite backstop",
  mem.includes('CustomEvent("owllm:memory:changed")')
    && vaultSync.includes('addEventListener("owllm:memory:changed"')
    && vaultSync.includes("60_000"),
);

// ---- Everyday-chat layout ------------------------------------------------
// The thread list used to live in a "🕘 History" popover, so the one control
// you need to move between conversations disappeared the moment you opened
// one. It is an ambient LEFT sidebar now, like ChatGPT/Claude: always visible,
// date-grouped, active row marked. These pin the shape, not the styling.
check(
  "Everyday chat keeps its thread list ambient instead of behind a popover",
  !src.includes("🕘 History")
    && !src.includes("setShowHistory")
    && src.includes("<aside")
    && src.includes("＋ New conversation"),
);
check(
  "Sidebar renders BEFORE the conversation column, so the list is on the left",
  src.indexOf("<aside") > 0 && src.indexOf("<aside") < src.indexOf('data-ui="ChatThreadMemory"'),
);
check(
  "Threads are date-grouped from the SAME store, not a second copy",
  /function groupChatsByDate/.test(src)
    && src.includes("groupChatsByDate(chats)")
    && /Today[\s\S]{0,200}Yesterday[\s\S]{0,200}Previous 7 days/.test(src)
    && src.includes('const CHATS_KEY = "owllm:code:chats"'),
);
check(
  "Transcript and composer share one bounded reading column",
  /const CHAT_COLUMN_MAX = \d+/.test(src)
    && (src.match(/maxWidth: CHAT_COLUMN_MAX/g) || []).length >= 2,
);
check(
  "An empty conversation greets and offers starters rather than explaining itself",
  src.includes("What can I help with?")
    && /const CHAT_STARTERS = \[/.test(src)
    && src.includes("CHAT_STARTERS.map"),
);

if (failed) process.exit(1);
