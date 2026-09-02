#!/usr/bin/env node
// Guards the Accounts page's two route pages — Subscription and API key —
// and the rule that decides which one opens.
//
// The reported problem: every provider card stacked BOTH routes, so a user
// who signs in with the Claude/Codex CLI reads a "Set key" row they will
// never use, and a user who pastes API keys reads a wall of CLI logins. The
// page now shows one route kind at a time and opens on the one the user
// actually works in.
//
// Invariants:
//   1. the choice is inferred from real connection state, and an explicit
//      tab click outranks the inference and survives a relaunch;
//   2. onboarding intent ("add the API key you already use") beats the
//      connection counts, since nothing is connected yet at that moment;
//   3. the grid renders ONE route kind — a card can no longer stack both;
//   4. the first paint already uses the persisted accounts snapshot, so the
//      page cannot open on the wrong tab and jump a frame later;
//   5. no provider disappears: one that exists on only one page is named on
//      the other, and every route still gets its accounts_status wiring.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => {
  try {
    return fs.readFileSync(path.join(HERE, file), "utf8").replace(/\r\n/g, "\n");
  } catch {
    return "";
  }
};

let failed = 0;
let passed = 0;
function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

const page = read("AccountsPage.tsx");

// ---- behaviour, by executing the shipped module --------------------------
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-account-route-tab-"));
const load = async (name) => {
  const source = read(`${name}.ts`);
  if (!source) return {};
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const file = path.join(temp, `${name}.mjs`);
  fs.writeFileSync(file, compiled);
  return import(pathToFileURL(file).href);
};

const { pickAccountRouteTab, isAccountRouteTab, ACCOUNT_ROUTE_TAB_KEY } = await load("accountRouteTab");

if (typeof pickAccountRouteTab !== "function") {
  check("accountRouteTab exports pickAccountRouteTab", false);
} else {
  const none = { subscriptions: 0, apiKeys: 0 };
  check("a CLI-subscription user opens on the Subscription page",
    pickAccountRouteTab({ usage: { subscriptions: 2, apiKeys: 0 } }) === "subscription");
  check("an API-key user opens on the API page — the reported mismatch",
    pickAccountRouteTab({ usage: { subscriptions: 0, apiKeys: 3 } }) === "api");
  check("more keys than subscriptions still opens on the API page",
    pickAccountRouteTab({ usage: { subscriptions: 1, apiKeys: 4 } }) === "api");
  check("a tie keeps the route that costs nothing to complete",
    pickAccountRouteTab({ usage: { subscriptions: 2, apiKeys: 2 } }) === "subscription");
  check("a machine with nothing connected opens on Subscription",
    pickAccountRouteTab({ usage: none }) === "subscription");
  check("an explicit tab click outranks what is connected",
    pickAccountRouteTab({ stored: "api", usage: { subscriptions: 5, apiKeys: 0 } }) === "api"
      && pickAccountRouteTab({ stored: "subscription", usage: { subscriptions: 0, apiKeys: 5 } }) === "subscription");
  check("a corrupt stored value falls back to the inference, never to a blank page",
    pickAccountRouteTab({ stored: "nonsense", usage: { subscriptions: 0, apiKeys: 1 } }) === "api"
      && pickAccountRouteTab({ stored: null, usage: none }) === "subscription");
  check("onboarding's API intent wins while nothing is connected yet",
    pickAccountRouteTab({ onboarding: "api", usage: none }) === "api");
  check("onboarding a named provider opens its Subscription page",
    pickAccountRouteTab({ onboarding: "anthropic", usage: { subscriptions: 0, apiKeys: 2 } }) === "subscription");
  check("the user's own choice still beats onboarding intent",
    pickAccountRouteTab({ stored: "subscription", onboarding: "api", usage: none }) === "subscription");
  check("only the two real tabs are accepted",
    isAccountRouteTab("subscription") && isAccountRouteTab("api")
      && !isAccountRouteTab("") && !isAccountRouteTab("API") && !isAccountRouteTab(undefined));
  check("the pinned choice has a stable persistence key",
    ACCOUNT_ROUTE_TAB_KEY === "owllm:accounts:route-tab");
}

// ---- wiring: the page really renders two pages ---------------------------
check("the page imports the decision instead of guessing locally",
  page.includes('from "./accountRouteTab"') && page.includes("pickAccountRouteTab({"));
check("the opening tab is decided from connection state, not hardcoded",
  /useState<AccountRouteTab>\(\(\) => pickAccountRouteTab\(\{/.test(page)
    && page.includes("usage: countRouteUsage(cards)"));
check("the first paint uses the persisted accounts snapshot (no tab flash)",
  /const cached = getCachedAccounts\(\);\s*\n\s*return cached \? reconcileCards\(blank, cached\) : blank;/.test(page));
check("a tab click pins the choice across launches",
  page.includes("routeTabPinned.current = true;")
    && page.includes("localStorage.setItem(ACCOUNT_ROUTE_TAB_KEY, tab)"));
check("a pinned choice is never overwritten by a later status poll",
  /if \(routeTabPinned\.current \|\| routeTabSettled\.current\) return;/.test(page));
check("the inference stops moving once something is connected",
  page.includes("if (usage.subscriptions + usage.apiKeys > 0) routeTabSettled.current = true;"));
check("the grid renders one route kind at a time",
  page.includes("const routes = provider.routes.filter((route) => route.kind === kind);")
    && !page.includes("{provider.routes.map(")
    && page.includes("kind={routeTab}"));
check("only providers that support the open route are listed",
  page.includes("const visibleProviders = PROVIDERS.filter((provider) =>")
    && page.includes("provider.routes.some((route) => route.kind === routeTab)"));
check("both tabs exist and are labelled with their own connected count",
  page.includes('data-ui="AccountRouteTabs"')
    && /label=\{`Subscription\$\{routeUsage\.subscriptions/.test(page)
    && /label=\{`API key\$\{routeUsage\.apiKeys/.test(page));
check("a provider that lives on only one page is named on the other",
  page.includes("function providersMissingFrom(")
    && page.includes('data-ui="AccountRouteElsewhere"')
    && page.includes("const elsewhereOnly = providersMissingFrom(routeTab);"));
check("the onboarding hint re-scrolls after a tab switch",
  /\}, \[onboardingProvider, routeTab\]\);/.test(page));
check("the onboarding hint describes the page the user is on, not the one they came for",
  page.includes('{routeTab === "api"\n                ? "You are on the API key page')
    && page.includes("This is the Subscription page — switch to the API key tab"));

// ---- no provider and no route is lost by the split -----------------------
const catalogue = page.slice(page.indexOf("const PROVIDERS: ProviderSpec[]"), page.indexOf("// CardState — per route"));
const routes = [...catalogue.matchAll(/\{ key: "([a-z_]+)",\s+kind: "(subscription|api)".*/g)]
  .map((m) => ({ key: m[1], kind: m[2], webOnly: m[0].includes("webOnly:") }));
check("the provider catalogue still parses (both route kinds present)",
  routes.length >= 15
    && routes.some((r) => r.kind === "subscription")
    && routes.some((r) => r.kind === "api"));
const reconcile = page.slice(page.indexOf("function reconcileCards("), page.indexOf("function countRouteUsage("));
for (const route of routes) {
  // A web-only route (chat.deepseek.com) has no CLI and no key, so
  // accounts_status has nothing to report for it — it never had a flag.
  if (route.webOnly) continue;
  check(`${route.key} keeps its accounts_status wiring after the split`,
    reconcile.includes(`flag("${route.key}"`));
}
check("card reconciliation is a pure function the first render can call",
  /^function reconcileCards\(\s*\n\s*prev: Record<string, CardState>,\s*\n\s*status: AccountsStatus,\s*\n\): Record<string, CardState> \{/m.test(page)
    && page.includes("setCards((prev) => reconcileCards(prev, status));"));

fs.rmSync(temp, { recursive: true, force: true });

console.log(`\naccountRouteTabs: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
