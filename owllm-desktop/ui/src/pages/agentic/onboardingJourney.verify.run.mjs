// Focused contract for the startup onboarding journey. The flow must reuse
// OwLLM's existing GitHub/device-flow and provider account surfaces instead of
// introducing another credential store.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

const onboarding = read("../core/AccountSyncModal.tsx");
const accounts = read("../advanced/AccountsPage.tsx");
const modules = read("../modules/ModuleWizard.tsx");
const shell = read("../../AppShell.tsx");

check(onboarding.includes('ONBOARDING_COMPLETE_KEY = "owllm:onboarding:v2:complete"'),
  "the guided journey has a dedicated persisted completion gate");
check(onboarding.includes("if (firstRun)") && onboarding.includes('setStage("identity")') && onboarding.includes("setOpen(true)"),
  "a fresh install opens at the identity step");
check(onboarding.includes("githubDeviceStart()") && onboarding.includes("githubDevicePoll(d.deviceCode)"),
  "GitHub sign-in reuses the existing secure device flow");
check(onboarding.includes('GITHUB_SIGNUP_URL = "https://github.com/signup"') && onboarding.includes("Create a GitHub account"),
  "people without GitHub get an explicit sign-up path");
check(onboarding.includes("Continue without GitHub — keep everything on this device"),
  "GitHub identity remains optional for local-only users");
check(onboarding.includes("ChatGPT Plus / Pro") && onboarding.includes("Claude Pro / Max")
  && onboarding.includes("Google AI Pro / Ultra") && onboarding.includes("Kimi")
  && onboarding.includes("SuperGrok / X Premium+"),
  "subscription choices are described using plans people recognize");
check(onboarding.includes('data-ui="OnboardingAccountLoginPanel"') &&
      onboarding.includes('data-ui="OnboardingInlineSubscriptionChoices"') &&
      onboarding.includes("OwLLM opens the existing Accounts page with that provider highlighted"),
  "AI account login choices are prominent on the first onboarding screen");
check(onboarding.includes("I have API keys") && onboarding.includes("I want local models"),
  "API-billed and local-only access paths are first-class choices");
check(onboarding.includes('sessionStorage.setItem(ACCOUNT_ONBOARDING_KEY, provider)')
  && onboarding.includes('detail: { key: "accounts" }'),
  "cloud choices hand off to the existing Accounts page with provider context");
check(onboarding.includes('detail: { key: "models" }'),
  "local-model choice hands off to the existing Models page");
check(onboarding.includes('new CustomEvent("owllm:skip-module-wizard")')
  && modules.includes('window.addEventListener("owllm:skip-module-wizard"'),
  "cloud setup dismisses the overlapping local-runtime prompt");
check(onboarding.includes("const finishLater")
  && onboarding.slice(onboarding.indexOf("const finishLater"), onboarding.indexOf("const openAccountSetup")).includes('new CustomEvent("owllm:skip-module-wizard")'),
  "Set up later does not reveal a second first-run prompt underneath");
check(accounts.includes('data-ui="AccountOnboardingHint"')
  && accounts.includes("data-onboarding-highlighted"),
  "Accounts explains the selected route and highlights the matching provider");
check(accounts.includes('saved === "api" || PROVIDERS.some((provider) => provider.key === saved)'),
  "Accounts rejects unknown provider focus values before using them in a selector");
check(shell.includes('data-ui="SettingsAccountRow"') && shell.includes("Finish onboarding")
  && shell.includes("GitHub sign-in and AI subscription setup"),
  "Settings links signed-out users back to the same complete journey");

console.log(`OK onboarding journey: ${passed}/${passed} checks passed`);
